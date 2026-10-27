<?php

// blocks.php – Manage cemetery blocks and their graves
// GET  returns all blocks or get a specific block with its graves
// Admin/Office receive full records including grave status, remarks, occupants
// Public and Grounds receive only the coordiantes needed to render blocks and graves in the map
// Admin/Office only: 
// POST Create a new block.
// PUT  Update block details, rename, and resize the grave grid
// DELETE   Soft-delete a block and all its graves
// PUT RESIZE RULES: if SHRINK make sure there is no other occupants. Soft-delete graves outside the new
// DELETE: A block can only be soft-deleted if every grave inside it is safe (no occupants)

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser(false);
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role          = $userData['role'] ?? null;
$isAdminOffice = in_array($role, [ROLE_ADMIN, ROLE_OFFICE]);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

const BLOCK_NAME_MAX = 42;

const MAX_GRAVES_PER_BLOCK = 15000;

const GRAVE_INSERT_CHUNK = 1000;

function getBlockCounts(PDO $pdo, int $blockId): array
{
    $stmt = $pdo->prepare("
        SELECT
            COUNT(*)                 AS total,
            COALESCE(SUM(status = 'Vacant'),   0) AS vacant,
            COALESCE(SUM(status = 'Occupied'), 0) AS occupied,
            COALESCE(SUM(status = 'Other'),    0) AS other
        FROM graves
        WHERE block_id = ? AND deleted_at IS NULL
    ");
    $stmt->execute([$blockId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

    return [
        'total'    => (int) ($row['total']    ?? 0),
        'vacant'   => (int) ($row['vacant']   ?? 0),
        'occupied' => (int) ($row['occupied'] ?? 0),
        'other'    => (int) ($row['other']    ?? 0),
    ];
}

function bulkInsertGraves(PDO $pdo, int $blockId, array $positions, string $blockName): void
{
    if (empty($positions)) {
        return;
    }

    foreach (array_chunk($positions, GRAVE_INSERT_CHUNK) as $batch) {
        $values = [];
        $params = [];
        foreach ($batch as [$r, $c]) {
            $values[] = "(?, ?, ?, ?, 'Vacant')";
            $params[] = $blockId;
            $params[] = buildGraveCode($blockName, (int) $r, (int) $c);
            $params[] = (int) $r;
            $params[] = (int) $c;
        }
        $sql = "INSERT INTO graves (block_id, grave_code, row_num, col_num, status) VALUES "
            . implode(', ', $values);
        $pdo->prepare($sql)->execute($params);
    }
}

function findUnsafeGraves(PDO $pdo, int $blockId, ?int $maxRow = null, ?int $maxCol = null): array
{
    $where  = "g.block_id = ? AND g.deleted_at IS NULL";
    $params = [$blockId];

    if ($maxRow !== null && $maxCol !== null) {
        $where   .= " AND (g.row_num > ? OR g.col_num > ?)";
        $params[] = $maxRow;
        $params[] = $maxCol;
    }

    $sql = "
        SELECT
            g.grave_id, g.grave_code, g.row_num, g.col_num, g.status,
            EXISTS (SELECT 1 FROM interments i
                    WHERE i.current_grave_id = g.grave_id) AS has_interment,
            EXISTS (SELECT 1 FROM reservations r
                    WHERE r.reservation_state = 'Active'
                      AND (r.target_grave_id  = g.grave_id
                        OR r.old_new_grave_id = g.grave_id)) AS has_plan,
            EXISTS (SELECT 1 FROM placement_history ph
                    WHERE ph.from_grave_id = g.grave_id
                       OR ph.to_grave_id   = g.grave_id) AS has_event
        FROM graves g
        WHERE $where
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $unsafe = [];
    foreach ($rows as $row) {
        $reasons = [];
        if ($row['status'] !== 'Vacant') {
            $reasons[] = "status is '{$row['status']}'";
        }
        if ((int) $row['has_interment'] === 1) {
            $reasons[] = "linked to an interment";
        }
        if ((int) $row['has_plan'] === 1) {
            $reasons[] = "referenced by an active reservation";
        }
        if ((int) $row['has_event'] === 1) {
            $reasons[] = "referenced in placement history";
        }
        if ($reasons) {
            $unsafe[] = [
                'grave_id'   => (int) $row['grave_id'],
                'grave_code' => $row['grave_code'],
                'row_num'    => (int) $row['row_num'],
                'col_num'    => (int) $row['col_num'],
                'reasons'    => $reasons,
            ];
        }
    }
    return $unsafe;
}

function buildGraveCode(string $blockName, int $row, int $col): string
{
    return $blockName
        . '-' . str_pad((string) $row, 2, '0', STR_PAD_LEFT)
        . '-' . str_pad((string) $col, 2, '0', STR_PAD_LEFT);
}

function summariseUnsafe(array $unsafe, int $max = 8): string
{
    $codes = array_map(static fn($g) => $g['grave_code'], $unsafe);
    $head  = implode(', ', array_slice($codes, 0, $max));
    $extra = count($codes) - $max;
    return $extra > 0 ? "$head … and $extra more" : $head;
}

function normalizeBlockRow(array $row, bool $withCounts = false): array
{
    if (array_key_exists('block_id', $row)) {
        $row['block_id'] = (int) $row['block_id'];
    }
    if (array_key_exists('rows', $row) && $row['rows'] !== null) {
        $row['rows'] = (int) $row['rows'];
    }
    if (array_key_exists('cols', $row) && $row['cols'] !== null) {
        $row['cols'] = (int) $row['cols'];
    }
    if (array_key_exists('custom', $row)) {
        $row['custom'] = (bool) $row['custom'];
    }
    if ($withCounts) {
        foreach (['total_graves', 'vacant', 'occupied', 'other'] as $k) {
            if (array_key_exists($k, $row)) {
                $row[$k] = (int) $row[$k];
            }
        }
    }
    return $row;
}

function friendlyDbError(PDOException $e, string $context = 'operation'): array
{
    $mysqlCode = $e->errorInfo[1] ?? null;
    $detail    = (string) ($e->errorInfo[2] ?? $e->getMessage());

    switch ($mysqlCode) {
        case 1062: // Duplicate entry for a unique index
            if (stripos($detail, 'uk_active_block_name') !== false) {
                return ["Block name already exists.", 409];
            }
            if (stripos($detail, 'uk_active_grave_code') !== false) {
                return [
                    "A grave with this code already exists in the block. "
                        . "The grid may be out of sync.",
                    409
                ];
            }
            return ["A record with the same unique value already exists.", 409];

        case 1205: // Lock wait timeout exceeded
        case 1213: // Deadlock found when trying to get lock
            return [
                "This block is currently being edited by another user. "
                    . "Please try again in a moment.",
                409
            ];

        case 1390: // Prepared statement contains too many placeholders
            return [
                "The grave grid is too large for a single request. "
                    . "Please reduce the number of rows/cols and try again.",
                413
            ];

        case 1451: // Cannot delete/update parent row: FK constraint fails
            return ["Cannot complete: other records still reference this row.", 409];

        case 1452: // Cannot add/update child row: FK constraint fails
            return ["Cannot complete: a referenced record does not exist.", 409];

        case 1406: // Data too long for column
            return ["One of the provided values is too long for its column.", 400];

        case 1048: // Column cannot be null
            return ["A required field was missing or empty.", 400];

        case 1264: // Out of range value for column
            return ["A numeric value is out of range.", 400];

        default:
            return ["Database error while processing $context.", 500];
    }
}

function failWithDbError(PDOException $e, string $context): void
{
    [$msg, $code] = friendlyDbError($e, $context);
    systemLog("$context error: " . $e->getMessage(), 'System');
    Response::error($msg, $code);
}

// GET
if ($method === 'GET') {

    if (is_numeric($resourceId)) {
        if ($isAdminOffice) {
            $blockStmt = $pdo->prepare("
                SELECT * FROM blocks
                WHERE block_id = ? AND deleted_at IS NULL
            ");
        } else {
            // Public / Grounds: rendering fields. No remarks, no audit columns
            $blockStmt = $pdo->prepare("
                SELECT block_id, block_name, block_type, coordinates,
                       image_link, `rows`, `cols`, custom
                FROM blocks
                WHERE block_id = ? AND deleted_at IS NULL
            ");
        }
        $blockStmt->execute([$resourceId]);
        $block = $blockStmt->fetch(PDO::FETCH_ASSOC);
        if (!$block) {
            Response::error("Block not found.", 404);
        }
        $block = normalizeBlockRow($block);

        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
        $limit = max(1, min($limit, 500));
        $page  = isset($_GET['page'])  ? (int) $_GET['page']  : 1;
        $page  = max(1, $page);

        $countStmt = $pdo->prepare("
            SELECT COUNT(*) FROM graves
            WHERE block_id = ? AND deleted_at IS NULL
        ");
        $countStmt->execute([$resourceId]);
        $totalRecords = (int) $countStmt->fetchColumn();
        $totalPages   = (int) ceil($totalRecords / $limit);
        $page         = min($page, $totalPages ?: 1);
        $offset       = ($page - 1) * $limit;

        if ($isAdminOffice) {
            $graveIdStmt = $pdo->prepare("
                SELECT grave_id
                FROM graves
                WHERE block_id = ? AND deleted_at IS NULL
                ORDER BY row_num, col_num
                LIMIT ? OFFSET ?
            ");
            $graveIdStmt->execute([$resourceId, $limit, $offset]);
            $graveIds = $graveIdStmt->fetchAll(PDO::FETCH_COLUMN);

            if (empty($graveIds)) {
                $graves = [];
            } else {
                $placeholders = implode(',', array_fill(0, count($graveIds), '?'));
                $graveSql = "
                    SELECT
                        g.grave_id, g.grave_code, g.row_num, g.col_num, g.status, g.remarks,
                        i.interment_id, i.control_number, i.deceased_name,
                        i.deceased_date_of_birth, i.deceased_date_of_death,
                        i.last_known_address, i.date_buried, i.lease_expiration_date,
                        i.contact_person_name, i.contact_person_phone_number,
                        i.contact_person_email, i.contact_person_address
                    FROM graves g
                    LEFT JOIN interments i
                        ON g.grave_id = i.current_grave_id
                        AND i.status = 'Active'
                        AND i.deleted_at IS NULL
                    WHERE g.grave_id IN ($placeholders)
                    ORDER BY g.row_num, g.col_num, i.interment_id
                ";
                $graveStmt = $pdo->prepare($graveSql);
                $graveStmt->execute($graveIds);
                $rows = $graveStmt->fetchAll(PDO::FETCH_ASSOC);

                $gravesMap = [];
                foreach ($rows as $row) {
                    $gid = $row['grave_id'];
                    if (!isset($gravesMap[$gid])) {
                        $gravesMap[$gid] = [
                            'grave_id'   => (int) $row['grave_id'],
                            'grave_code' => $row['grave_code'],
                            'row_num'    => (int) $row['row_num'],
                            'col_num'    => (int) $row['col_num'],
                            'status'     => $row['status'],
                            'remarks'    => $row['remarks'],
                            'occupants'  => [],
                        ];
                    }
                    if ($row['interment_id']) {
                        $gravesMap[$gid]['occupants'][] = [
                            'interment_id'                => (int) $row['interment_id'],
                            'control_number'              => $row['control_number'],
                            'deceased_name'               => $row['deceased_name'],
                            'last_known_address'          => $row['last_known_address'],
                            'date_buried'                 => $row['date_buried'],
                            'deceased_date_of_birth'      => $row['deceased_date_of_birth'],
                            'deceased_date_of_death'      => $row['deceased_date_of_death'],
                            'lease_expiration_date'       => $row['lease_expiration_date'],
                            'contact_person_name'         => $row['contact_person_name'],
                            'contact_person_phone_number' => $row['contact_person_phone_number'],
                            'contact_person_email'        => $row['contact_person_email'],
                            'contact_person_address'      => $row['contact_person_address'],
                        ];
                    }
                }
                $graves = array_values($gravesMap);
            }
        } else {
            $graveSql = "
                SELECT grave_id, grave_code, row_num, col_num
                FROM graves
                WHERE block_id = ? AND deleted_at IS NULL
                ORDER BY row_num, col_num
                LIMIT ? OFFSET ?
            ";
            $graveStmt = $pdo->prepare($graveSql);
            $graveStmt->execute([$resourceId, $limit, $offset]);
            $graves = $graveStmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($graves as &$g) {
                $g['grave_id'] = (int) $g['grave_id'];
                $g['row_num']  = (int) $g['row_num'];
                $g['col_num']  = (int) $g['col_num'];
            }
            unset($g);
        }

        // Counts: Admin/Office only
        if ($isAdminOffice) {
            $counts = getBlockCounts($pdo, (int) $resourceId);
            $block['total_graves'] = $counts['total'];
            $block['vacant']       = $counts['vacant'];
            $block['occupied']     = $counts['occupied'];
            $block['other']        = $counts['other'];
        }

        Response::success("Block details retrieved.", [
            'block'      => $block,
            'graves'     => $graves,
            'pagination' => [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ],
        ]);
    }

    $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
    if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
        Response::error("Search term must be at least 3 characters long", 400);
    }

    $searchSQL    = '';
    $searchParams = [];
    if ($searchTerm !== '') {
        $like = '%' . $searchTerm . '%';
        $cols = ['b.block_name', 'b.block_type'];
        if ($isAdminOffice) {
            $cols[] = 'b.remarks';
        }
        $parts = [];
        foreach ($cols as $c) {
            $parts[]        = "$c LIKE ?";
            $searchParams[] = $like;
        }
        $searchSQL = ' AND (' . implode(' OR ', $parts) . ')';
    }

    if ($isAdminOffice) {
        $sql = "
            SELECT b.*,
                (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND deleted_at IS NULL)                         AS total_graves,
                (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Vacant'   AND deleted_at IS NULL) AS vacant,
                (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Occupied' AND deleted_at IS NULL) AS occupied,
                (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Other'    AND deleted_at IS NULL) AS other
            FROM blocks b
            WHERE b.deleted_at IS NULL
            $searchSQL
            ORDER BY b.block_id
        ";
    } else {
        // Public / Grounds: rendering fields only for the UI/Map
        $sql = "
            SELECT
                b.block_id, b.block_name, b.block_type, b.coordinates,
                b.image_link, b.`rows`, b.`cols`, b.custom
            FROM blocks b
            WHERE b.deleted_at IS NULL
            $searchSQL
            ORDER BY b.block_id
        ";
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($searchParams);
    $blocks = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $withCounts = $isAdminOffice;
    foreach ($blocks as &$b) {
        $b = normalizeBlockRow($b, $withCounts);
    }
    unset($b);

    if ($searchTerm === '') {
        Response::success("Blocks retrieved.", $blocks);
    } else {
        Response::success("Blocks retrieved.", [
            'blocks'      => $blocks,
            'search_term' => $searchTerm,
        ]);
    }
}

// Everything below is Admin / Office only
if (!$isAdminOffice) {
    Response::error("Forbidden.", 403);
}

// POST – Create a block (optionally with a full grave grid)
if ($method === 'POST') {

    if (empty($rawData['block_name']) || empty($rawData['block_type'])) {
        Response::error("block_name and block_type are required.", 400);
    }

    $blockName = trim($rawData['block_name']);
    $blockType = trim($rawData['block_type']);

    $coordinates = $rawData['coordinates'] ?? null;
    $remarks     = trim($rawData['remarks']    ?? '');
    $image_link  = trim($rawData['image_link'] ?? '');
    $custom      = !empty($rawData['custom']) ? 1 : 0;

    // Enforce the length cap so grave_code never overflows VARCHAR(50).
    if (mb_strlen($blockName) > BLOCK_NAME_MAX) {
        Response::error(
            "block_name is too long (max " . BLOCK_NAME_MAX
                . " characters so grave_code fits in 50).",
            400
        );
    }

    $validTypes = ['Niche', 'Bone Chamber', 'Unmapped Area', 'Private', 'Mausoleum', 'Mass Grave', 'Cluster', 'Block', 'Lawn/Grounds'];
    if (!in_array($blockType, $validTypes, true)) {
        Response::error("Invalid block_type. Allowed: " . implode(', ', $validTypes), 400);
    }

    $check = $pdo->prepare("
        SELECT block_id FROM blocks
        WHERE block_name = ? AND deleted_at IS NULL
    ");
    $check->execute([$blockName]);
    if ($check->fetch()) {
        Response::error("Block name already exists.", 409);
    }

    $rows = isset($rawData['rows']) ? (int) $rawData['rows'] : 0;
    $cols = isset($rawData['cols']) ? (int) $rawData['cols'] : 0;
    if ($rows < 0 || $cols < 0) {
        Response::error("rows and cols must be non-negative integers.", 400);
    }
    if ($rows > 500 || $cols > 500) {
        Response::error("rows and cols cannot exceed 500.", 400);
    }

    $totalGraves = $rows * $cols;
    if ($totalGraves > MAX_GRAVES_PER_BLOCK) {
        Response::error(
            "Block would create $totalGraves graves, exceeding the maximum "
                . "of " . MAX_GRAVES_PER_BLOCK . " per block. "
                . "Reduce rows/cols and try again.",
            400
        );
    }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("
            INSERT INTO blocks
                (block_name, block_type, coordinates, remarks, image_link,
                 `rows`, `cols`, custom, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $blockName,
            $blockType,
            $coordinates,
            $remarks,
            $image_link,
            $rows,
            $cols,
            $custom,
            $userData['user_id'],
            $userData['user_id'],
        ]);
        $blockId = (int) $pdo->lastInsertId();

        // A block with rows=0 or cols=0 is created with no grave grid at all.
        if ($rows > 0 && $cols > 0) {
            $positions = [];
            for ($r = 1; $r <= $rows; $r++) {
                for ($c = 1; $c <= $cols; $c++) {
                    $positions[] = [$r, $c];
                }
            }
            bulkInsertGraves($pdo, $blockId, $positions, $blockName);
        }

        $pdo->commit();
        systemLog("Created block ID $blockId: $blockName (rows=$rows cols=$cols)", $userData['user_id']);
        Response::success("Block created.", ['block_id' => $blockId], 201);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        failWithDbError($e, 'block creation');
    }
}

// PUT – Update block details, rename, resize
if ($method === 'PUT') {

    if (!is_numeric($resourceId)) {
        Response::error("Block ID required.", 400);
    }
    $blockId = (int) $resourceId;

    // ---- Pre-transaction validation (needs no DB state) -------------------
    $newRows = isset($rawData['rows']) ? (int) $rawData['rows'] : null;
    $newCols = isset($rawData['cols']) ? (int) $rawData['cols'] : null;

    if ($newRows !== null && $newRows < 0) Response::error("rows cannot be negative.", 400);
    if ($newCols !== null && $newCols < 0) Response::error("cols cannot be negative.", 400);

    $maxAllowed = 500;
    if (($newRows !== null && $newRows > $maxAllowed) || ($newCols !== null && $newCols > $maxAllowed)) {
        Response::error("rows and cols cannot exceed $maxAllowed.", 400);
    }

    $scalarFields = ['block_type', 'coordinates', 'remarks', 'image_link', 'custom'];
    $hasFieldUpdate = false;
    foreach ($scalarFields as $f) {
        if (array_key_exists($f, $rawData)) {
            $hasFieldUpdate = true;
            break;
        }
    }
    $hasNameField   = array_key_exists('block_name', $rawData);
    $hasResizeField = ($newRows !== null || $newCols !== null);

    if (!$hasFieldUpdate && !$hasNameField && !$hasResizeField) {
        Response::error("No fields to update.", 400);
    }

    $pdo->exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    $pdo->beginTransaction();

    try {
        $lockBlock = $pdo->prepare("
            SELECT * FROM blocks
            WHERE block_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $lockBlock->execute([$blockId]);
        $current = $lockBlock->fetch(PDO::FETCH_ASSOC);
        if (!$current) {
            $pdo->rollBack();
            Response::error("Block not found.", 404);
        }

        $currentName = (string) $current['block_name'];
        $currentRows = (int)    $current['rows'];
        $currentCols = (int)    $current['cols'];

        $targetRows = $newRows ?? $currentRows;
        $targetCols = $newCols ?? $currentCols;

        $willShrink  = ($targetRows < $currentRows || $targetCols < $currentCols);
        $willEnlarge = ($targetRows > $currentRows || $targetCols > $currentCols);

        if ($willEnlarge && $targetRows * $targetCols > MAX_GRAVES_PER_BLOCK) {
            $pdo->rollBack();
            Response::error(
                "Cannot enlarge: this would create "
                    . ($targetRows * $targetCols) . " graves, exceeding the "
                    . "maximum of " . MAX_GRAVES_PER_BLOCK . " per block. "
                    . "Reduce rows/cols and try again.",
                400
            );
        }

        // Rename, uniqueness + length check
        $renameFrom = null;
        $renameTo   = null;

        if ($hasNameField) {
            $newName = trim((string) $rawData['block_name']);
            if ($newName === '') {
                $pdo->rollBack();
                Response::error("block_name cannot be empty.", 400);
            }
            if (mb_strlen($newName) > BLOCK_NAME_MAX) {
                $pdo->rollBack();
                Response::error(
                    "block_name is too long (max " . BLOCK_NAME_MAX
                        . " characters so grave_code fits in 50).",
                    400
                );
            }
            if ($newName !== $currentName) {
                $check = $pdo->prepare("
                    SELECT block_id FROM blocks
                    WHERE block_name = ? AND block_id != ? AND deleted_at IS NULL
                ");
                $check->execute([$newName, $blockId]);
                if ($check->fetch()) {
                    $pdo->rollBack();
                    Response::error("Block name already exists.", 409);
                }
                $renameFrom = $currentName;
                $renameTo   = $newName;
            }
        }

        if ($willShrink) {
            $lockGraves = $pdo->prepare("
                SELECT grave_id FROM graves
                WHERE block_id = ?
                  AND deleted_at IS NULL
                  AND (row_num > ? OR col_num > ?)
                FOR UPDATE
            ");
            $lockGraves->execute([$blockId, $targetRows, $targetCols]);
            $lockGraves->fetchAll(PDO::FETCH_COLUMN);

            $unsafe = findUnsafeGraves($pdo, $blockId, $targetRows, $targetCols);
            if (!empty($unsafe)) {
                $summary = summariseUnsafe($unsafe);
                $pdo->rollBack();
                systemLog(
                    "Block shrink rejected for ID $blockId: " . count($unsafe)
                        . " unsafe grave(s): $summary",
                    'System'
                );
                Response::error(
                    "Cannot shrink block: " . count($unsafe)
                        . " grave(s) in the removed area are not safe to remove "
                        . "(must be Vacant and unreferenced). Affected: $summary",
                    409
                );
            }
        }

        if ($renameFrom !== null) {
            $upd = $pdo->prepare("
                UPDATE blocks SET block_name = ?, updated_by = ?
                WHERE block_id = ?
            ");
            $upd->execute([$renameTo, $userData['user_id'], $blockId]);

            $graveUpd = $pdo->prepare("
                UPDATE graves
                SET grave_code = CONCAT(
                        ?,
                        '-',
                        IF(row_num < 10, '0', ''), row_num,
                        '-',
                        IF(col_num < 10, '0', ''), col_num
                    ),
                    updated_by = ?
                WHERE block_id = ? AND deleted_at IS NULL
            ");
            $graveUpd->execute([
                $renameTo,
                $userData['user_id'],
                $blockId,
            ]);
        }

        $updates = [];
        $params  = [];
        foreach ($scalarFields as $field) {
            if (array_key_exists($field, $rawData)) {
                $updates[] = "$field = ?";
                $params[]  = $rawData[$field];
            }
        }
        if ($newRows !== null) {
            $updates[] = "`rows` = ?";
            $params[] = $targetRows;
        }
        if ($newCols !== null) {
            $updates[] = "`cols` = ?";
            $params[] = $targetCols;
        }

        if (!empty($updates)) {
            $updates[] = "updated_by = ?";
            $params[]  = $userData['user_id'];
            $params[]  = $blockId;
            $sql = "UPDATE blocks SET " . implode(', ', $updates)
                . " WHERE block_id = ? AND deleted_at IS NULL";
            $pdo->prepare($sql)->execute($params);
        }

        if ($willShrink) {
            $del = $pdo->prepare("
                UPDATE graves
                SET deleted_at = NOW(), updated_by = ?
                WHERE block_id = ?
                  AND deleted_at IS NULL
                  AND (row_num > ? OR col_num > ?)
            ");
            $del->execute([$userData['user_id'], $blockId, $targetRows, $targetCols]);
        }

        if ($willEnlarge) {
            $blockName = $renameTo ?? $currentName;

            $softFind = $pdo->prepare("
                SELECT grave_id FROM graves
                WHERE block_id = ? AND row_num = ? AND col_num = ?
                  AND deleted_at IS NOT NULL
                ORDER BY grave_id DESC
                LIMIT 1
            ");
            $softRestore = $pdo->prepare("
                UPDATE graves
                SET deleted_at = NULL,
                    grave_code = ?,
                    status     = 'Vacant',
                    updated_by = ?
                WHERE grave_id = ?
            ");

            $toInsert = [];

            for ($r = 1; $r <= $targetRows; $r++) {
                for ($c = 1; $c <= $targetCols; $c++) {
                    if ($r > $currentRows || $c > $currentCols) {
                        $softFind->execute([$blockId, $r, $c]);
                        $softId = $softFind->fetchColumn();
                        if ($softId) {
                            $softRestore->execute([
                                buildGraveCode($blockName, $r, $c),
                                $userData['user_id'],
                                (int) $softId,
                            ]);
                        } else {
                            $toInsert[] = [$r, $c];
                        }
                    }
                }
            }

            if (!empty($toInsert)) {
                bulkInsertGraves($pdo, $blockId, $toInsert, $blockName);
            }
        }

        $pdo->commit();
        systemLog(
            "Updated block ID $blockId"
                . ($renameFrom !== null ? " (renamed $renameFrom -> $renameTo)" : "")
                . " rows=$targetRows cols=$targetCols",
            $userData['user_id']
        );
        Response::success("Block updated.");
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        failWithDbError($e, 'block update');
    }
}

// DELETE – Soft-delete a block and all its graves
if ($method === 'DELETE') {

    if (!is_numeric($resourceId)) {
        Response::error("Block ID required.", 400);
    }
    $blockId = (int) $resourceId;

    $pdo->exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    $pdo->beginTransaction();

    try {
        $lockBlock = $pdo->prepare("
            SELECT block_id FROM blocks
            WHERE block_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $lockBlock->execute([$blockId]);
        if (!$lockBlock->fetch()) {
            $pdo->rollBack();
            Response::error("Block not found or already deleted.", 404);
        }

        $lockGraves = $pdo->prepare("
            SELECT grave_id FROM graves
            WHERE block_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $lockGraves->execute([$blockId]);
        $lockGraves->fetchAll(PDO::FETCH_COLUMN);

        $unsafe = findUnsafeGraves($pdo, $blockId);
        if (!empty($unsafe)) {
            $summary = summariseUnsafe($unsafe);
            $pdo->rollBack();
            systemLog(
                "Block delete rejected for ID $blockId: " . count($unsafe)
                    . " unsafe grave(s): $summary",
                'System'
            );
            Response::error(
                "Cannot delete block: " . count($unsafe)
                    . " grave(s) inside it are not safe to remove "
                    . "(must be Vacant and unreferenced). Affected: $summary",
                409
            );
        }

        $delGraves = $pdo->prepare("
            UPDATE graves
            SET deleted_at = NOW(), updated_by = ?
            WHERE block_id = ? AND deleted_at IS NULL
        ");
        $delGraves->execute([$userData['user_id'], $blockId]);

        $delBlock = $pdo->prepare("
            UPDATE blocks
            SET deleted_at = NOW(), updated_by = ?
            WHERE block_id = ? AND deleted_at IS NULL
        ");
        $delBlock->execute([$userData['user_id'], $blockId]);

        $pdo->commit();
        systemLog("Soft-deleted block ID $blockId and all its graves", $userData['user_id']);
        Response::success("Block and all its graves soft-deleted.");
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        failWithDbError($e, 'block deletion');
    }
}

Response::error("Method Not Allowed", 405);
