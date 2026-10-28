<?php

declare(strict_types=1);

// Database Backup Endpoint
// GET  List all available backup files
// GET  /backup/{filename}  Download a specific backup file
// POST Create a new backup
// PUT  /backup/{filename}  Restore the database from the filename

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

const BACKUP_LIMIT       = 5;
const BACKUP_FILE_REGEX  = '/^[A-Za-z0-9._-]+\.sql$/';
const BACKUP_NAME_PREFIX = 'memoria_db_';

$userData = checkuser();

if (($userData['role'] ?? null) !== ROLE_ADMIN) {
    systemLog("{$userData['name']} ({$userData['username']}) attempted to backup or something here lol", $userData['user_id']);
    Response::error('Forbidden. Insufficient privileges.', 403);
}

if (defined('DB_TIMEZONE') && DB_TIMEZONE !== '' && strtoupper((string) DB_TIMEZONE) !== 'SYSTEM') {
    $tzValue = (string) DB_TIMEZONE;

    if (preg_match('/^([+-])(\d{2}):(\d{2})$/', $tzValue, $m)) {
        $offsetSeconds = ((int) $m[2] * 3600 + (int) $m[3] * 60) * ($m[1] === '-' ? -1 : 1);
        $name = timezone_name_from_abbr('', $offsetSeconds, 0);
        $tzValue = ($name !== false) ? $name : null;
    }

    if ($tzValue !== null && !@date_default_timezone_set($tzValue)) {
        error_log('backup.php: DB_TIMEZONE "' . DB_TIMEZONE . '" is not a valid PHP timezone.');
    }
}

@set_time_limit(0);

$backupDir = __DIR__ . '/backups/';

if (!is_dir($backupDir) && !mkdir($backupDir, 0755, true) && !is_dir($backupDir)) {
    Response::error('Unable to create the backup directory.', 500);
}

$backupDir = rtrim((string) realpath($backupDir), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;

function dbTimezone(PDO $pdo): DateTimeZone
{
    static $tz = null;
    if ($tz instanceof DateTimeZone) {
        return $tz;
    }

    try {
        $sessionTz = (string) $pdo->query('SELECT @@session.time_zone')->fetchColumn();

        if ($sessionTz !== '' && strtoupper($sessionTz) !== 'SYSTEM') {
            return $tz = new DateTimeZone($sessionTz);
        }
    } catch (Throwable $e) {
    }

    try {
        $diff = (string) $pdo->query('SELECT TIMEDIFF(NOW(), UTC_TIMESTAMP())')->fetchColumn();

        if (preg_match('/^(-?)(\d{1,2}):(\d{2})/', $diff, $m)) {
            $sign   = $m[1] === '-' ? '-' : '+';
            $hour   = str_pad($m[2], 2, '0', STR_PAD_LEFT);
            $minute = $m[3];
            return $tz = new DateTimeZone($sign . $hour . ':' . $minute);
        }
    } catch (Throwable $e) {
    }

    return $tz = new DateTimeZone('UTC');
}

function parseBackupTimestamp(string $filename): ?string
{
    $pattern = '/^' . preg_quote(BACKUP_NAME_PREFIX, '/')
        . '(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.sql$/';

    if (!preg_match($pattern, $filename, $m)) {
        return null;
    }

    return "{$m[1]} {$m[2]}:{$m[3]}:{$m[4]}";
}

function resolveBackupPath(string $name, string $backupDir): ?string
{
    $name = basename(trim($name));

    if ($name === '' || !preg_match(BACKUP_FILE_REGEX, $name)) {
        return null;
    }

    $real = realpath($backupDir . $name);

    if ($real === false || !is_file($real)) {
        return null;
    }

    if (strncmp($real, $backupDir, strlen($backupDir)) !== 0) {
        return null;
    }

    return $real;
}

function sqlLiteral(PDO $pdo, mixed $value): string
{
    if ($value === null) {
        return 'NULL';
    }
    if (is_bool($value)) {
        return $value ? '1' : '0';
    }
    if (is_int($value) || is_float($value)) {
        return (string) $value;
    }

    return $pdo->quote((string) $value);
}

function sqlIdentifier(string $identifier): string
{
    return '`' . str_replace('`', '``', $identifier) . '`';
}

function acquireOperationLock(string $backupDir)
{
    $lockPath = $backupDir . '.operation.lock';
    $fp = fopen($lockPath, 'c+');
    if (!$fp) {
        return null;
    }

    if (!flock($fp, LOCK_EX | LOCK_NB)) {
        fclose($fp);
        return null;    // someone else holds it
    }

    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode([
        'pid' => getmypid(),
        'at'  => date('c'),
    ]));
    fflush($fp);

    return $fp;
}

function releaseOperationLock($fp): void
{
    if (!is_resource($fp)) {
        return;
    }
    flock($fp, LOCK_UN);
    fclose($fp);
}

function createBackup(PDO $pdo, string $backupDir): string
{
    $stamp     = (string) $pdo->query('SELECT DATE_FORMAT(NOW(), "%Y-%m-%d_%H-%i-%s")')->fetchColumn();
    $filename  = BACKUP_NAME_PREFIX . $stamp . '.sql';
    $tmpPath   = $backupDir . $filename . '.tmp';
    $finalPath = $backupDir . $filename;

    $handle = fopen($tmpPath, 'wb');
    if ($handle === false) {
        throw new RuntimeException('Unable to open the backup file for writing.');
    }

    $genStmt = $pdo->prepare(
        "SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = :table
            AND EXTRA LIKE '%GENERATED%'"
    );

    try {
        $pdo->exec("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        $pdo->exec("START TRANSACTION WITH CONSISTENT SNAPSHOT");

        try {
            $sessionTz = (string) $pdo->query('SELECT @@session.time_zone')->fetchColumn();

            $headerTime = (new DateTimeImmutable('now', dbTimezone($pdo)))->format('Y-m-d H:i:s');

            fwrite($handle, "-- Data-only backup generated {$headerTime} (timezone: {$sessionTz})\n");
            fwrite($handle, "SET FOREIGN_KEY_CHECKS=0;\n");
            fwrite($handle, "SET NAMES utf8mb4;\n");
            fwrite($handle, "SET time_zone = " . $pdo->quote($sessionTz) . ";\n\n");

            $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) ?: [];

            foreach ($tables as $table) {
                $quotedTable = sqlIdentifier((string) $table);

                $genStmt->execute([':table' => $table]);
                $generated = $genStmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
                $skip      = array_flip($generated); // fast isset() lookup

                fwrite($handle, "TRUNCATE TABLE {$quotedTable};\n");

                $stmt = $pdo->query("SELECT * FROM {$quotedTable}");

                while (($row = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
                    $row = array_filter(
                        $row,
                        static fn(string $col): bool => !isset($skip[$col]),
                        ARRAY_FILTER_USE_KEY
                    );

                    if ($row === []) {
                        continue;
                    }

                    $columns = implode(', ', array_map(
                        static fn(string $c): string => sqlIdentifier($c),
                        array_keys($row)
                    ));

                    $values = implode(', ', array_map(
                        static fn(mixed $v): string => sqlLiteral($pdo, $v),
                        array_values($row)
                    ));

                    fwrite($handle, "INSERT INTO {$quotedTable} ({$columns}) VALUES ({$values});\n");
                }

                fwrite($handle, "\n");
            }

            fwrite($handle, "SET FOREIGN_KEY_CHECKS=1;\n");
        } finally {
            $pdo->exec("COMMIT");
        }
    } finally {
        fclose($handle);
    }

    if (!rename($tmpPath, $finalPath)) {
        @unlink($tmpPath);
        throw new RuntimeException('Unable to finalise the backup file.');
    }

    return $filename;
}

function pruneBackups(string $backupDir): array
{
    $files = glob($backupDir . '*.sql') ?: [];

    usort($files, static fn(string $a, string $b): int => filemtime($b) <=> filemtime($a));

    $deleted = [];

    foreach (array_slice($files, BACKUP_LIMIT) as $file) {
        if (is_file($file) && @unlink($file)) {
            $deleted[] = basename($file);
        }
    }

    return $deleted;
}

function splitSqlStatements(string $sql): array
{
    $statements = [];
    $buffer     = '';
    $length     = strlen($sql);

    $inSingle = $inDouble = $inBacktick = false;
    $inLineComment = $inBlockComment = false;

    for ($i = 0; $i < $length; $i++) {
        $char = $sql[$i];
        $next = $sql[$i + 1] ?? '';

        if ($inLineComment) {
            if ($char === "\n") {
                $inLineComment = false;
                $buffer .= $char;
            }
            continue;
        }

        if ($inBlockComment) {
            if ($char === '*' && $next === '/') {
                $inBlockComment = false;
                $i++;
            }
            continue;
        }

        if ($inSingle || $inDouble || $inBacktick) {
            $buffer .= $char;

            if ($char === '\\' && !$inBacktick && $next !== '') {
                $buffer .= $next;
                $i++;
                continue;
            }

            $closing = $inSingle ? "'" : ($inDouble ? '"' : '`');

            if ($char === $closing) {
                if ($next === $closing) {
                    $buffer .= $next;
                    $i++;
                    continue;
                }
                $inSingle = $inDouble = $inBacktick = false;
            }
            continue;
        }

        if ($char === '-' && $next === '-') {
            $after = $sql[$i + 2] ?? ' ';
            if ($after === ' ' || $after === "\t" || $after === "\n") {
                $inLineComment = true;
                $i++;
                continue;
            }
        }

        if ($char === '#') {
            $inLineComment = true;
            continue;
        }

        if ($char === '/' && $next === '*') {
            $inBlockComment = true;
            $i++;
            continue;
        }

        if ($char === "'") {
            $inSingle  = true;
            $buffer .= $char;
            continue;
        }
        if ($char === '"') {
            $inDouble  = true;
            $buffer .= $char;
            continue;
        }
        if ($char === '`') {
            $inBacktick = true;
            $buffer .= $char;
            continue;
        }

        if ($char === ';') {
            $statement = trim($buffer);
            if ($statement !== '') {
                $statements[] = $statement;
            }
            $buffer = '';
            continue;
        }

        $buffer .= $char;
    }

    $statement = trim($buffer);
    if ($statement !== '') {
        $statements[] = $statement;
    }

    return $statements;
}
function restoreBackup(PDO $pdo, string $filePath): int
{
    $sql = file_get_contents($filePath);

    if ($sql === false || trim($sql) === '') {
        throw new RuntimeException('The backup file is empty or unreadable.');
    }

    $statements = splitSqlStatements($sql);
    $executed   = 0;

    foreach ($statements as $index => $statement) {
        try {
            $pdo->exec($statement);
            $executed++;
        } catch (PDOException $e) {
            throw new RuntimeException(
                sprintf('Restore aborted at statement #%d: %s', $index + 1, $e->getMessage()),
                0,
                $e
            );
        }
    }

    return $executed;
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';

// Path: /backup/{filename}  (also accepts ?file= as a fallback)
$pathInfo  = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts = array_values(array_filter(explode('/', trim((string) $pathInfo, '/'))));

$resourceId = $pathParts[0] ?? ($_GET['file'] ?? null);
$resourceId = is_string($resourceId) ? trim($resourceId) : null;

// GET — download a single file, or list everything
if ($method === 'GET') {

    // 4a. Download a specific backup
    if ($resourceId !== null && $resourceId !== '') {
        $filePath = resolveBackupPath($resourceId, $backupDir);

        if ($filePath === null) {
            Response::error('Backup file not found.', 404);
        }

        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        $downloadName = basename($filePath);

        header('Content-Type: application/sql; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $downloadName . '"');
        header('Content-Length: ' . filesize($filePath));
        header('Content-Transfer-Encoding: binary');
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        header('X-Content-Type-Options: nosniff');

        readfile($filePath);
        exit;
    }

    $files = glob($backupDir . '*.sql') ?: [];

    usort($files, static fn(string $a, string $b): int => filemtime($b) <=> filemtime($a));

    $tz      = dbTimezone($pdo);
    $backups = [];

    foreach ($files as $file) {
        $name = basename($file);

        $date = parseBackupTimestamp($name);

        if ($date === null) {
            $mtime = filemtime($file);
            $date  = $mtime !== false
                ? (new DateTimeImmutable('@' . $mtime))->setTimezone($tz)->format('Y-m-d H:i:s')
                : 'unknown';
        }

        $backups[] = [
            'filename'      => $name,
            'size_in_bytes' => filesize($file),
            'date'          => $date,
            'download'      => '/api/backup/' . rawurlencode($name),
        ];
    }

    Response::success('Backups retrieved successfully.', $backups);
}

// POST — create a new backup and enforce the retention limit
if ($method === 'POST') {
    $lock = acquireOperationLock($backupDir);
    if ($lock === null) {
        Response::error('Another backup or restore operation is already in progress.', 409);
    }

    try {
        $filename = createBackup($pdo, $backupDir);
        $deleted  = pruneBackups($backupDir);
        systemLog("{$userData['name']} ({$userData['username']}) created a database backup: " . $filename, $userData['user_id']);

        Response::success('Snapshot created successfully: ' . $filename, [
            'filename'      => $filename,
            'size_in_bytes' => filesize($backupDir . $filename),
            'pruned'        => $deleted,
        ]);
    } catch (Throwable $e) {
        Response::error('Backup failed: ' . $e->getMessage(), 500);
    } finally {
        releaseOperationLock($lock);
    }
}

// PUT — restore the database from a backup file
if ($method === 'PUT') {
    if ($resourceId === null || $resourceId === '') {
        Response::error('Filename is required to restore a backup.', 400);
    }

    $filePath = resolveBackupPath($resourceId, $backupDir);

    if ($filePath === null) {
        Response::error('Backup file not found.', 404);
    }

    $lock = acquireOperationLock($backupDir);
    if ($lock === null) {
        Response::error('Another backup or restore operation is already in progress.', 409);
    }

    $safetyFile = null;

    try {
        $safetyFile = createBackup($pdo, $backupDir);
        pruneBackups($backupDir);

        $executed = restoreBackup($pdo, $filePath);

        systemLog(
            "{$userData['name']} ({$userData['username']}) restored a database backup: " .
                basename($filePath) . " (safety snapshot: {$safetyFile})",
            $userData['user_id']
        );

        Response::success('Database restored successfully: ' . basename($filePath), [
            'filename'      => basename($filePath),
            'statements'    => $executed,
            'safety_backup' => $safetyFile,
        ]);
    } catch (Throwable $e) {
        systemLog(
            "Restore failed: " . $e->getMessage() .
                ($safetyFile !== null ? " | Safety backup: {$safetyFile}" : ''),
            $userData['user_id']
        );

        $msg = 'Restore failed: ' . $e->getMessage();
        if ($safetyFile !== null) {
            $msg .= '. Pre-restore state was saved as: ' . $safetyFile .
                '. You can restore it to return to the previous state.';
        }

        Response::error($msg, 500);
    } finally {
        releaseOperationLock($lock);
    }
}

// Anything else
header('Allow: GET, POST, PUT');
Response::error('Method not allowed.', 405);
