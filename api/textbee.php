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
function sendSmsViaTextBee($phoneNumber, $message, $include_cemetery_name = true, $user_id = NULL)
{
    global $pdo;

    // --- 1. Normalize phone number input to an array ---
    $phoneNumbers = is_array($phoneNumber) ? $phoneNumber : [$phoneNumber];

    // Format and validate each number
    $formattedNumbers = [];
    foreach ($phoneNumbers as $number) {
        $formatted = formatPhNumber($number);
        if (!$formatted) {
            $reason = "Invalid Philippines phone number: {$number}";
            systemLog("Failed to send SMS to {$number}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
        }
        $formattedNumbers[] = $formatted;
    }

    if (empty($formattedNumbers)) {
        $reason = 'No valid phone numbers provided.';
        systemLog("Failed to send SMS. Error: {$reason}. Content: {$message}", $user_id);
        return ['success' => false, 'error' => $reason];
    }

    // Readable target for log messages (handles the array case)
    $phoneNumbersForLog = implode(', ', $formattedNumbers);

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
            $reason = 'TextBee API key is missing in the database.';
            systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
        }

        $apiKey = decryptCredential($keyResult['setting_value']);

        if (!$apiKey) {
            $reason = 'Failed to decrypt TextBee API key.';
            systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
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
            $reason = 'TextBee Device ID is missing in the database.';
            systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
        }

        $deviceId = decryptCredential($deviceResult['setting_value']);

        if (!$deviceId) {
            $reason = 'Failed to decrypt TextBee Device ID.';
            systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
        }

        // --- 2. Use the correct account-level endpoint ---
        $url = "https://api.textbee.dev/api/v1/gateway/send-sms";

        // Fetch cemetery name (unchanged)
        $cemetery_name = $pdo->query("
            SELECT setting_value 
            FROM settings 
            WHERE setting_key = 'cemetery_name' AND deleted_at IS NULL
        ")->fetch(PDO::FETCH_ASSOC)['setting_value'] ?? false;

        if ($cemetery_name && $include_cemetery_name) {
            $message = $message . "\n\n- From " . $cemetery_name;
        }

        // --- 3. Build the correct JSON payload ---
        $payloadData = [
            "recipients" => $formattedNumbers,   // Correct field name
            "message"    => $message,            // Correct field name
            "deviceId"   => $deviceId            // Optional: force a specific device
        ];

        $payload = json_encode($payloadData);

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
            $reason = 'Connection failed: ' . $curlError;
            systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
        }

        if ($httpCode >= 200 && $httpCode < 300) {
            systemLog("SMS sent to {$phoneNumbersForLog}. Content: {$message}", $user_id);
            return ['success' => true, 'response' => json_decode($response, true)];
        } else {
            error_log("TextBee API Error (Code $httpCode): " . $response);
            $reason = 'API rejected the request. Code: ' . $httpCode;
            systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
            return ['success' => false, 'error' => $reason];
        }
    } catch (PDOException $e) {
        error_log("Database error in sendSmsViaTextBee: " . $e->getMessage());
        $reason = 'Database failure while fetching credentials.';
        systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
        return ['success' => false, 'error' => $reason];
    } catch (Exception $e) {
        error_log("Decryption error in sendSmsViaTextBee: " . $e->getMessage());
        $reason = 'System error processing credentials.';
        systemLog("Failed to send SMS to {$phoneNumbersForLog}. Error: {$reason}. Content: {$message}", $user_id);
        return ['success' => false, 'error' => $reason];
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
