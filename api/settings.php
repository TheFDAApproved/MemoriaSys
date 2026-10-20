<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logger.php';
require_once 'imagemanager.php';
require_once 'checkuser.php';
require_once 'textbee.php';

// ============================================================================
// Office permission allowlist.
// Office users can CREATE / UPDATE / DELETE ONLY these setting keys.
// Everything else (main_color, people_*, textbee_*, header, footer, ...)
// remains admin-only.
// ============================================================================
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

// ============================================================================
// Setting key types.
//
//   IMAGE_SETTING_KEYS     → value must be a .png filename.
//                            Uploads are only accepted for these keys.
//   JSON_LIST_SETTING_KEYS → value must be valid JSON (arrays of strings).
//   Everything else        → free-text string, no special validation.
//
// These apply to every writer (admin + office). A key appearing in both
// OFFICE_WRITABLE_SETTING_KEYS and IMAGE_SETTING_KEYS is writable by office
// AND still gets the .png validation.
// ============================================================================
const IMAGE_SETTING_KEYS = [
    'logo_1',
    'logo_2',
    'cemetery_logo',
    'cemetery_mark',
    'cemetery_background',
    'qr_code',
    'header',   // admin-only write, but still an image
    'footer',   // admin-only write, but still an image
];

const JSON_LIST_SETTING_KEYS = [
    'payment_channels_list',
    'payment_purposes_list',
];

$userData = checkuser(false);
$method = $_SERVER['REQUEST_METHOD'] ?? null;

// --- REST-ish ROUTING: PARSE THE URI ---
$pathInfo = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

// ============================================================================
// ROLE FLAGS
// ============================================================================
$isPublic  = !$userData;
$isGrounds = !$isPublic && ($userData['role'] ?? null) === ROLE_GROUNDS;
$isOffice  = !$isPublic && ($userData['role'] ?? null) === ROLE_OFFICE;
$isAdmin   = !$isPublic && ($userData['role'] ?? null) === ROLE_ADMIN;

// Unknown role → deny outright.
if (!$isPublic && !$isGrounds && !$isOffice && !$isAdmin) {
    Response::error("Forbidden to access this resource", 403);
}

// Allowed HTTP methods per role.
if ($isPublic || $isGrounds) {
    $allowedMethods = ['GET'];
} elseif ($isOffice) {
    // Office may attempt writes — per-key allowlist is enforced further down.
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

// ============================================================================
// PUBLIC-TIER GET (public, grounds, office): non-sensitive only.
// Admin skips this block and uses the full view in the switch below.
// ============================================================================
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

// ============================================================================
// ADMIN (full) or OFFICE (scoped to OFFICE_WRITABLE_SETTING_KEYS) reach the switch.
// ============================================================================
$manager = new ImageManager();

// Parse Input Data
$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

try {

    switch ($method) {

        case 'GET':
            // Admin-only full view (public/grounds/office already served above).
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

                // Admin: always decrypt sensitive values.
                if (stripos((string)($setting['description'] ?? ''), 'sensitive') !== false) {
                    $setting['setting_value'] = decryptCredential($setting['setting_value']);
                }
                Response::success("System setting retrieved", $setting);
            } else {
                $stmt = $pdo->prepare("SELECT * FROM settings WHERE deleted_at IS NULL");
                $stmt->execute();
                $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // Admin: always decrypt sensitive values.
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
                $rawData['bulk_settings'] = [[
                    'setting_key' => $setkey,
                    'description' => $setdesc,
                    'setting_value' => $setval
                ]];
            }

            // ----------------------------------------------------------------
            // OFFICE RESTRICTION: only keys in OFFICE_WRITABLE_SETTING_KEYS.
            // Applied AFTER the single→bulk normalization above, so both
            // payload shapes are covered by the same guard.
            //
            // If any submitted key is out of scope, the WHOLE request is
            // rejected — no partial writes sneak through when an office user
            // tries to mix allowed + forbidden keys in one bulk call.
            // ----------------------------------------------------------------
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

                        $isImageKey    = in_array($sKey, IMAGE_SETTING_KEYS, true);
                        $isJsonListKey = in_array($sKey, JSON_LIST_SETTING_KEYS, true);

                        // ----------------------------------------------------
                        // Reject image uploads for non-image keys.
                        // Runs BEFORE the upload so we don't waste disk I/O
                        // on a request that's going to fail anyway.
                        // ----------------------------------------------------
                        if ($hasImage && !$isImageKey) {
                            throw new Exception(
                                "'{$sKey}' does not accept an image upload. "
                                    . "Image keys are: " . implode(', ', IMAGE_SETTING_KEYS)
                            );
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
                        //
                        // NOTE: These keys are admin-only. The office allowlist
                        // above already rejects them before we get here — this
                        // branch is only reached by admins.
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

                        // ----------------------------------------------------
                        // Image key WITHOUT a new upload: the value must be a
                        // .png filename. Covers the "edit description but
                        // keep the same image" case — the form re-submits
                        // the existing filename, which passes this check.
                        // ----------------------------------------------------
                        if ($isImageKey && !$hasImage) {
                            if ($sValue === '' || strtolower(pathinfo($sValue, PATHINFO_EXTENSION)) !== 'png') {
                                throw new Exception(
                                    "'{$sKey}' requires a PNG image. Upload a new file or keep the existing .png filename."
                                );
                            }
                        }

                        // ----------------------------------------------------
                        // JSON list key: value must be valid JSON.
                        // Only checked when no image was uploaded (these keys
                        // aren't images, and the reject above already caught
                        // the "upload to non-image key" case anyway).
                        // ----------------------------------------------------
                        if ($isJsonListKey && !$hasImage && $sValue !== '') {
                            json_decode($sValue);
                            if (json_last_error() !== JSON_ERROR_NONE) {
                                throw new Exception("'{$sKey}' must be valid JSON.");
                            }
                        }

                        // Encrypt before saving if description flags it as sensitive
                        if (stripos($sDesc, 'sensitive') !== false) {
                            $sValue = encryptCredential($sValue);
                        }

                        // ----------------------------------------------------
                        // Upsert settings by key.
                        //
                        //   ACTIVE row exists  → UNIQUE on active_setting_key
                        //                        fires → update in place.
                        //   NO active row      → a NEW row is inserted. Any
                        //                        soft-deleted row with the
                        //                        same key stays untouched (its
                        //                        active_setting_key is NULL,
                        //                        so it can't block the insert).
                        //
                        // Soft-deleted keys are intentionally NOT revived.
                        // Re-saving a deleted key produces a new row with a
                        // new setting_id; the old soft-deleted row is
                        // preserved as history.
                        // ----------------------------------------------------
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
                //
                // Success and failure are both audit-logged here. Values are
                // never logged in plaintext — only fingerprints (short sha256
                // prefix) so future logs can tell "same key" from "changed key"
                // without exposing the secret.
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

                    // Success — log the fact with key fingerprints (never plaintext).
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

            // Office can delete only allowlisted keys — scoped by setting_key, not ID.
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
