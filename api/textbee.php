<?php

// Load the DB connection and shared helpers
require_once 'database.php';
require_once 'reusable_functions.php';

// ENCRYPTION_KEY must match the decryption script exactly, use 32 chars and keep it in .env if possible

// Encrypt a plain text string for safe storage, returns base64 of iv + cipher
function encryptCredential($plainText)
{
    // Random IV so saving the same value twice produces different ciphertexts
    $ivLength = openssl_cipher_iv_length('aes-256-cbc');
    $iv = openssl_random_pseudo_bytes($ivLength);

    // OPENSSL_RAW_DATA returns raw bytes instead of base64
    $encryptedData = openssl_encrypt($plainText, 'aes-256-cbc', ENCRYPTION_KEY, OPENSSL_RAW_DATA, $iv);

    // Prefix the IV so decryptCredential can split it back out
    return base64_encode($iv . $encryptedData);
}

// Reverse encryptCredential, returns the plain text
function decryptCredential($encryptedString)
{
    $data = base64_decode($encryptedString);
    $ivLength = openssl_cipher_iv_length('aes-256-cbc');

    // First $ivLength bytes are the IV, the rest is the cipher
    $iv = substr($data, 0, $ivLength);
    $encryptedData = substr($data, $ivLength);

    return openssl_decrypt($encryptedData, 'aes-256-cbc', ENCRYPTION_KEY, OPENSSL_RAW_DATA, $iv);
}

// Send an SMS through TextBee with an optional cemetery name suffix
function sendSmsViaTextBee($phoneNumber, $message, $include_cemetery_name = true)
{
    global $pdo;

    $phoneNumber = formatPhNumber($phoneNumber);
    if (!$phoneNumber) {
        return ['success' => false, 'error' => 'Invalid Philippines phone number'];
    }

    try {
        // Pull and decrypt the API key
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

        $apiKey = decryptCredential($keyResult['setting_value']);

        if (!$apiKey) {
            return ['success' => false, 'error' => 'Failed to decrypt TextBee API key.'];
        }

        // Same treatment for the device ID
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

        $deviceId = decryptCredential($deviceResult['setting_value']);

        if (!$deviceId) {
            return ['success' => false, 'error' => 'Failed to decrypt TextBee Device ID.'];
        }

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

        $ch = curl_init($url);

        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'x-api-key: ' . $apiKey
        ]);

        // Bounded timeouts so a slow TextBee can't hang the whole request
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);

        // curl_close() is deprecated in PHP 8.5+, skipped

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

// Encrypt and save the TextBee api_key and device_id as a matching pair
function saveTextBeeCredentials($plainTextApiKey, $plainTextDeviceId, $userId = null)
{
    global $pdo;

    // Encrypt before the transaction opens since encryption is CPU-bound and touches no rows
    try {
        $encryptedApiKey   = encryptCredential($plainTextApiKey);
        $encryptedDeviceId = encryptCredential($plainTextDeviceId);
    } catch (Throwable $e) {
        error_log("Encryption error saving TextBee credentials: " . $e->getMessage());
        return ['success' => false, 'error' => 'Failed to encrypt credentials.'];
    }

    try {
        // Both writes must land together, a half-written pair breaks TextBee auth with no obvious cause
        // The first INSERT row-locks textbee_api_key so a concurrent save waits there and can't interleave
        $pdo->beginTransaction();

        // VALUES(col) form because the AS new alias needs MySQL 8.0.19+ or MariaDB 11.x+
        $stmt = $pdo->prepare("
            INSERT INTO settings
            (setting_key, setting_value, description, created_at, updated_at, created_by, updated_by)
            VALUES (:key, :value, :desc, NOW(), NOW(), :created_by, :updated_by)
            ON DUPLICATE KEY UPDATE
            setting_value = VALUES(setting_value),
            description   = VALUES(description),
            updated_at    = NOW(),
            updated_by    = VALUES(updated_by)
        ");

        // Fixed write order so concurrent saves take the same locks in the same sequence and can't deadlock
        $stmt->execute([
            ':key'        => 'textbee_api_key',
            ':value'      => $encryptedApiKey,
            ':desc'       => 'Encrypted TextBee API Key (sensitive)',
            ':created_by' => $userId,
            ':updated_by' => $userId,
        ]);

        $stmt->execute([
            ':key'        => 'textbee_device_id',
            ':value'      => $encryptedDeviceId,
            ':desc'       => 'Encrypted TextBee Device ID (sensitive)',
            ':created_by' => $userId,
            ':updated_by' => $userId,
        ]);

        $pdo->commit();

        return ['success' => true, 'message' => 'Credentials encrypted and saved successfully.'];
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log("Database error saving TextBee credentials: " . $e->getMessage());
        return ['success' => false, 'error' => 'Database failure while saving credentials.'];
    }
}
