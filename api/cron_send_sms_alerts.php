<?php
// cron_send_sms_alerts.php
// Dual-mode endpoint:
//   - CLI   (Cronical, Task Scheduler, `php cron_send_sms_alerts.php`) → trusted, no header needed
//   - HTTP  (cron-job.org, external scheduler)                          → REQUIRES X-CRON-SECRET
//
// Both modes run runSmsAlerts(). Output is JSON either way.

// 0. Long-running safety
// If a web client drops the connection mid-batch, PHP would normally abort.
// ignore_user_abort keeps it going; set_time_limit lifts PHP's 30s cap.
// Both are no-ops in CLI mode.
ignore_user_abort(true);
@set_time_limit(0);

// 1. Auth-gate constant — MUST be defined before config.php is required,
//    because config.php → notallowed.php checks it.
define('ITS_ME_JUSTTOVERIFY', true);

// 2. Requires — always use __DIR__, never bare filenames.
//    Cronical, Task Scheduler, cron-job.org, and cPanel cron all run this
//    script from different working directories. __DIR__ makes all of them
//    resolve to the file's own folder.
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/sms_alerts.php';

$isCli = (php_sapi_name() === 'cli');

// ---------------------------------------------------------------------------
// Helper: keep cron.log as a valid JSON array, newest entry at index 0.
//
// Format on disk:
//   [
//       { "success": true, "ran_at": "...", "result": {...} },
//       { "success": true, "ran_at": "...", "result": {...} }
//   ]
//
// Why newest-first: when you open the file, the first thing you see is the
// most recent run. Old entries age out of the bottom (capped at $maxEntries).
//
// Concurrency: multiple cron instances (if they ever race) are serialized by
// flock. Corruption (invalid JSON) is tolerated — the file restarts fresh.
//
// Cost: O(n) read+write per run. At $maxEntries=500 and ~500 bytes/entry, the
// file is ~250 KB and a rewrite takes ~5 ms. Fine for a once-a-minute cron.
// ---------------------------------------------------------------------------
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
            // If not an array (corrupt or old text-format log):
            // silently start fresh. Old content is discarded — acceptable
            // for a log; nothing downstream depends on its contents.
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

        // Rewrite in place — we hold the exclusive lock, so no reader
        // will see a half-written file.
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

// 3. Authentication (HTTP only)
if (!$isCli) {
    $providedSecret = $_SERVER['HTTP_X_CRON_SECRET'] ?? '';
    $expectedSecret = CRON_SECRET;

    // Fail-closed: if no secret is configured, reject ALL web requests.
    if ($expectedSecret === '' || !hash_equals($expectedSecret, $providedSecret)) {
        http_response_code(403);
        exit('Forbidden!');
    }

    header('Content-Type: application/json');
}

// 4. Run the job
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
    // Throwable covers Exception AND Error (TypeError, etc.)
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

// 5. Output
$json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

if ($isCli) {
    // CLI: echo a small banner + the JSON so Cronical's console shows
    // a readable line per run. (The log FILE uses the array format below;
    // this is only for the terminal view.)
    echo '[' . date('Y-m-d H:i:s') . '] cron_send_sms_alerts.php' . PHP_EOL;
    echo $json . PHP_EOL;

    // Append to cron.log as a JSON array, newest-first.
    prependToJsonLog(__DIR__ . '/cron.log', $payload);

    // Exit codes let Cronical / Task Scheduler / CI detect failures
    exit($payload['success'] ? 0 : 1);
}

// HTTP: pure JSON body
echo $json;
