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
if (!$userData) {
    try {
        if ($method === 'GET') {
            if ($resourceId) {
                $stmt = $pdo->prepare("SELECT * FROM settings WHERE description NOT LIKE '%sensitive%'");
                $stmt->execute([':id' => $resourceId]);
                $setting = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$setting) Response::error("Public Setting not found", 404);
                Response::success("Public System setting retrieved", $setting);
            } else {
                $stmt = $pdo->prepare("SELECT * FROM settings WHERE description NOT LIKE '%sensitive%'");
                $stmt->execute();
                $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);
                
                Response::success("Public System settings retrieved", $settings);
            }
        } else {
            Response::error("Unauthorized access", 401);
        }
    } catch (PDOException $e) {
        systemLog("Database Error: " . $e->getMessage(), "Unauthenticated");
        Response::error("Internal server error.", 500);
    }
    exit; // Stop execution for unauthenticated users
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

// Handle method spoofing
if ($method === 'POST' && !empty($rawData['_method'])) {
    $method = strtoupper($rawData['_method']);
}

try {
    
    switch ($method) {

        case 'GET':
            if ($resourceId) {
                // Get single setting
                $stmt = $pdo->prepare("SELECT * FROM settings WHERE setting_id = :id");
                $stmt->execute([':id' => $resourceId]);
                $setting = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$setting) {
                    Response::error("Setting not found", 404);
                }

                // Decrypt specific sensitive value (only for admins)
                if (stripos($setting['description'], 'sensitive') !== false) {
                    if ($userData['role'] !== ROLE_ADMIN) {
                        Response::error("Forbidden to access this resource", 403);
                    }
                    $setting['setting_value'] = decryptCredential($setting['setting_value']);
                }

                systemLog(
                    "{$userData['name']} ({$userData['username']}) retrieved setting ID: {$resourceId}.",
                    $userData['user_id']
                );
                Response::success("System setting retrieved", $setting);

            } else {
                // Get all settings
                $stmt = $pdo->prepare("SELECT * FROM settings");
                $stmt->execute();
                $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // Process sensitive values
                foreach ($settings as &$setting) {
                    if (stripos($setting['description'], 'sensitive') !== false) {
                        if ($userData['role'] !== ROLE_ADMIN) {
                            // Non-admins: remove the entire sensitive setting from the list
                            $setting = null; // mark for removal
                        } else {
                            // Admins: decrypt the value
                            $setting['setting_value'] = decryptCredential($setting['setting_value']);
                        }
                    }
                }
                unset($setting); // break reference

                // Remove null entries (sensitive settings hidden from non-admins)
                $settings = array_values(array_filter($settings, fn($s) => $s !== null));

                systemLog(
                    "{$userData['name']} ({$userData['username']}) retrieved all system settings.",
                    $userData['user_id']
                );
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
            if (isset($rawData['bulk_settings']) && is_array($rawData['bulk_settings'])) {

                try {
                    $changes = "";
                    foreach ($rawData['bulk_settings'] as $index => $setting) {
                        $sKey = trim($setting['setting_key'] ?? '');
                        $sDesc = trim($setting['description'] ?? '');
                        $sValue = trim($setting['setting_value'] ?? '');
                        $hasImage = isset($_FILES['bulk_images']['name'][$index]) && $_FILES['bulk_images']['error'][$index] === UPLOAD_ERR_OK;

                        if (empty($sKey) || empty($sDesc)) {
                            throw new Exception("Setting key and description are strictly required for all entries.");
                        }
                        if (empty($sValue) && !$hasImage) {
                            throw new Exception("Setting value is required for '{$sKey}' if no image is uploaded.");
                        }

                        if ($hasImage) {
                            $tmpName = $_FILES['bulk_images']['tmp_name'][$index];
                            
                            // STRICT PNG VALIDATION
                            $finfo = finfo_open(FILEINFO_MIME_TYPE);
                            $mime = finfo_file($finfo, $tmpName);
                            finfo_close($finfo);

                            if ($mime !== 'image/png') {
                                throw new Exception("Upload failed: Only PNG images are allowed for '{$sKey}'.");
                            }

                            // Force the filename to be the setting_key.
                            // The ImageManager will automatically append the verified '.png' extension.
                            $requestedName = $sKey; 
                            
                            // Always use uploadImage with $replaceIfExists = true
                            // This ensures logo1.png safely overwrites logo1.png using file locking
                            $result = $manager->uploadImage(
                                $tmpName, 
                                $_FILES['bulk_images']['name'][$index], 
                                $requestedName,
                                true 
                            );

                            if (!$result['success']) {
                                throw new Exception("Image upload failed for {$sKey}: " . $result['error']);
                            }
                            
                            // $sValue will now strictly be "logo1.png", "cemetery_full_logo.png", etc.
                            $sValue = $result['filename'];
                            $uploadedFiles[] = $sValue; 
                        }

                        // Encrypt before saving if description flags it as sensitive
                        if (stripos($sDesc, 'sensitive') !== false) {
                            $sValue = encryptCredential($sValue);
                        }

                        $sql = "INSERT INTO settings (setting_key, setting_value, description) 
                                VALUES (:key, :value, :desc)
                                ON DUPLICATE KEY UPDATE 
                                setting_value = VALUES(setting_value), 
                                description = VALUES(description)";
                        
                        $stmt = $pdo->prepare($sql);
                        $stmt->execute([
                            ':key' => $sKey,
                            ':value' => $sValue,
                            ':desc' => $sDesc,
                        ]);
                        $changes .= 'setting_key: ' . $sKey . ', description: ' . $sDesc . ', value: '. $sValue .'  ';
                    }

                    $pdo->commit(); 
                    systemLog("{$userData['name']} ({$userData['username']}) saved a settings. " . $changes, $userData['user_id']);
                    Response::success("Settings saved successfully. [Changes] " . $changes);

                } catch (Exception $e) {
                    $pdo->rollBack(); 
                    
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
            } else Response::error("setting_key, setting_value, description are required.", 400);    
            
            break;

        case 'DELETE':
            $settingId = $resourceId ?? $rawData['setting_id'] ?? null;
            
            if (!$settingId) {
                Response::error("Setting ID is required for deletion.", 400);
            }

            $sql = "DELETE FROM settings WHERE setting_id = :id";
            $stmt = $pdo->prepare($sql);
            $stmt->execute([
                ':id' => $settingId
            ]);

            if ($stmt->rowCount() === 0) {
                Response::error("Setting not found or already deleted", 404);
            }

            systemLog("{$userData['name']} deleted setting ID: {$settingId}", $userData['user_id']);
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
?>