<?php
require_once 'notallowed.php';

function systemLog($action, $userId = 'System')
{
    $secretKey = LOG_SECRET_KEY; // Use the constant
    $method = 'aes-256-cbc';

    // Generate a random Initialization Vector (IV) for this specific line
    $ivLength = openssl_cipher_iv_length($method);
    $iv = openssl_random_pseudo_bytes($ivLength);

    // Format the message using the DB_TIMEZONE constant
    try {
        $timezone = new DateTimeZone(DB_TIMEZONE); // Accepts +08:00 or Asia/Manila
        $datetime = new DateTime('now', $timezone);
        $date = $datetime->format('Y-m-d H:i:s');
    } catch (Exception $e) {
        // Fallback just in case the constant is empty or malformed
        $date = date('Y-m-d H:i:s');
    }

    $rawMessage = "[$date] $action (User ID: $userId)";

    // Encrypt the message
    $encrypted = openssl_encrypt($rawMessage, $method, $secretKey, 0, $iv);

    // Combine the IV and Encrypted text, then Base64 encode it so it looks like clean text
    $payload = base64_encode($iv . '::' . $encrypted) . PHP_EOL;

    // Append to the file. LOCK_EX prevents two scripts from writing at the exact same time
    $logFile = __DIR__ . '/logs.txt';
    file_put_contents($logFile, $payload, FILE_APPEND | LOCK_EX);
}


// If logs.txt exceeds MAX_READ_BYTES (5 MiB), only the most recent is returned and with a warning or message
function readLogs()
{
    $secretKey = LOG_SECRET_KEY; // Use the constant
    $method = 'aes-256-cbc';
    $ivLength = openssl_cipher_iv_length($method); // will be 16

    $logFile = __DIR__ . '/logs.txt';

    if (!is_file($logFile)) {
        return []; // No logs yet
    }

    $fileSize = filesize($logFile);
    if ($fileSize === false || $fileSize === 0) {
        return [];
    }

    // Only read the last 5 MiB of a huge file
    $maxReadBytes = 5 * 1024 * 1024;

    $truncated = $fileSize > $maxReadBytes;
    $startOffset = $truncated ? ($fileSize - $maxReadBytes) : 0;

    $handle = fopen($logFile, 'rb');
    if ($handle === false) {
        return [];
    }

    // Shared lock: coordinates with systemLog()'s LOCK_EX to never read a half-written trailing line
    if (!flock($handle, LOCK_SH)) {
        fclose($handle);
        return [];
    }

    if ($startOffset > 0) {
        if (fseek($handle, $startOffset - 1) !== 0) {
            flock($handle, LOCK_UN);
            fclose($handle);
            return [];
        }
        $prevByte = fread($handle, 1);

        if (fseek($handle, $startOffset) !== 0) {
            flock($handle, LOCK_UN);
            fclose($handle);
            return [];
        }

        if ($prevByte !== "\n") {
            fgets($handle);
        }
    }

    $decryptedLogs = [];

    while (($line = fgets($handle)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($line === '') {
            continue;
        }

        $decoded = base64_decode($line, true);
        if ($decoded === false || strlen($decoded) <= $ivLength + 2) {
            continue; // Corrupt or partial line, skip
        }

        // IV = first 16 bytes, '::' = next 2 bytes, ciphertext = rest
        $iv = substr($decoded, 0, $ivLength);
        $encrypted = substr($decoded, $ivLength + 2);

        $decrypted = openssl_decrypt($encrypted, $method, $secretKey, 0, $iv);

        if ($decrypted !== false) {
            $decryptedLogs[] = $decrypted;
        }
    }

    flock($handle, LOCK_UN);
    fclose($handle);

    // Newest first
    $decryptedLogs = array_reverse($decryptedLogs);

    // Prepend warning message if the file was truncated/halfed/shorten
    if ($truncated) {
        $sizeMb = number_format($fileSize / 1048576, 2);
        $limitMb = number_format($maxReadBytes / 1048576, 2);
        $warning = "[WARNING] logs.txt is currently {$sizeMb} MB. "
            . "Only the latest {$limitMb} MB is displayed. "
            . "Check logs.txt directly for the complete history.";

        array_unshift($decryptedLogs, $warning);
    }

    return $decryptedLogs;
}
