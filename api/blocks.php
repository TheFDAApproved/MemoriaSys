<?php

/**
 * blocks.php – Manage cemetery blocks and their graves
 *
 * GET    : List all blocks (with counts) or get a specific block with its graves (paginated).
 * POST   : Create a new block (with optional grave generation).
 * PUT    : Update block details and adjust the grave grid (expand/shrink).
 * DELETE : Remove a block only if all its graves are vacant and unused.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser(false);
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
$isStaff = in_array($role, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]);
$isAdminOffice = in_array($role, [ROLE_ADMIN, ROLE_OFFICE]);

// Parse path info for resource ID
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// -----------------------------------------------------------------------------
// Helper: Count graves in a block by status
// -----------------------------------------------------------------------------
function getBlockCounts($pdo, $blockId)
{
    $stmt = $pdo->prepare("
        SELECT 
            COUNT(*) AS total,
            SUM(status = 'Vacant') AS vacant,
            SUM(status = 'Occupied') AS occupied
        FROM graves WHERE block_id = ?
    ");
    $stmt->execute([$blockId]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

// -----------------------------------------------------------------------------
// GET – List blocks or block details
// -----------------------------------------------------------------------------
if ($method === 'GET') {
    if (is_numeric($resourceId)) {
        // Fetch specific block with its graves (paginated)
        if ($isStaff) {
            $blockStmt = $pdo->prepare("SELECT * FROM blocks WHERE block_id = ?");
        } else {
            $blockStmt = $pdo->prepare("SELECT block_id, block_name, block_type, coordinates, image_link FROM blocks WHERE block_id = ?");
        }
        $blockStmt->execute([$resourceId]);
        $block = $blockStmt->fetch(PDO::FETCH_ASSOC);
        if (!$block) {
            Response::error("Block not found.", 404);
        }

        // Pagination for graves
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
        $limit = max(1, min($limit, 500));
        $page  = isset($_GET['page']) ? (int) $_GET['page'] : 1;
        $page  = max(1, $page);
        $offset = ($page - 1) * $limit;

        // Count graves in this block
        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM graves WHERE block_id = ?");
        $countStmt->execute([$resourceId]);
        $totalRecords = (int) $countStmt->fetchColumn();
        $totalPages = ceil($totalRecords / $limit);
        $page = min($page, $totalPages ?: 1);
        $offset = ($page - 1) * $limit;

        // Fetch graves (with occupants)
        if ($isStaff) {
            // First get grave IDs for pagination
            $graveIdStmt = $pdo->prepare("
                SELECT grave_id
                FROM graves
                WHERE block_id = ?
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
                        i.interment_id,
                        i.control_number,
                        i.deceased_name,
                        i.last_known_address,
                        i.date_buried,
                        i.lease_expiration_date,
                        i.contact_person_name,
                        i.contact_person_phone_number,
                        i.contact_person_email,
                        i.contact_person_address
                    FROM graves g
                    LEFT JOIN interments i ON g.grave_id = i.current_grave_id AND i.status = 'Active'
                    WHERE g.grave_id IN ($placeholders)
                    ORDER BY g.row_num, g.col_num, i.interment_id
                ";
                $graveStmt = $pdo->prepare($graveSql);
                $graveStmt->execute($graveIds);
                $rows = $graveStmt->fetchAll(PDO::FETCH_ASSOC);

                // Group by grave_id
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
            // Public: only non-sensitive grave fields
            $graveSql = "
                SELECT grave_id, grave_code, row_num, col_num, status
                FROM graves
                WHERE block_id = ?
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
        // List all blocks – role‑based columns
        if ($isStaff) {
            $sql = "
                SELECT b.*,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id) AS total_graves,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Vacant') AS vacant,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Occupied') AS occupied
                FROM blocks b
                ORDER BY b.block_id
            ";
        } else {
            // Public: include image_link
            $sql = "
                SELECT 
                    b.block_id, b.block_name, b.block_type, b.coordinates, b.image_link,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id) AS total_graves,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Vacant') AS vacant,
                    (SELECT COUNT(*) FROM graves WHERE block_id = b.block_id AND status = 'Occupied') AS occupied
                FROM blocks b
                ORDER BY b.block_id
            ";
        }
        $stmt = $pdo->query($sql);
        $blocks = $stmt->fetchAll(PDO::FETCH_ASSOC);
        Response::success("Blocks retrieved.", $blocks);
    }
}

if (!$isAdminOffice) {
    Response::error("Forbidden.", 403);
}

// -----------------------------------------------------------------------------
// POST – Create a new block
// -----------------------------------------------------------------------------
if ($method === 'POST') {

    if (empty($rawData['block_name']) || empty($rawData['block_type'])) {
        Response::error("block_name and block_type are required.", 400);
    }
    $blockName = trim($rawData['block_name']);
    $blockType = trim($rawData['block_type']);
    $coordinates = $rawData['coordinates'] ?? null;
    $remarks = trim($rawData['remarks'] ?? '');
    $image_link = trim($rawData['image_link'] ?? '');

    $validTypes = ['Niche', 'Bone Chamber', 'Lawn/Grounds', 'Unmapped Area', 'Private', 'Mausoleum', 'Mass Grave', 'Cluster', 'Block'];
    if (!in_array($blockType, $validTypes)) {
        Response::error("Invalid block_type. Allowed: " . implode(', ', $validTypes), 400);
    }

    $check = $pdo->prepare("SELECT block_id FROM blocks WHERE block_name = ?");
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
            INSERT INTO blocks (block_name, block_type, coordinates, remarks, image_link)
            VALUES (?, ?, ?, ?, ?)
        ");
        $stmt->execute([$blockName, $blockType, $coordinates, $remarks, $image_link]);
        $blockId = $pdo->lastInsertId();

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
        systemLog("Created new block ID $blockId: $blockName", $userData['user_id']);
        Response::success("Block created.", ['block_id' => $blockId], 201);
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Block creation error: " . $e->getMessage(), 'System');
        Response::error("Database error while creating block.", 500);
    }
}

// -----------------------------------------------------------------------------
// PUT – Update a block
// -----------------------------------------------------------------------------
if ($method === 'PUT') {

    if (!is_numeric($resourceId)) {
        Response::error("Block ID required.", 400);
    }
    $blockId = (int) $resourceId;

    $currentStmt = $pdo->prepare("SELECT * FROM blocks WHERE block_id = ?");
    $currentStmt->execute([$blockId]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        Response::error("Block not found.", 404);
    }

    $graveCountStmt = $pdo->prepare("SELECT COUNT(*) FROM graves WHERE block_id = ?");
    $graveCountStmt->execute([$blockId]);
    $hasGraves = (int) $graveCountStmt->fetchColumn() > 0;

    $updates = [];
    $params = [];

    $allowedFields = ['block_type', 'coordinates', 'remarks', 'image_link'];
    foreach ($allowedFields as $field) {
        if (array_key_exists($field, $rawData)) {
            $updates[] = "$field = ?";
            $params[] = $rawData[$field];
        }
    }

    // ---------- BLOCK_NAME HANDLING (FIX) ----------
    if (isset($rawData['block_name'])) {
        $newName = trim($rawData['block_name']);
        $currentName = $current['block_name'];

        // Only treat as a change if the name actually differs.
        if ($newName !== $currentName) {
            // Prevent renaming if graves exist (because grave codes embed the block name)
            if ($hasGraves) {
                Response::error("Cannot change block_name because the block already has graves.", 400);
            }
            // Ensure the new name is unique
            $check = $pdo->prepare("SELECT block_id FROM blocks WHERE block_name = ? AND block_id != ?");
            $check->execute([$newName, $blockId]);
            if ($check->fetch()) {
                Response::error("Block name already exists.", 409);
            }
            $updates[] = "block_name = ?";
            $params[] = $newName;
        }
        // If name is unchanged, do nothing – no error, no update.
    }
    // -------------------------------------------------

    if (empty($updates) && !isset($rawData['rows']) && !isset($rawData['cols'])) {
        Response::error("No fields to update.", 400);
    }

    $newRows = isset($rawData['rows']) ? (int) $rawData['rows'] : null;
    $newCols = isset($rawData['cols']) ? (int) $rawData['cols'] : null;

    $pdo->beginTransaction();
    try {
        if (!empty($updates)) {
            $sql = "UPDATE blocks SET " . implode(', ', $updates) . " WHERE block_id = ?";
            $params[] = $blockId;
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
        }

        if ($newRows !== null || $newCols !== null) {
            $maxStmt = $pdo->prepare("SELECT MAX(row_num) AS max_r, MAX(col_num) AS max_c FROM graves WHERE block_id = ?");
            $maxStmt->execute([$blockId]);
            $max = $maxStmt->fetch(PDO::FETCH_ASSOC);
            $currentMaxRows = $max['max_r'] ?? 0;
            $currentMaxCols = $max['max_c'] ?? 0;

            $targetRows = $newRows ?? $currentMaxRows;
            $targetCols = $newCols ?? $currentMaxCols;

            if ($targetRows < 1 || $targetCols < 1) {
                $pdo->rollBack();
                Response::error("rows and cols must be at least 1 if provided.", 400);
            }

            // Shrink
            if ($targetRows < $currentMaxRows || $targetCols < $currentMaxCols) {
                $removeCheck = $pdo->prepare("
                    SELECT grave_id FROM graves 
                    WHERE block_id = ? 
                      AND (row_num > ? OR col_num > ?)
                ");
                $removeCheck->execute([$blockId, $targetRows, $targetCols]);
                $removedIds = $removeCheck->fetchAll(PDO::FETCH_COLUMN);

                if (!empty($removedIds)) {
                    $placeholders = implode(',', array_fill(0, count($removedIds), '?'));
                    $activeCheck = $pdo->prepare("
                        SELECT 1 FROM interments 
                        WHERE current_grave_id IN ($placeholders) AND status = 'Active' LIMIT 1
                    ");
                    $activeCheck->execute($removedIds);
                    if ($activeCheck->fetch()) {
                        $pdo->rollBack();
                        Response::error("Cannot shrink block: some graves to be removed are occupied.", 400);
                    }
                    $delete = $pdo->prepare("DELETE FROM graves WHERE block_id = ? AND (row_num > ? OR col_num > ?)");
                    $delete->execute([$blockId, $targetRows, $targetCols]);
                }
            }

            // Expand
            if ($targetRows > $currentMaxRows || $targetCols > $currentMaxCols) {
                // Fetch the (possibly updated) block name for new grave codes
                $nameStmt = $pdo->prepare("SELECT block_name FROM blocks WHERE block_id = ?");
                $nameStmt->execute([$blockId]);
                $blockName = $nameStmt->fetchColumn();

                $insertSql = "INSERT INTO graves (block_id, grave_code, row_num, col_num, status)
                              SELECT ?, ?, ?, ?, 'Vacant'
                              WHERE NOT EXISTS (
                                  SELECT 1 FROM graves 
                                  WHERE block_id = ? AND row_num = ? AND col_num = ?
                              )";
                $insertStmt = $pdo->prepare($insertSql);
                for ($r = 1; $r <= $targetRows; $r++) {
                    for ($c = 1; $c <= $targetCols; $c++) {
                        if ($r > $currentMaxRows || $c > $currentMaxCols) {
                            $code = $blockName . '-' . str_pad($r, 2, '0', STR_PAD_LEFT) . '-' . str_pad($c, 2, '0', STR_PAD_LEFT);
                            $insertStmt->execute([$blockId, $code, $r, $c, $blockId, $r, $c]);
                        }
                    }
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
// DELETE – Remove a block (only if all graves are vacant and unused)
// -----------------------------------------------------------------------------
if ($method === 'DELETE') {
    if (!is_numeric($resourceId)) {
        Response::error("Block ID required.", 400);
    }
    $blockId = (int) $resourceId;

    // Check if block exists
    $blockCheck = $pdo->prepare("SELECT block_id FROM blocks WHERE block_id = ?");
    $blockCheck->execute([$blockId]);
    if (!$blockCheck->fetch()) {
        Response::error("Block not found.", 404);
    }

    // Check for non-vacant graves OR any interment referencing any grave in the block
    $checkSql = "
        SELECT 
            (SELECT COUNT(*) FROM graves WHERE block_id = ? AND status != 'Vacant') AS non_vacant_count,
            (SELECT COUNT(*) FROM interments 
             WHERE current_grave_id IN (SELECT grave_id FROM graves WHERE block_id = ?)
                OR transfer_to_grave IN (SELECT grave_id FROM graves WHERE block_id = ?)
            ) AS interment_count
    ";
    $checkStmt = $pdo->prepare($checkSql);
    $checkStmt->execute([$blockId, $blockId, $blockId]);
    $result = $checkStmt->fetch(PDO::FETCH_ASSOC);

    if ($result['non_vacant_count'] > 0) {
        Response::error("Cannot delete block: it contains " . $result['non_vacant_count'] . " grave(s) that are not vacant.", 400);
    }
    if ($result['interment_count'] > 0) {
        Response::error("Cannot delete block: some graves have associated interment records (active, pending, or inactive).", 400);
    }

    // Proceed: delete all graves first, then the block
    $pdo->beginTransaction();
    try {
        $delGraves = $pdo->prepare("DELETE FROM graves WHERE block_id = ?");
        $delGraves->execute([$blockId]);

        $delBlock = $pdo->prepare("DELETE FROM blocks WHERE block_id = ?");
        $delBlock->execute([$blockId]);

        $pdo->commit();
        systemLog("Deleted block ID $blockId and all its graves", $userData['user_id']);
        Response::success("Block and all its graves permanently deleted.");
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Block deletion error: " . $e->getMessage(), 'System');
        Response::error("Database error while deleting block.", 500);
    }
}

// -----------------------------------------------------------------------------
// Method not allowed
// -----------------------------------------------------------------------------
Response::error("Method Not Allowed", 405);
