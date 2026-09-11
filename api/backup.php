<?php

declare(strict_types=1);

/**
 * Database Backup Endpoint
 *
 * GET    /backup               -> List all available backup files
 * GET    /backup/{filename}    -> Download a specific backup file
 * POST   /backup               -> Create a new data-only backup (5-file retention)
 * PUT    /backup/{filename}    -> Restore the database from a backup file
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

const BACKUP_LIMIT       = 5;
const BACKUP_FILE_REGEX  = '/^[A-Za-z0-9._-]+\.sql$/';
const BACKUP_NAME_PREFIX = 'memoria_db_';

$userData = checkuser();

if (($userData['role'] ?? null) !== ROLE_ADMIN) {
    Response::error('Forbidden. Insufficient privileges.', 403);
}

// -----------------------------------------------------------------------------
// 0. Sync PHP's clock with the database session timezone
// -----------------------------------------------------------------------------
// Without this, PHP's date()/time() run on php.ini's `date.timezone`, which is
// completely independent from MySQL's session timezone (already pinned by
// PDO::MYSQL_ATTR_INIT_COMMAND in database.php). That mismatch makes dump
// comments, filenames, and the GET listing disagree with DB-written timestamps
// like created_at / transfer_date.
//
// date_default_timezone_set() accepts both a named zone ('Asia/Manila') and a
// fixed offset ('+08:00'), so this works no matter which form DB_TIMEZONE uses.
if (defined('DB_TIMEZONE') && DB_TIMEZONE !== '') {
    @date_default_timezone_set(DB_TIMEZONE);
}

@set_time_limit(0);

// -----------------------------------------------------------------------------
// 1. Setup backup directory
// -----------------------------------------------------------------------------
$backupDir = __DIR__ . '/backups/';

if (!is_dir($backupDir) && !mkdir($backupDir, 0755, true) && !is_dir($backupDir)) {
    Response::error('Unable to create the backup directory.', 500);
}

// Normalised, trailing-slash path used for all containment checks.
$backupDir = rtrim((string) realpath($backupDir), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;

// -----------------------------------------------------------------------------
// 2. Helpers
// -----------------------------------------------------------------------------

/**
 * Resolve a user supplied name to a real file inside the backup directory.
 * Returns null when the name is invalid, missing, or escapes the directory.
 */
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

    // Final safety net against directory traversal / symlink escapes.
    if (strncmp($real, $backupDir, strlen($backupDir)) !== 0) {
        return null;
    }

    return $real;
}

/**
 * Render a PHP value as a safe SQL literal.
 */
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

/**
 * Quote an identifier (table / column name) for MySQL.
 */
function sqlIdentifier(string $identifier): string
{
    return '`' . str_replace('`', '``', $identifier) . '`';
}

/**
 * Stream a data-only dump of every table to disk.
 * Generated (shadow) columns are intentionally skipped — MySQL
 * refuses explicit values for them and recomputes them from `deleted_at`.
 */
function createBackup(PDO $pdo, string $backupDir): string
{
    $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) ?: [];

    // -------------------------------------------------------------------------
    // CHANGED: use MySQL's own clock for the filename, not PHP's.
    // Because the session timezone is already pinned to DB_TIMEZONE via
    // MYSQL_ATTR_INIT_COMMAND, NOW() reflects the DB's wall clock — the same
    // clock every created_at / transfer_date in the dump uses. This makes the
    // filename unambiguous even if someone later changes php.ini's date.timezone.
    // -------------------------------------------------------------------------
    $stamp     = (string) $pdo->query('SELECT DATE_FORMAT(NOW(), "%Y-%m-%d_%H-%i-%s")')->fetchColumn();
    $filename  = BACKUP_NAME_PREFIX . $stamp . '.sql';
    $tmpPath   = $backupDir . $filename . '.tmp';
    $finalPath = $backupDir . $filename;

    $handle = fopen($tmpPath, 'wb');
    if ($handle === false) {
        throw new RuntimeException('Unable to open the backup file for writing.');
    }

    // Prepared lookup for generated columns, per table.
    $genStmt = $pdo->prepare(
        "SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = :table
            AND EXTRA LIKE '%GENERATED%'"
    );

    try {
        // ---------------------------------------------------------------------
        // CHANGED: capture the live session timezone and bake it into the dump.
        // @@session.time_zone returns either a name ('Asia/Manila'), an offset
        // ('+08:00'), or the literal 'SYSTEM' — all three are valid inputs to
        // SET time_zone, so the value round-trips cleanly on restore.
        //
        // Why it matters: the log_grave_transfer trigger uses NOW() for
        // transfer_date. Without a SET time_zone in the dump, a restore runs in
        // whatever timezone the restoring connection happens to have, silently
        // shifting any transfer_log rows the trigger writes during the restore.
        // ---------------------------------------------------------------------
        $sessionTz = (string) $pdo->query('SELECT @@session.time_zone')->fetchColumn();

        fwrite($handle, "-- Data-only backup generated " . date('c') . "\n");
        fwrite($handle, "SET FOREIGN_KEY_CHECKS=0;\n");
        fwrite($handle, "SET NAMES utf8mb4;\n");
        fwrite($handle, "SET time_zone = " . $pdo->quote($sessionTz) . ";\n\n");

        foreach ($tables as $table) {
            $quotedTable = sqlIdentifier((string) $table);

            // Which columns must we skip for this table?
            $genStmt->execute([':table' => $table]);
            $generated = $genStmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
            $skip      = array_flip($generated); // fast isset() lookup

            fwrite($handle, "TRUNCATE TABLE {$quotedTable};\n");

            $stmt = $pdo->query("SELECT * FROM {$quotedTable}");

            while (($row = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
                // Drop generated columns from this row before writing it.
                $row = array_filter(
                    $row,
                    static fn(string $col): bool => !isset($skip[$col]),
                    ARRAY_FILTER_USE_KEY
                );

                if ($row === []) {
                    continue; // row was nothing but generated columns
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
        fclose($handle);
    }

    if (!rename($tmpPath, $finalPath)) {
        @unlink($tmpPath);
        throw new RuntimeException('Unable to finalise the backup file.');
    }

    return $filename;
}

/**
 * Delete the oldest backups so that only BACKUP_LIMIT files remain.
 */
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

/**
 * Split a SQL dump into individual statements.
 *
 * Quote- and comment-aware, so semicolons inside string literals are safe.
 */
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

        // --- Comments -------------------------------------------------------
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

        // --- Inside a quoted literal ----------------------------------------
        if ($inSingle || $inDouble || $inBacktick) {
            $buffer .= $char;

            if ($char === '\\' && !$inBacktick && $next !== '') {
                $buffer .= $next;
                $i++;
                continue;
            }

            $closing = $inSingle ? "'" : ($inDouble ? '"' : '`');

            if ($char === $closing) {
                if ($next === $closing) {   // doubled quote = escaped quote
                    $buffer .= $next;
                    $i++;
                    continue;
                }
                $inSingle = $inDouble = $inBacktick = false;
            }
            continue;
        }

        // --- Outside any literal --------------------------------------------
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

/**
 * Restore the database from a dump file. Returns the number of statements run.
 */
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

// -----------------------------------------------------------------------------
// 3. Routing
// -----------------------------------------------------------------------------
$method = $_SERVER['REQUEST_METHOD'] ?? '';

// Path: /backup/{filename}  (also accepts ?file= as a fallback)
$pathInfo  = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts = array_values(array_filter(explode('/', trim((string) $pathInfo, '/'))));

$resourceId = $pathParts[0] ?? ($_GET['file'] ?? null);
$resourceId = is_string($resourceId) ? trim($resourceId) : null;

// -----------------------------------------------------------------------------
// 4. GET — download a single file, or list everything
// -----------------------------------------------------------------------------
if ($method === 'GET') {

    // 4a. Download a specific backup
    if ($resourceId !== null && $resourceId !== '') {
        $filePath = resolveBackupPath($resourceId, $backupDir);

        if ($filePath === null) {
            Response::error('Backup file not found.', 404);
        }

        // Discard anything already buffered so the stream stays clean.
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

    // 4b. List available backups (newest first)
    $files   = glob($backupDir . '*.sql') ?: [];
    $backups = [];

    foreach ($files as $file) {
        $backups[] = [
            'filename' => basename($file),
            'size'     => filesize($file),
            // date() now runs in DB_TIMEZONE thanks to the sync in section 0,
            // so this matches the wall clock stored in created_at / transfer_date.
            'date'     => date('Y-m-d H:i:s', filemtime($file)),
            'download' => '/backup/' . rawurlencode(basename($file)),
        ];
    }

    usort($backups, static fn(array $a, array $b): int => strtotime($b['date']) <=> strtotime($a['date']));

    Response::success('Backups retrieved successfully.', $backups);
}

// -----------------------------------------------------------------------------
// 5. POST — create a new backup and enforce the retention limit
// -----------------------------------------------------------------------------
if ($method === 'POST') {
    try {
        $filename = createBackup($pdo, $backupDir);
        $deleted  = pruneBackups($backupDir);

        Response::success('Snapshot created successfully: ' . $filename, [
            'filename' => $filename,
            'size'     => filesize($backupDir . $filename),
            'pruned'   => $deleted,
        ]);
    } catch (Throwable $e) {
        Response::error('Backup failed: ' . $e->getMessage(), 500);
    }
}

// -----------------------------------------------------------------------------
// 6. PUT — restore the database from a backup file
// -----------------------------------------------------------------------------
if ($method === 'PUT') {
    if ($resourceId === null || $resourceId === '') {
        Response::error('Filename is required to restore a backup.', 400);
    }

    $filePath = resolveBackupPath($resourceId, $backupDir);

    if ($filePath === null) {
        Response::error('Backup file not found.', 404);
    }

    try {
        $executed = restoreBackup($pdo, $filePath);

        Response::success('Database restored successfully: ' . basename($filePath), [
            'filename'   => basename($filePath),
            'statements' => $executed,
        ]);
    } catch (Throwable $e) {
        Response::error('Restore failed: ' . $e->getMessage(), 500);
    }
}

// -----------------------------------------------------------------------------
// 7. Anything else
// -----------------------------------------------------------------------------
header('Allow: GET, POST, PUT');
Response::error('Method not allowed.', 405);
