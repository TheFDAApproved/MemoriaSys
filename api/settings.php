<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logger.php';
require_once 'imagemanager.php';
require_once 'checkuser.php';
require_once 'textbee.php';

// Settings endpoint for admin and office (public and grounds can only read)
// Office writes are restricted to OFFICE_WRITABLE_SETTING_KEYS
// Image keys must be .png, JSON list keys must be valid JSON

// Keys office can create, update, or delete, everything else stays admin-only
const OFFICE_WRITABLE_SETTING_KEYS = [
    'logo_1',
    'logo_2',
    'cemetery_logo',
    'cemetery_mark',
    'cemetery_background',
    'qr_code',
    'dept_name',
    'cemetery_name',
    'cemetery_address',
    'office_address',
    'cemetery_google_maps',
    'contact_phone',
    'contact_email',
    'payment_channels_list',
    'payment_purposes_list',
];

// Image keys: value must be a .png filename, uploads only accepted for these
// header and footer are admin-only but still validated here
const IMAGE_SETTING_KEYS = [
    'logo_1',
    'logo_2',
    'cemetery_logo',
    'cemetery_mark',
    'cemetery_background',
    'qr_code',
    'header',
    'footer',
];

// JSON list keys: value must be valid JSON
const JSON_LIST_SETTING_KEYS = [
    'payment_channels_list',
    'payment_purposes_list',
];

$userData = checkuser(false);
$method = $_SERVER['REQUEST_METHOD'] ?? null;

$pathInfo = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$isPublic  = !$userData;
$isGrounds = !$isPublic && ($userData['role'] ?? null) === ROLE_GROUNDS;
$isOffice  = !$isPublic && ($userData['role'] ?? null) === ROLE_OFFICE;
$isAdmin   = !$isPublic && ($userData['role'] ?? null) === ROLE_ADMIN;

// Unknown role, deny outright
if (!$isPublic && !$isGrounds && !$isOffice && !$isAdmin) {
    Response::error("Forbidden to access this resource", 403);
}

// Public and grounds can only read; office and admin can write
if ($isPublic || $isGrounds) {
    $allowedMethods = ['GET'];
} elseif ($isOffice) {
    // Office can attempt writes; the per-key allowlist is enforced below
    $allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
} else { // admin
    $allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
}

if (!in_array($method, $allowedMethods, true)) {
    Response::error(
        $isPublic
            ? "Unauthorized access"
            : "Forbidden: method '{$method}' is not allowed for your role",
        $isPublic ? 401 : 403
    );
}

// Public tier: GET only, non-sensitive settings
// Admin skips this block and uses the full view below
if ($method === 'GET' && !$isAdmin) {
    try {
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
    } catch (PDOException $e) {
        systemLog("Database Error: " . $e->getMessage(), $userData['user_id'] ?? 'Unauthenticated');
        Response::error("Internal server error.", 500);
    }
    Response::error("Unauthorized access", 401);
}

$manager = new ImageManager();

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

try {

    switch ($method) {

        case 'GET':
            // Full view for admin; public, grounds, and office were served above
            if ($resourceId) {
                $stmt = $pdo->prepare("
                    SELECT * FROM settings 
                    WHERE setting_id = :id AND deleted_at IS NULL
                ");
                $stmt->execute([':id' => $resourceId]);
                $setting = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$setting) {
                    Response::error("Setting not found", 404);
                }

                // Admin always decrypts sensitive values
                if (stripos((string)($setting['description'] ?? ''), 'sensitive') !== false) {
                    $setting['setting_value'] = decryptCredential($setting['setting_value']);
                }
                Response::success("System setting retrieved", $setting);
            } else {
                $stmt = $pdo->prepare("SELECT * FROM settings WHERE deleted_at IS NULL");
                $stmt->execute();
                $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // Admin always decrypts sensitive values
                foreach ($settings as &$setting) {
                    if (stripos((string)($setting['description'] ?? ''), 'sensitive') !== false) {
                        $setting['setting_value'] = decryptCredential($setting['setting_value']);
                    }
                }
                unset($setting);

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
                // Wrap a single setting into a one-element bulk array so both payload shapes share the same checks below
                $rawData['bulk_settings'] = [[
                    'setting_key' => $setkey,
                    'description' => $setdesc,
                    'setting_value' => $setval
                ]];
            }

            // Office writes are restricted to allowlisted keys
            // A single out-of-scope key rejects the whole batch, so a mixed payload can't sneak through
            if ($isOffice && isset($rawData['bulk_settings']) && is_array($rawData['bulk_settings'])) {
                foreach ($rawData['bulk_settings'] as $setting) {
                    $key = trim($setting['setting_key'] ?? '');
                    if (!in_array($key, OFFICE_WRITABLE_SETTING_KEYS, true)) {
                        Response::error(
                            "Forbidden: office users cannot modify '{$key}'. "
                                . "Allowed keys: " . implode(', ', OFFICE_WRITABLE_SETTING_KEYS),
                            403
                        );
                    }
                }
            }

            $pdo->beginTransaction();
            $uploadedFiles = [];

            // TextBee pair is captured here and saved after commit; null means not submitted
            $textbeeApiKey   = null;
            $textbeeDeviceId = null;
            $bulkSucceeded   = false;
            $changes         = "";

            if (isset($rawData['bulk_settings']) && is_array($rawData['bulk_settings'])) {

                try {
                    // Optional resize per image key; unlisted keys save at original size
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

                        $isImageKey    = in_array($sKey, IMAGE_SETTING_KEYS, true);
                        $isJsonListKey = in_array($sKey, JSON_LIST_SETTING_KEYS, true);

                        // Reject before the upload so no disk I/O is wasted on a doomed request
                        if ($hasImage && !$isImageKey) {
                            throw new Exception(
                                "'{$sKey}' does not accept an image upload. "
                                    . "Image keys are: " . implode(', ', IMAGE_SETTING_KEYS)
                            );
                        }

                        // TextBee pair is captured here and saved after commit (PDO has no nested transactions)
                        // Admin-only; the office allowlist above already rejects them
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

                            // Only PNG is allowed
                            $finfo = finfo_open(FILEINFO_MIME_TYPE);
                            $mime  = finfo_file($finfo, $tmpName);
                            // finfo_close() is deprecated in PHP 8.5+, skipped

                            if ($mime !== 'image/png') {
                                throw new Exception("Upload failed: Only PNG images are allowed for '{$sKey}'.");
                            }

                            // Filename is always the setting_key
                            $requestedName = $sKey;

                            // null means save at original size
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

                            // Redundant check: settings only supports PNG
                            if (strtolower(pathinfo($result['filename'], PATHINFO_EXTENSION)) !== 'png') {
                                $uploadedFiles[] = $result['filename']; // let cleanup remove it
                                throw new Exception("Upload failed: Only PNG images are allowed for '{$sKey}'.");
                            }

                            $sValue = $result['filename'];
                            $uploadedFiles[] = $sValue;
                        }

                        // Image key with no new upload still needs a .png value (the edit-description case)
                        if ($isImageKey && !$hasImage) {
                            if ($sValue === '' || strtolower(pathinfo($sValue, PATHINFO_EXTENSION)) !== 'png') {
                                throw new Exception(
                                    "'{$sKey}' requires a PNG image. Upload a new file or keep the existing .png filename."
                                );
                            }
                        }

                        // JSON list key: value must be valid JSON
                        if ($isJsonListKey && !$hasImage && $sValue !== '') {
                            json_decode($sValue);
                            if (json_last_error() !== JSON_ERROR_NONE) {
                                throw new Exception("'{$sKey}' must be valid JSON.");
                            }
                        }

                        // Encrypt if description says sensitive
                        if (stripos($sDesc, 'sensitive') !== false) {
                            $sValue = encryptCredential($sValue);
                        }

                        // Upsert by key: an active row updates in place, a missing key inserts a new row
                        // Soft-deleted rows stay as history, they aren't revived on re-save
                        $sql = "
                            INSERT INTO settings 
                                (setting_key, setting_value, description, created_at, updated_at, created_by, updated_by)
                            VALUES 
                                (:key, :value, :desc, NOW(), NOW(), :created_by, :updated_by)
                            ON DUPLICATE KEY UPDATE
                                setting_value = VALUES(setting_value),
                                description   = VALUES(description),
                                updated_at    = NOW(),
                                updated_by    = VALUES(updated_by)
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

                    // Log right after commit so the audit trail gets one entry per save, regardless of TextBee below
                    systemLog(
                        "{$userData['name']} ({$userData['username']}) saved settings. " . $changes,
                        $userData['user_id']
                    );
                } catch (Exception $e) {
                    if ($pdo->inTransaction()) $pdo->rollBack();

                    // Only delete files no active setting row references
                    // Protects the old file after a rollback, and another request's committed upload (both target <key>.png)
                    // If the ref check fails, skip the delete; an orphan is harmless, a dangling reference is not
                    foreach ($uploadedFiles as $file) {
                        try {
                            $refCheck = $pdo->prepare("
                                SELECT 1 FROM settings 
                                WHERE setting_value = :v AND deleted_at IS NULL 
                                LIMIT 1
                            ");
                            $refCheck->execute([':v' => $file]);
                            if ($refCheck->fetchColumn()) {
                                systemLog(
                                    "Skipped image cleanup for {$file}: still referenced by an active setting.",
                                    $userData['user_id']
                                );
                                continue;
                            }
                        } catch (PDOException $refErr) {
                            systemLog(
                                "Skipped image cleanup for {$file}: reference check failed ({$refErr->getMessage()})",
                                $userData['user_id']
                            );
                            continue;
                        }

                        $cleanupResult = $manager->deleteImage($file);
                        if (!$cleanupResult['success']) {
                            error_log("Could not clean up setting image {$file}: {$cleanupResult['error']}");
                            systemLog("Could not clean up setting image {$file}: {$cleanupResult['error']}", $userData['user_id']);
                        }
                    }

                    systemLog("Bulk Update Error: " . $e->getMessage(), $userData['user_id']);
                    Response::error($e->getMessage(), 400);
                }

                // TextBee pair runs after commit so a failure here doesn't roll back settings or trigger image cleanup
                // Success and failure are both logged; values are logged as fingerprints (short sha256), never plaintext
                if ($bulkSucceeded && ($textbeeApiKey !== null || $textbeeDeviceId !== null)) {

                    // The helper needs both values; pull the missing half from the DB
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

                    // Log with fingerprints, never the plaintext values
                    $keyFingerprint    = substr(hash('sha256', $textbeeApiKey), 0, 8);
                    $deviceFingerprint = substr(hash('sha256', $textbeeDeviceId), 0, 8);
                    systemLog(
                        "{$userData['name']} ({$userData['username']}) updated TextBee credentials "
                            . "(api_key fingerprint: {$keyFingerprint}…, device_id fingerprint: {$deviceFingerprint}…).",
                        $userData['user_id']
                    );

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

            // Office deletes are restricted to allowlisted keys (checked by setting_key, not ID)
            if ($isOffice) {
                $check = $pdo->prepare("
                    SELECT setting_key FROM settings 
                    WHERE setting_id = :id AND deleted_at IS NULL
                ");
                $check->execute([':id' => $settingId]);
                $row = $check->fetch(PDO::FETCH_ASSOC);

                if (!$row) {
                    Response::error("Setting not found or already deleted", 404);
                }
                if (!in_array($row['setting_key'], OFFICE_WRITABLE_SETTING_KEYS, true)) {
                    Response::error(
                        "Forbidden: office users cannot delete '{$row['setting_key']}'",
                        403
                    );
                }
            }

            // Soft delete
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
