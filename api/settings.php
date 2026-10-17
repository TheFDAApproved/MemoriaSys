<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logger.php';
require_once 'imagemanager.php';
require_once 'checkuser.php';
require_once 'textbee.php';

$userData = checkuser(false);
$method = $_SERVER['REQUEST_METHOD'] ?? null;

// --- REST-ish ROUTING: PARSE THE URI ---
$pathInfo = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

// Handle Unauthenticated GET Requests First
if (!$userData || in_array($userData['role'] ?? "", [ROLE_GROUNDS])) {
    try {
        if ($method === 'GET') {
            if ($resourceId) {
                $stmt = $pdo->prepare("
                    SELECT setting_id, setting_key, setting_value, description FROM settings 
                    WHERE setting_id = :id 
                      AND deleted_at IS NULL 
                      AND description NOT LIKE '%sensitive%'
                ");
                $stmt->execute([':id' => $resourceId]);
                $setting = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$setting) Response::error("Public Setting not found", 404);
                Response::success("Public System setting retrieved", $setting);
            } else {
                $stmt = $pdo->prepare("
                    SELECT setting_id, setting_key, setting_value, description FROM settings 
                    WHERE deleted_at IS NULL 
                      AND description NOT LIKE '%sensitive%'
                ");
                $stmt->execute();
                $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);
                Response::success("Public System settings retrieved", $settings);
            }
        }
    } catch (PDOException $e) {
        systemLog("Database Error: " . $e->getMessage(), "Unauthenticated");
        Response::error("Internal server error.", 500);
    }
    Response::error("Unauthorized access", 401);
}

// Strict Gatekeeper
$canModify = in_array($userData['role'], [ROLE_ADMIN, ROLE_OFFICE]);
if (!$canModify) {
    Response::error("Forbidden to access this resource", 403);
}

$manager = new ImageManager();

// Parse Input Data
$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

try {

    switch ($method) {

        case 'GET':
            if ($resourceId) {
                // Get single setting (only if not deleted)
                $stmt = $pdo->prepare("
            SELECT * FROM settings 
            WHERE setting_id = :id AND deleted_at IS NULL
        ");
                $stmt->execute([':id' => $resourceId]);
                $setting = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$setting) {
                    Response::error("Setting not found", 404);
                }

                // Decrypt specific sensitive value (only for admins)
                if (stripos((string)($setting['description'] ?? ''), 'sensitive') !== false) {
                    if ($userData['role'] !== ROLE_ADMIN) {
                        Response::error("Forbidden to access this resource", 403);
                    }
                    $setting['setting_value'] = decryptCredential($setting['setting_value']);
                }
                Response::success("System setting retrieved", $setting);
            } else {
                // Get all settings (only active ones)
                $stmt = $pdo->prepare("SELECT * FROM settings WHERE deleted_at IS NULL");
                $stmt->execute();
                $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // Process sensitive values
                foreach ($settings as &$setting) {
                    if (stripos((string)($setting['description'] ?? ''), 'sensitive') !== false) {
                        if ($userData['role'] !== ROLE_ADMIN) {
                            $setting = null; // mark for removal
                        } else {
                            $setting['setting_value'] = decryptCredential($setting['setting_value']);
                        }
                    }
                }
                unset($setting);

                $settings = array_values(array_filter($settings, fn($s) => $s !== null));
                Response::success("System settings retrieved", $settings);
            }
            break;

        case 'PUT':
        case 'PATCH':
        case 'POST':

            if (!isset($rawData['bulk_settings'])) {
                $setkey = $rawData['setting_key'] ?? '';
                $setdesc = $rawData['description'] ?? '';
                $setval = $rawData['setting_value'] ?? '';

                if (empty(trim($setkey)) || empty(trim($setdesc)) || empty(trim($setval))) {
                    Response::error("setting_key, setting_value, description are required.", 400);
                }
                $rawData['bulk_settings'] = [[
                    'setting_key' => $setkey,
                    'description' => $setdesc,
                    'setting_value' => $setval
                ]];
            }

            $pdo->beginTransaction();
            $uploadedFiles = [];

            // Collected during the bulk loop, saved as a pair AFTER commit
            // via saveTextBeeCredentials(). Null means "not submitted".
            $textbeeApiKey   = null;
            $textbeeDeviceId = null;
            $bulkSucceeded   = false;
            $changes         = "";

            if (isset($rawData['bulk_settings']) && is_array($rawData['bulk_settings'])) {

                try {
                    // Per-key target dimensions for uploaded images.
                    // Anything not listed here is saved at its original size.
                    $imageDimensions = [
                        'header' => ['width' => 1276, 'height' => 152],
                        'footer' => ['width' => 1276, 'height' => 152],
                    ];
                    foreach ($rawData['bulk_settings'] as $index => $setting) {
                        $sKey = trim($setting['setting_key'] ?? '');
                        $sDesc = trim($setting['description'] ?? '');
                        $sValue = trim($setting['setting_value'] ?? '');
                        $hasImage = isset($_FILES['bulk_images']['name'][$index]) && $_FILES['bulk_images']['error'][$index] === UPLOAD_ERR_OK;

                        if (empty($sKey) || empty($sDesc)) {
                            throw new Exception("Setting key and description are strictly required for all entries.");
                        }

                        // ----------------------------------------------------------
                        // TextBee credentials are saved as a PAIR, after this
                        // transaction commits, via saveTextBeeCredentials().
                        //
                        // Why: the pair (api_key + device_id) must land together
                        // or not at all. saveTextBeeCredentials() wraps both
                        // upserts in its own transaction. Doing that inside our
                        // own open transaction would nest, which PDO doesn't
                        // support. So we capture the plain values here, skip
                        // the normal upsert for these keys, and call the
                        // helper after we commit.
                        //
                        // The helper also hardcodes the description, so we
                        // don't need the submitted description for these keys.
                        // ----------------------------------------------------------
                        if ($sKey === 'textbee_api_key') {
                            $textbeeApiKey = $sValue;
                            continue;
                        }
                        if ($sKey === 'textbee_device_id') {
                            $textbeeDeviceId = $sValue;
                            continue;
                        }

                        if ($hasImage) {
                            $tmpName = $_FILES['bulk_images']['tmp_name'][$index];

                            // STRICT PNG VALIDATION
                            $finfo = finfo_open(FILEINFO_MIME_TYPE);
                            $mime  = finfo_file($finfo, $tmpName);
                            finfo_close($finfo);

                            if ($mime !== 'image/png') {
                                throw new Exception("Upload failed: Only PNG images are allowed for '{$sKey}'.");
                            }

                            // Force the filename to be the setting_key.
                            $requestedName = $sKey;

                            // Look up the target size for this key (null = no resize)
                            $dims = $imageDimensions[$sKey] ?? null;

                            $result = $manager->uploadImage(
                                $tmpName,
                                $_FILES['bulk_images']['name'][$index],
                                $requestedName,
                                true,
                                $dims
                            );

                            if (!$result['success']) {
                                throw new Exception("Image upload failed for {$sKey}: " . $result['error']);
                            }

                            // Defense in depth: settings only supports PNG.
                            if (strtolower(pathinfo($result['filename'], PATHINFO_EXTENSION)) !== 'png') {
                                $uploadedFiles[] = $result['filename']; // let cleanup remove it
                                throw new Exception("Upload failed: Only PNG images are allowed for '{$sKey}'.");
                            }

                            $sValue = $result['filename'];
                            $uploadedFiles[] = $sValue;
                        }

                        // Encrypt before saving if description flags it as sensitive
                        if (stripos($sDesc, 'sensitive') !== false) {
                            $sValue = encryptCredential($sValue);
                        }

                        // ================================================================
                        // UPDATED QUERY: now includes audit columns and restores soft-deleted
                        // ================================================================
                        $sql = "
                            INSERT INTO settings 
                                (setting_key, setting_value, description, created_at, updated_at, created_by, updated_by, deleted_at)
                            VALUES 
                                (:key, :value, :desc, NOW(), NOW(), :created_by, :updated_by, NULL)
                            ON DUPLICATE KEY UPDATE
                                setting_value = VALUES(setting_value),
                                description   = VALUES(description),
                                updated_at    = NOW(),
                                updated_by    = VALUES(updated_by),
                                deleted_at    = NULL
                        ";

                        $stmt = $pdo->prepare($sql);
                        $stmt->execute([
                            ':key'        => $sKey,
                            ':value'      => $sValue,
                            ':desc'       => $sDesc,
                            ':created_by' => $userData['user_id'],
                            ':updated_by' => $userData['user_id']
                        ]);

                        $changes .= 'setting_key: ' . $sKey . ', description: ' . $sDesc . ', value: ' . $sValue . '  ';
                    }

                    $pdo->commit();
                    $bulkSucceeded = true;

                    // Fires as soon as the settings save succeeds, regardless
                    // of what happens with TextBee below. Keeps the settings
                    // audit trail deterministic: one entry per successful save,
                    // every time — no dependency on the TextBee outcome.
                    systemLog(
                        "{$userData['name']} ({$userData['username']}) saved settings. " . $changes,
                        $userData['user_id']
                    );
                } catch (Exception $e) {
                    if ($pdo->inTransaction()) $pdo->rollBack();

                    foreach ($uploadedFiles as $file) {
                        $cleanupResult = $manager->deleteImage($file);
                        if (!$cleanupResult['success']) {
                            error_log("Could not clean up setting image {$file}: {$cleanupResult['error']}");
                            systemLog("Could not clean up setting image {$file}: {$cleanupResult['error']}", $userData['user_id']);
                        }
                    }

                    systemLog("Bulk Update Error: " . $e->getMessage(), $userData['user_id']);
                    Response::error($e->getMessage(), 400);
                }

                // ------------------------------------------------------------------
                // TextBee pair (if submitted) — runs AFTER the bulk commit.
                //
                // Placed outside the try/catch above so that:
                //   * A TextBee failure does NOT roll back the already-committed
                //     bulk settings (they're a different logical change).
                //   * A TextBee failure does NOT trigger the uploaded-image
                //     cleanup (those files are already referenced by the
                //     committed settings and must not be deleted).
                // ------------------------------------------------------------------
                if ($bulkSucceeded && ($textbeeApiKey !== null || $textbeeDeviceId !== null)) {

                    // saveTextBeeCredentials needs BOTH values. If only one
                    // was submitted, pull the current value of the other
                    // from the DB so the pair stays consistent.
                    if ($textbeeApiKey === null || $textbeeDeviceId === null) {
                        $fetch = $pdo->prepare("
                            SELECT setting_key, setting_value
                            FROM settings
                            WHERE setting_key IN ('textbee_api_key', 'textbee_device_id')
                              AND deleted_at IS NULL
                        ");
                        $fetch->execute();
                        foreach ($fetch->fetchAll(PDO::FETCH_ASSOC) as $row) {
                            $plain = decryptCredential($row['setting_value']);
                            if ($row['setting_key'] === 'textbee_api_key' && $textbeeApiKey === null) {
                                $textbeeApiKey = $plain;
                            } elseif ($row['setting_key'] === 'textbee_device_id' && $textbeeDeviceId === null) {
                                $textbeeDeviceId = $plain;
                            }
                        }
                    }

                    if ($textbeeApiKey === null || $textbeeDeviceId === null) {
                        systemLog(
                            "TextBee save skipped: incomplete pair (settings saved, TextBee not touched).",
                            $userData['user_id']
                        );
                        Response::error(
                            "Settings saved. Except: TextBee was not updated because it needs both an API Key and a Device ID — the missing half wasn't found in the database.",
                            400
                        );
                    }

                    $tb = saveTextBeeCredentials($textbeeApiKey, $textbeeDeviceId, $userData['user_id']);
                    if (!$tb['success']) {
                        systemLog(
                            "TextBee save failed after settings update: " . ($tb['error'] ?? 'unknown error'),
                            $userData['user_id']
                        );
                        Response::error(
                            "Settings saved, but TextBee credentials failed: " . ($tb['error'] ?? 'unknown error'),
                            500
                        );
                    }

                    $changes .= 'TextBee credentials updated (api_key + device_id). ';
                }

                Response::success("Settings saved successfully. [Changes] " . $changes);
            } else Response::error("setting_key, setting_value, description are required.", 400);

            break;

        case 'DELETE':
            $settingId = $resourceId ?? $rawData['setting_id'] ?? null;

            if (!$settingId) {
                Response::error("Setting ID is required for deletion.", 400);
            }

            // Soft delete: set deleted_at and updated_by
            $sql = "
                UPDATE settings 
                SET deleted_at = NOW(), updated_by = :updated_by 
                WHERE setting_id = :id AND deleted_at IS NULL
            ";
            $stmt = $pdo->prepare($sql);
            $stmt->execute([
                ':id' => $settingId,
                ':updated_by' => $userData['user_id']
            ]);

            if ($stmt->rowCount() === 0) {
                Response::error("Setting not found or already deleted", 404);
            }

            systemLog("{$userData['name']} soft-deleted setting ID: {$settingId}", $userData['user_id']);
            Response::success("Setting deleted successfully");
            break;

        default:
            Response::error("Method not allowed", 405);
            break;
    }
} catch (PDOException $e) {
    systemLog("Database Error: " . $e->getMessage(), $userData['user_id'] ?? 'Unknown');
    Response::error("An internal server error occurred. " . $e->getMessage(), 500);
}
