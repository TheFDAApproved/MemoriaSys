<?php
require_once 'notallowed.php';

/**
 * Writes an encrypted log entry to logs.txt
 * @param string $action The description of what happened
 * @param int|string $userId The ID of the user who did it (optional)
 */
function systemLog($action, $userId = 'System')
{
    $secretKey = LOG_SECRET_KEY; // Use the constant
    $method = 'aes-256-cbc';

    // 1. Generate a random Initialization Vector (IV) for this specific line
    $ivLength = openssl_cipher_iv_length($method);
    $iv = openssl_random_pseudo_bytes($ivLength);

    // 2. Format the message using your DB_TIMEZONE constant
    try {
        $timezone = new DateTimeZone(DB_TIMEZONE); // Accepts '+08:00' or 'Asia/Manila'
        $datetime = new DateTime('now', $timezone);
        $date = $datetime->format('Y-m-d H:i:s');
    } catch (Exception $e) {
        // Fallback just in case the constant is empty or malformed
        $date = date('Y-m-d H:i:s');
    }

    $rawMessage = "[$date] $action (User ID: $userId)";

    // 3. Encrypt the message
    $encrypted = openssl_encrypt($rawMessage, $method, $secretKey, 0, $iv);

    // 4. Combine the IV and Encrypted text, then Base64 encode it so it looks like clean text
    $payload = base64_encode($iv . '::' . $encrypted) . PHP_EOL;

    // 5. Append to the file. LOCK_EX prevents two scripts from writing at the exact same time!
    $logFile = __DIR__ . '/logs.txt';
    file_put_contents($logFile, $payload, FILE_APPEND | LOCK_EX);
}

/**
 * Reads and decrypts the logs.txt file
 * @return array An array of decrypted log strings
 */
function readLogs()
{
    $secretKey = LOG_SECRET_KEY; // Use the constant
    $method = 'aes-256-cbc';
    $ivLength = openssl_cipher_iv_length($method); // This will be 16

    $logFile = __DIR__ . '/logs.txt';
    $decryptedLogs = [];

    if (!file_exists($logFile)) {
        return []; // Return empty array if no logs exist yet
    }

    // Read the file line by line
    $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

    foreach ($lines as $line) {
        $decoded = base64_decode($line);

        // Ensure the line is long enough to contain a 16-byte IV, '::', and some data
        if (strlen($decoded) > $ivLength + 2) {

            // 1. Grab EXACTLY the first 16 bytes. This ignores any accidental '::' inside the binary IV.
            $iv = substr($decoded, 0, $ivLength);

            // 2. The encrypted text starts exactly 18 bytes in (16 for IV + 2 for '::')
            $encrypted = substr($decoded, $ivLength + 2);

            // 3. Decrypt it safely
            $decrypted = openssl_decrypt($encrypted, $method, $secretKey, 0, $iv);

            if ($decrypted !== false) {
                $decryptedLogs[] = $decrypted;
            }
        }
    }

    // Reverse the array so the newest logs show up first
    return array_reverse($decryptedLogs);
}
