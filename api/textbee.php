<?php

// Ensure database connection is available
require_once 'database.php';
require_once 'notallowed.php';
require_once 'reusable_functions.php';
// This MUST exactly match the key used in your decryption script!
// Use a secure, 32-character string. Store this in a .env file if possible.

/**
 * Encrypts a plain text string before saving to the database.
 */
function encryptCredential($plainText)
{
    // 1. Generate a random Initialization Vector (IV)
    $ivLength = openssl_cipher_iv_length('aes-256-cbc');
    $iv = openssl_random_pseudo_bytes($ivLength);

    // 2. Encrypt the data using AES-256-CBC
    // OPENSSL_RAW_DATA ensures it outputs raw bytes rather than base64
    $encryptedData = openssl_encrypt($plainText, 'aes-256-cbc', ENCRYPTION_KEY, OPENSSL_RAW_DATA, $iv);

    // 3. Combine the IV and encrypted data, then base64 encode for safe database storage
    return base64_encode($iv . $encryptedData);
}

/**
 * Decrypts an encrypted string fetched from the database.
 * (Updated to include OPENSSL_RAW_DATA for perfect compatibility).
 */
function decryptCredential($encryptedString)
{
    $data = base64_decode($encryptedString);
    $ivLength = openssl_cipher_iv_length('aes-256-cbc');

    // Extract the IV and the encrypted data based on the known IV length
    $iv = substr($data, 0, $ivLength);
    $encryptedData = substr($data, $ivLength);

    // Decrypt and return the plain text
    return openssl_decrypt($encryptedData, 'aes-256-cbc', ENCRYPTION_KEY, OPENSSL_RAW_DATA, $iv);
}


/**
 * Sends an SMS message using the TextBee API.
 *
 * @param string $phoneNumber The recipient's phone number (include country code, e.g., +63...)
 * @param string $message The content of the SMS.
 * @return array Returns an associative array with 'success' (boolean) and optional 'error' details.
 */
function sendSmsViaTextBee($phoneNumber, $message, $include_cemetery_name = true)
{
    global $pdo;

    $phoneNumber = formatPhNumber($phoneNumber);
    if (!$phoneNumber) {
        return ['success' => false, 'error' => 'Invalid Philippines phone number'];
    }

    try {
        // 1. Fetch and DECRYPT the TextBee API Key
        $keyStmt = $pdo->prepare("
            SELECT setting_value 
            FROM settings 
            WHERE setting_key = 'textbee_api_key' AND deleted_at IS NULL 
            LIMIT 1
        ");
        $keyStmt->execute();
        $keyResult = $keyStmt->fetch(PDO::FETCH_ASSOC);

        if (!$keyResult || empty($keyResult['setting_value'])) {
            return ['success' => false, 'error' => 'TextBee API key is missing in the database.'];
        }

        // DECRYPT THE API KEY HERE
        $apiKey = decryptCredential($keyResult['setting_value']);

        if (!$apiKey) {
            return ['success' => false, 'error' => 'Failed to decrypt TextBee API key.'];
        }

        // 2. Fetch and DECRYPT the TextBee Device ID
        $deviceStmt = $pdo->prepare("
            SELECT setting_value 
            FROM settings 
            WHERE setting_key = 'textbee_device_id' AND deleted_at IS NULL 
            LIMIT 1
        ");
        $deviceStmt->execute();
        $deviceResult = $deviceStmt->fetch(PDO::FETCH_ASSOC);

        if (!$deviceResult || empty($deviceResult['setting_value'])) {
            return ['success' => false, 'error' => 'TextBee Device ID is missing in the database.'];
        }

        // DECRYPT THE DEVICE ID HERE
        $deviceId = decryptCredential($deviceResult['setting_value']);

        if (!$deviceId) {
            return ['success' => false, 'error' => 'Failed to decrypt TextBee Device ID.'];
        }

        // 3. Prepare the TextBee API endpoint and payload using the DECRYPTED values
        $url = "https://api.textbee.dev/api/v1/gateway/devices/{$deviceId}/sendSMS";

        $cemetery_name = $pdo->query("
            SELECT setting_value 
            FROM settings 
            WHERE setting_key = 'cemetery_name' AND deleted_at IS NULL
        ")->fetch(PDO::FETCH_ASSOC)['setting_value'] ?? false;

        if ($cemetery_name && $include_cemetery_name) {
            $message = $message . "\n\n- From " . $cemetery_name;
        }

        $payload = json_encode([
            "receivers" => [$phoneNumber],
            "smsBody" => $message
        ]);

        // 4. Initialize and execute the cURL request
        $ch = curl_init($url);

        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'x-api-key: ' . $apiKey  // Using the decrypted key
        ]);

        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);

        curl_close($ch);

        // 5. Evaluate the results
        if ($curlError) {
            error_log("TextBee cURL Error: " . $curlError);
            return ['success' => false, 'error' => 'Connection failed: ' . $curlError];
        }

        if ($httpCode >= 200 && $httpCode < 300) {
            return ['success' => true, 'response' => json_decode($response, true)];
        } else {
            error_log("TextBee API Error (Code $httpCode): " . $response);
            return ['success' => false, 'error' => 'API rejected the request. Code: ' . $httpCode];
        }
    } catch (PDOException $e) {
        error_log("Database error in sendSmsViaTextBee: " . $e->getMessage());
        return ['success' => false, 'error' => 'Database failure while fetching credentials.'];
    } catch (Exception $e) {
        error_log("Decryption error in sendSmsViaTextBee: " . $e->getMessage());
        return ['success' => false, 'error' => 'System error processing credentials.'];
    }
}

/**
 * Saves (or updates) TextBee API credentials in the database.
 * Credentials are encrypted before storage.
 * 
 * @param string $plainTextApiKey
 * @param string $plainTextDeviceId
 * @param int|null $userId  Optional ID of the admin performing the save (for audit).
 * @return array
 */
function saveTextBeeCredentials($plainTextApiKey, $plainTextDeviceId, $userId = null)
{
    global $pdo;

    try {
        // 1. Encrypt the plain text values
        $encryptedApiKey = encryptCredential($plainTextApiKey);
        $encryptedDeviceId = encryptCredential($plainTextDeviceId);

        // 2. Prepare the database insert/update statement
        // Using ON DUPLICATE KEY UPDATE to handle existing keys
        $stmt = $pdo->prepare("
            INSERT INTO settings 
            (setting_key, setting_value, description, created_at, updated_at, created_by, updated_by)
            VALUES (:key, :value, :desc, NOW(), NOW(), :created_by, :updated_by)
            ON DUPLICATE KEY UPDATE
                setting_value = VALUES(setting_value),
                updated_at = NOW(),
                updated_by = VALUES(updated_by)
        ");

        // Save the encrypted API Key
        $stmt->execute([
            ':key'        => 'textbee_api_key',
            ':value'      => $encryptedApiKey,
            ':desc'       => 'Encrypted TextBee API Key',
            ':created_by' => $userId,
            ':updated_by' => $userId
        ]);

        // Save the encrypted Device ID
        $stmt->execute([
            ':key'        => 'textbee_device_id',
            ':value'      => $encryptedDeviceId,
            ':desc'       => 'Encrypted TextBee Device ID',
            ':created_by' => $userId,
            ':updated_by' => $userId
        ]);

        return ['success' => true, 'message' => 'Credentials encrypted and saved successfully.'];
    } catch (PDOException $e) {
        error_log("Database error saving TextBee credentials: " . $e->getMessage());
        return ['success' => false, 'error' => 'Database failure while saving credentials.'];
    }
}
