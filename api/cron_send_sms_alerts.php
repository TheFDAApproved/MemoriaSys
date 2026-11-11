<?php
// cron_send_sms_alerts.php
// This file can run in two ways:
//   - From the command line (Cronical, Task Scheduler, or `php cron_send_sms_alerts.php`)
//     In this mode, no secret header is needed.
//   - From a web request (like cron-job.org or another external scheduler)
//     In this mode, it needs the X-CRON-SECRET header.
//
// Both ways call runSmsAlerts() and return JSON.

// 0. Make sure the script can run for a long time.
// If the browser disconnects, PHP would normally stop the script.
// ignore_user_abort keeps it running, and set_time_limit removes the 30 second limit.
// These do nothing when running from the command line.
ignore_user_abort(true);
@set_time_limit(0);

// 1. This must be defined before config.php is included.
// config.php uses it to check that this file is allowed to access it.
define('ITS_ME_JUSTTOVERIFY', true);


// 2. Use __DIR__ when including files.
// Cron jobs can run this file from different folders, so using __DIR__
// makes sure the files are found in the same folder as this script.
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/sms_alerts.php';

$isCli = (php_sapi_name() === 'cli');

// Helper function to save the log.
// It keeps cron.log as a JSON array with the newest entry first.
// Example:
//   [
//       { "success": true, "ran_at": "...", "result": {...} },
//       { "success": true, "ran_at": "...", "result": {...} }
//   ]
// The newest run is at the top so it is easy to see the latest result.
// It only keeps the last 500 entries.
// flock is used so two cron jobs do not write to the file at the same time.
// If the file has bad JSON, the log starts fresh.
function prependToJsonLog(string $path, array $entry, int $maxEntries = 500): bool
{
    $fh = @fopen($path, 'c+');
    if (!$fh) {
        return false;
    }

    if (!flock($fh, LOCK_EX)) {
        fclose($fh);
        return false;
    }

    try {
        $existing = stream_get_contents($fh);
        if ($existing === false) {
            $existing = '';
        }

        $entries = [];
        if ($existing !== '') {
            $decoded = json_decode($existing, true);
            if (is_array($decoded)) {
                $entries = $decoded;
            }
            // If the file is not valid JSON, just start a new log.
            // The old content is removed because it cannot be used anymore.
        }

        array_unshift($entries, $entry);
        if (count($entries) > $maxEntries) {
            $entries = array_slice($entries, 0, $maxEntries);
        }

        $json = json_encode(
            $entries,
            JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        );
        if ($json === false) {
            return false;
        }

        // Clear the file and write the updated log.
        // We already have the lock, so it is safe to do this.
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, $json . PHP_EOL);
        fflush($fh);

        return true;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

// 3. Check the secret only for web requests.
if (!$isCli) {
    $providedSecret = $_SERVER['HTTP_X_CRON_SECRET'] ?? '';
    $expectedSecret = CRON_SECRET;

    // If no secret is set, do not allow any web request.
    if ($expectedSecret === '' || !hash_equals($expectedSecret, $providedSecret)) {
        http_response_code(403);
        exit('Forbidden!');
    }

    header('Content-Type: application/json');
}

// 4. Run the SMS alert job
$payload = null;

try {
    $result = runSmsAlerts($pdo);

    if (function_exists('systemLog')) {
        systemLog('Cron SMS Success: ' . json_encode($result), null);
    }

    $payload = [
        'success' => true,
        'ran_at'  => date('c'),
        'result'  => $result,
    ];
} catch (Throwable $e) {
    // Throwable catches both Exception and Error.
    error_log('Cron SMS Error: ' . $e->getMessage());

    if (function_exists('systemLog')) {
        systemLog('Cron SMS Error: ' . $e->getMessage(), null);
    }

    if (!$isCli) {
        http_response_code(500);
    }

    $payload = [
        'success' => false,
        'ran_at'  => date('c'),
        'error'   => $e->getMessage(),
    ];
}

// 5. Show the result as JSON
$json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

if ($isCli) {
    // Show a simple message and the JSON in the terminal.
    // The cron.log file uses the JSON array format.
    echo '[' . date('Y-m-d H:i:s') . '] cron_send_sms_alerts.php' . PHP_EOL;
    echo $json . PHP_EOL;

    // Save this run to cron.log.
    prependToJsonLog(__DIR__ . '/cron.log', $payload);

    // Return 0 for success or 1 for failure.
    // Cronical, Task Scheduler, and CI can use this to know if it worked.
    exit($payload['success'] ? 0 : 1);
}

// For web requests, return only JSON.
echo $json;
