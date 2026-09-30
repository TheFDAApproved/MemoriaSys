<?php

/**
 * blocks.php – Manage cemetery blocks and their graves
 *
 * GET    : List all blocks (with counts) or get a specific block with its graves (paginated).
 * POST   : Create a new block (with optional grave generation).
 * PUT    : Update block details and adjust the grave grid (expand/shrink).
 * DELETE : Soft‑delete a block.
 *
 * NOTE: `rows` and `cols` are reserved words in MariaDB and must be backticked.
 * NOTE: `coordinates` holds the legacy GPS JSON ({lat,lng}); `coordinates_canvas`
 *       holds the 2D canvas pixel geometry used by map.js.
 *
 * Rename: always allowed, even when the block has graves.
 *         Grave codes are rewritten so their prefix matches the new block name.
 *
 * Delete: always allowed. Soft-deletes every grave in the block too.
 *         The frontend confirms before calling this.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser(false);
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
$isStaff = in_array($role, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]);
$isAdminOffice = in_array($role, [ROLE_ADMIN, ROLE_OFFICE]);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

function getBlockCounts($pdo, $blockId)
{
    $stmt = $pdo->prepare("
        SELECT 
            COUNT(*) AS total,
            SUM(status = 'Vacant') AS vacant,
            SUM(status = 'Occupied') AS occupied
        FROM graves 
        WHERE block_id = ? AND deleted_at IS NULL
    ");
    $stmt->execute([$blockId]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

// -----------------------------------------------------------------------------
// GET
// -----------------------------------------------------------------------------
if ($method === 'GET') {
    if (is_numeric($resourceId)) {
        if ($isStaff) {
            $blockStmt = $pdo->prepare("
                SELECT * FROM blocks 
                WHERE block_id = ? AND deleted_at IS NULL
            ");
        } else {
            $blockStmt = $pdo->prepare("
                SELECT block_id, block_name, block_type, coordinates, coordinates_canvas,
                       image_link, `rows`, `cols`, shape, custom
                FROM blocks 
                WHERE block_id = ? AND deleted_at IS NULL
            ");
        }
        $blockStmt->execute([$resourceId]);
        $block = $blockStmt->fetch(PDO::FETCH_ASSOC);
        if (!$block) {
            Response::error("Block not found.", 404);
        }

        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
        $limit = max(1, min($limit, 500));
        $page  = isset($_GET['page']) ? (int) $_GET['page'] : 1;
        $page  = max(1, $page);
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare("
            SELECT COUNT(*) FROM graves 
            WHERE block_id = ? AND deleted_at IS NULL
        ");
        $countStmt->execute([$resourceId]);
        $totalRecords = (int) $countStmt->fetchColumn();
        $totalPages = ceil($totalRecords / $limit);
        $page = min($page, $totalPages ?: 1);
        $offset = ($page - 1) * $limit;

        if ($isStaff) {
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
                    $graveId = $row['grave_id'];
                    if (!isset($gravesMap[$graveId])) {
                        $gravesMap[$graveId] = [
                            'grave_id' => $row['grave_id'],
                            'grave_code' => $row['grave_code'],
                            'row_num' => $row['row_num'],
                            'col_num' => $row['col_num'],
                            'status' => $row['status'],
                            'remarks' => $row['remarks'],
                            'occupants' => []
                        ];
                    }
                    if ($row['interment_id']) {
                        $gravesMap[$graveId]['occupants'][] = [
                            'interment_id' => (int) $row['interment_id'],
                            'control_number' => $row['control_number'],
                            'deceased_name' => $row['deceased_name'],
                            'last_known_address' => $row['last_known_address'],
                            'date_buried' => $row['date_buried'],
                            'lease_expiration_date' => $row['lease_expiration_date'],
                            'contact_person_name' => $row['contact_person_name'],
                            'contact_person_phone_number' => $row['contact_person_phone_number'],
                            'contact_person_email' => $row['contact_person_email'],
                            'contact_person_address' => $row['contact_person_address'],
                        ];
                    }
                }
                $graves = array_values($gravesMap);
            }
        } else {
            $graveSql = "
                SELECT grave_id, grave_code, row_num, col_num, status
                FROM graves
                WHERE block_id = ? AND deleted_at IS NULL
                ORDER BY row_num, col_num
                LIMIT ? OFFSET ?
            ";
            $graveStmt = $pdo->prepare($graveSql);
            $graveStmt->execute([$resourceId, $limit, $offset]);
            $graves = $graveStmt->fetchAll(PDO::FETCH_ASSOC);
        }

        $counts = getBlockCounts($pdo, $resourceId);
        $block['total_graves'] = (int) $counts['total'];
        $block['vacant'] = (int) $counts['vacant'];
        $block['occupied'] = (int) $counts['occupied'];

        Response::success("Block details retrieved.", [
            'block' => $block,
            'graves' => $graves,
            'pagination' => [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ]
        ]);
    } else {
        $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $searchSQL    = '';
        $searchParams = [];
        if ($searchTerm !== '') {
            $like   = '%' . $searchTerm . '%';
            $cols   = ['b.block_name', 'b.block_type'];
            if ($isStaff) {
                $cols[] = 'b.remarks';
            }
            $parts = [];
            foreach ($cols as $c) {
                $parts[]        = "$c LIKE ?";
                $searchParams[] = $like;
            }
            $searchSQL = ' AND (' . implode(' OR ', $parts) . ')';
        }

        if ($isStaff) {
            $sql = "
                SELECT b.*,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND deleted_at IS NULL) AS total_graves,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Vacant' AND deleted_at IS NULL) AS vacant,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Occupied' AND deleted_at IS NULL) AS occupied
                FROM blocks b
                WHERE b.deleted_at IS NULL
                $searchSQL
                ORDER BY b.block_id
            ";
        } else {
            $sql = "
                SELECT
                    b.block_id, b.block_name, b.block_type, b.coordinates, b.coordinates_canvas,
                    b.image_link, b.`rows`, b.`cols`, b.shape, b.custom,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND deleted_at IS NULL) AS total_graves,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Vacant' AND deleted_at IS NULL) AS vacant,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Occupied' AND deleted_at IS NULL) AS occupied
                FROM blocks b
                WHERE b.deleted_at IS NULL
                $searchSQL
                ORDER BY b.block_id
            ";
        }

        $stmt = $pdo->prepare($sql);
        $stmt->execute($searchParams);
        $blocks = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if ($searchTerm === '') {
            Response::success("Blocks retrieved.", $blocks);
        } else {
            Response::success("Blocks retrieved.", [
                'blocks'      => $blocks,
                'search_term' => $searchTerm,
            ]);
        }
    }
}

if (!$isAdminOffice) {
    Response::error("Forbidden.", 403);
}

// -----------------------------------------------------------------------------
// POST
// -----------------------------------------------------------------------------
if ($method === 'POST') {

    if (empty($rawData['block_name']) || empty($rawData['block_type'])) {
        Response::error("block_name and block_type are required.", 400);
    }
    $blockName   = trim($rawData['block_name']);
    $blockType   = trim($rawData['block_type']);
    $coordinates = $rawData['coordinates'] ?? null;
    $coordinates_canvas = $rawData['coordinates_canvas'] ?? null;
    $remarks     = trim($rawData['remarks'] ?? '');
    $image_link  = trim($rawData['image_link'] ?? '');

    $shape  = trim($rawData['shape']  ?? 'rectangle');
    $custom = !empty($rawData['custom']) ? 1 : 0;

    $validTypes = ['Niche', 'Bone Chamber', 'Unmapped Area', 'Private', 'Mausoleum', 'Mass Grave', 'Cluster', 'Block'];
    if (!in_array($blockType, $validTypes)) {
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

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("
            INSERT INTO blocks 
                (block_name, block_type, coordinates, coordinates_canvas, remarks, image_link,
                 `rows`, `cols`, shape, custom, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $blockName,
            $blockType,
            $coordinates,
            $coordinates_canvas,
            $remarks,
            $image_link,
            $rows,
            $cols,
            $shape,
            $custom,
            $userData['user_id'],
            $userData['user_id']
        ]);
        $blockId = $pdo->lastInsertId();

        // Only generate graves when both rows and cols are greater than 0.
        // A block with rows=0 or cols=0 is created with no grave grid at all.
        if ($rows > 0 && $cols > 0) {
            $graveSql = "INSERT INTO graves (block_id, grave_code, row_num, col_num, status) VALUES ";
            $values = [];
            $params = [];
            for ($r = 1; $r <= $rows; $r++) {
                for ($c = 1; $c <= $cols; $c++) {
                    $code = $blockName . '-' . str_pad($r, 2, '0', STR_PAD_LEFT) . '-' . str_pad($c, 2, '0', STR_PAD_LEFT);
                    $values[] = "(?, ?, ?, ?, 'Vacant')";
                    $params[] = $blockId;
                    $params[] = $code;
                    $params[] = $r;
                    $params[] = $c;
                }
            }
            $graveSql .= implode(', ', $values);
            $graveStmt = $pdo->prepare($graveSql);
            $graveStmt->execute($params);
        }

        $pdo->commit();
        systemLog("Created new block ID $blockId: $blockName (rows=$rows cols=$cols)", $userData['user_id']);
        Response::success("Block created.", ['block_id' => $blockId], 201);
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Block creation error: " . $e->getMessage(), 'System');
        Response::error("Database error while creating block.", 500);
    }
}

// -----------------------------------------------------------------------------
// PUT
// -----------------------------------------------------------------------------
if ($method === 'PUT') {

    if (!is_numeric($resourceId)) {
        Response::error("Block ID required.", 400);
    }
    $blockId = (int) $resourceId;

    $currentStmt = $pdo->prepare("
        SELECT * FROM blocks 
        WHERE block_id = ? AND deleted_at IS NULL
    ");
    $currentStmt->execute([$blockId]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        Response::error("Block not found.", 404);
    }

    $maxStmt = $pdo->prepare("
        SELECT MAX(row_num) AS max_r, MAX(col_num) AS max_c 
        FROM graves 
        WHERE block_id = ? AND deleted_at IS NULL
    ");
    $maxStmt->execute([$blockId]);
    $max = $maxStmt->fetch(PDO::FETCH_ASSOC);
    $currentMaxRows = (int)($max['max_r'] ?? 0);
    $currentMaxCols = (int)($max['max_c'] ?? 0);
    $hasGraves = ($currentMaxRows > 0 && $currentMaxCols > 0);

    $updates = [];
    $params = [];

    // Rename: always allowed. Grave codes get their prefix rewritten to match.
    if (isset($rawData['block_name'])) {
        $newName = trim($rawData['block_name']);
        if ($newName !== $current['block_name']) {
            $check = $pdo->prepare("
                SELECT block_id FROM blocks 
                WHERE block_name = ? AND block_id != ? AND deleted_at IS NULL
            ");
            $check->execute([$newName, $blockId]);
            if ($check->fetch()) {
                Response::error("Block name already exists.", 409);
            }

            $oldName = $current['block_name'];
            $updates[] = "block_name = ?";
            $params[] = $newName;

            if ($hasGraves) {
                $graveUpdate = $pdo->prepare("
                    UPDATE graves 
                    SET grave_code = CONCAT(?, SUBSTRING(grave_code, ?))
                    WHERE block_id = ? 
                      AND deleted_at IS NULL
                      AND grave_code LIKE ?
                ");
                $graveUpdate->execute([
                    $newName . '-',
                    strlen($oldName) + 1,
                    $blockId,
                    $oldName . '-%',
                ]);
            }
        }
    }

    $allowedFields = ['block_type', 'coordinates', 'coordinates_canvas', 'remarks', 'image_link', 'shape', 'custom'];
    foreach ($allowedFields as $field) {
        if (array_key_exists($field, $rawData)) {
            $updates[] = "$field = ?";
            $params[] = $rawData[$field];
        }
    }

    $newRows = isset($rawData['rows']) ? (int) $rawData['rows'] : null;
    $newCols = isset($rawData['cols']) ? (int) $rawData['cols'] : null;

    if ($newRows !== null) {
        $updates[] = "`rows` = ?";
        $params[] = $newRows;
    }
    if ($newCols !== null) {
        $updates[] = "`cols` = ?";
        $params[] = $newCols;
    }

    if (empty($updates) && $newRows === null && $newCols === null) {
        Response::error("No fields to update.", 400);
    }

    if ($newRows !== null && $newRows < 0) Response::error("rows cannot be negative.", 400);
    if ($newCols !== null && $newCols < 0) Response::error("cols cannot be negative.", 400);

    $maxAllowed = 500;
    if (($newRows !== null && $newRows > $maxAllowed) || ($newCols !== null && $newCols > $maxAllowed)) {
        Response::error("rows and cols cannot exceed $maxAllowed.", 400);
    }

    $targetRows = $newRows ?? $currentMaxRows;
    $targetCols = $newCols ?? $currentMaxCols;
    $gridChanged = ($targetRows != $currentMaxRows || $targetCols != $currentMaxCols);

    $pdo->beginTransaction();
    try {
        if (!empty($updates)) {
            $updates[] = "updated_by = ?";
            $params[] = $userData['user_id'];
            $sql = "UPDATE blocks SET " . implode(', ', $updates) . " WHERE block_id = ? AND deleted_at IS NULL";
            $params[] = $blockId;
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
        }

        if ($gridChanged) {
            if ($targetRows < $currentMaxRows || $targetCols < $currentMaxCols) {
                // Shrink: soft-delete graves outside the new bounds.
                $del = $pdo->prepare("
                    UPDATE graves 
                    SET deleted_at = NOW(), updated_by = ? 
                    WHERE block_id = ? AND (row_num > ? OR col_num > ?) AND deleted_at IS NULL
                ");
                $del->execute([$userData['user_id'], $blockId, $targetRows, $targetCols]);
            }

            if ($targetRows > $currentMaxRows || $targetCols > $currentMaxCols) {
                $nameStmt = $pdo->prepare("SELECT block_name FROM blocks WHERE block_id = ?");
                $nameStmt->execute([$blockId]);
                $blockName = $nameStmt->fetchColumn();

                $values = [];
                $insertParams = [];
                for ($r = 1; $r <= $targetRows; $r++) {
                    for ($c = 1; $c <= $targetCols; $c++) {
                        if ($r > $currentMaxRows || $c > $currentMaxCols) {
                            $code = $blockName . '-' . str_pad($r, 2, '0', STR_PAD_LEFT) . '-' . str_pad($c, 2, '0', STR_PAD_LEFT);
                            $values[] = "(?, ?, ?, ?, 'Vacant')";
                            $insertParams[] = $blockId;
                            $insertParams[] = $code;
                            $insertParams[] = $r;
                            $insertParams[] = $c;
                        }
                    }
                }

                if (!empty($values)) {
                    $insertSql = "INSERT INTO graves (block_id, grave_code, row_num, col_num, status) VALUES " . implode(', ', $values);
                    $insertSql = str_replace("INSERT INTO", "INSERT IGNORE INTO", $insertSql);
                    $insertStmt = $pdo->prepare($insertSql);
                    $insertStmt->execute($insertParams);
                }
            }
        }

        $pdo->commit();
        systemLog("Updated block ID $blockId", $userData['user_id']);
        Response::success("Block updated.");
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Block update error: " . $e->getMessage(), 'System');
        Response::error("Database error while updating block.", 500);
    }
}

// -----------------------------------------------------------------------------
// DELETE
//
// NOTE: The delete guard has been removed. Deleting a block now soft-deletes
// every grave inside it too. The frontend confirms before calling this so a
// stray click can't wipe real burial records.
// -----------------------------------------------------------------------------
if ($method === 'DELETE') {
    if (!is_numeric($resourceId)) {
        Response::error("Block ID required.", 400);
    }
    $blockId = (int) $resourceId;

    $blockCheck = $pdo->prepare("
        SELECT block_id FROM blocks 
        WHERE block_id = ? AND deleted_at IS NULL
    ");
    $blockCheck->execute([$blockId]);
    if (!$blockCheck->fetch()) {
        Response::error("Block not found or already deleted.", 404);
    }

    $pdo->beginTransaction();
    try {
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
        systemLog("Soft‑deleted block ID $blockId and all its graves", $userData['user_id']);
        Response::success("Block and all its graves soft‑deleted.");
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Block deletion error: " . $e->getMessage(), 'System');
        Response::error("Database error while deleting block.", 500);
    }
}

Response::error("Method Not Allowed", 405);