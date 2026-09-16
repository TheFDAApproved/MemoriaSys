<?php

/**
 * graves.php – Manage individual graves within a block
 *
 * GET  : List graves (filter by block_id) or get a specific grave with its occupants.
 * PUT  : Update a grave's row, col, status, or remarks.
 *       All operations exclude soft‑deleted records (deleted_at IS NOT NULL).
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser(false);
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
$isStaff = in_array($role, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]);
$isAdminOffice = in_array($role, [ROLE_ADMIN, ROLE_OFFICE]);

// Parse path info: /graves.php/{id}
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// -----------------------------------------------------------------------------
// GET – List graves or a single grave
// -----------------------------------------------------------------------------
if ($method === 'GET') {
    // If resourceId is numeric, fetch that specific grave with all occupants
    if (is_numeric($resourceId)) {
        $graveId = (int) $resourceId;
        if ($isStaff) {
            $sql = "
                SELECT 
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status, g.remarks,
                    b.block_id, b.block_name, b.block_type,
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
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                LEFT JOIN interments i ON g.grave_id = i.current_grave_id AND i.status = 'Active' AND i.deleted_at IS NULL
                WHERE g.grave_id = ? AND g.deleted_at IS NULL
                ORDER BY i.interment_id
            ";
        } else {
            // Public: only non‑sensitive fields, no interments
            $sql = "
                SELECT 
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status,
                    b.block_id, b.block_name
                FROM graves g
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                WHERE g.grave_id = ? AND g.deleted_at IS NULL
            ";
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$graveId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (empty($rows)) {
            Response::error("Grave not found.", 404);
        }

        if ($isStaff) {
            // Build grave object with occupants
            $grave = null;
            $occupants = [];
            foreach ($rows as $row) {
                if (!$grave) {
                    $grave = [
                        'grave_id' => $row['grave_id'],
                        'grave_code' => $row['grave_code'],
                        'row_num' => $row['row_num'],
                        'col_num' => $row['col_num'],
                        'status' => $row['status'],
                        'remarks' => $row['remarks'],
                        'block_id' => $row['block_id'],
                        'block_name' => $row['block_name'],
                        'block_type' => $row['block_type'],
                    ];
                }
                if ($row['interment_id']) {
                    $occupants[] = [
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
            $grave['occupants'] = $occupants;
            // Keep primary occupant fields for backward compatibility (first occupant)
            if (!empty($occupants)) {
                $first = $occupants[0];
                $grave['occupant_interment_id'] = $first['interment_id'];
                $grave['occupant_control_number'] = $first['control_number'];
                $grave['occupant_deceased_name'] = $first['deceased_name'];
                $grave['occupant_last_known_address'] = $first['last_known_address'];
                $grave['occupant_date_buried'] = $first['date_buried'];
                $grave['occupant_lease_expiration'] = $first['lease_expiration_date'];
                $grave['occupant_contact_name'] = $first['contact_person_name'];
                $grave['occupant_contact_phone'] = $first['contact_person_phone_number'];
                $grave['occupant_contact_email'] = $first['contact_person_email'];
                $grave['occupant_contact_address'] = $first['contact_person_address'];
            } else {
                $grave['occupant_interment_id'] = null;
                $grave['occupant_control_number'] = null;
                $grave['occupant_deceased_name'] = null;
                $grave['occupant_last_known_address'] = null;
                $grave['occupant_date_buried'] = null;
                $grave['occupant_lease_expiration'] = null;
                $grave['occupant_contact_name'] = null;
                $grave['occupant_contact_phone'] = null;
                $grave['occupant_contact_email'] = null;
                $grave['occupant_contact_address'] = null;
            }
            Response::success("Grave retrieved.", ['grave' => $grave]);
        } else {
            // Public: just the first row (no interments)
            Response::success("Grave retrieved.", ['grave' => $rows[0]]);
        }
    }

    // List all graves (with optional block_id filter, search, status, pagination).
    // Only active (non-deleted) graves are considered.

    // ---- Inputs ----
    $blockId    = isset($_GET['block_id']) ? (int) $_GET['block_id'] : null;
    $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
    if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
        Response::error("Search term must be at least 3 characters long", 400);
    }

    $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
    $page  = max(1, (int) ($_GET['page'] ?? 1));

    // ---- Status filter (vacant | occupied, comma-separated) ----
    $statusRaw = $_GET['status'] ?? '';
    if (is_array($statusRaw)) {
        $statusRaw = implode(',', $statusRaw);
    }
    $statusFilter    = strtolower(trim((string) $statusRaw));
    $allowedStatuses = ['vacant', 'occupied'];
    $wantedStatuses  = [];

    if ($statusFilter !== '') {
        foreach (explode(',', $statusFilter) as $s) {
            $s = trim($s);
            if (!in_array($s, $allowedStatuses, true)) {
                Response::error("Invalid status '$s'. Allowed: vacant, occupied.", 400);
            }
            if (!in_array($s, $wantedStatuses, true)) {
                $wantedStatuses[] = $s;
            }
        }
    }

    // ---- Build WHERE + params ----
    $where  = "g.deleted_at IS NULL";
    $params = [];

    if ($blockId) {
        $where .= " AND g.block_id = ?";
        $params[] = $blockId;
    }

    if (!empty($wantedStatuses)) {
        // DB enum values are capitalised ('Vacant', 'Occupied')
        $dbStatuses = array_map(fn($s) => ucfirst($s), $wantedStatuses);
        $ph = implode(',', array_fill(0, count($dbStatuses), '?'));
        $where .= " AND g.status IN ($ph)";
        foreach ($dbStatuses as $s) {
            $params[] = $s;
        }
    }

    if ($searchTerm !== '') {
        $like = '%' . $searchTerm . '%';

        // Fields every role can search on
        $parts = [
            'g.grave_code LIKE ?',
            'b.block_name LIKE ?',
            'b.block_type LIKE ?',
        ];
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;

        // Staff-only fields (remarks + occupant details)
        if ($isStaff) {
            $parts[] = 'g.remarks LIKE ?';
            $params[] = $like;

            $parts[] = "EXISTS (
                SELECT 1 FROM interments i2
                WHERE i2.current_grave_id = g.grave_id
                  AND i2.status = 'Active'
                  AND i2.deleted_at IS NULL
                  AND (
                      i2.control_number              LIKE ? OR
                      i2.deceased_name               LIKE ? OR
                      i2.contact_person_name         LIKE ? OR
                      i2.contact_person_phone_number LIKE ? OR
                      i2.contact_person_email        LIKE ?
                  )
            )";
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
        }

        $where .= ' AND (' . implode(' OR ', $parts) . ')';
    }

    // ---- COUNT matching graves (no occupant fan-out) ----
    $countSql = "
        SELECT COUNT(*)
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE $where
    ";
    $countStmt = $pdo->prepare($countSql);
    $countStmt->execute($params);
    $totalRecords = (int) $countStmt->fetchColumn();

    $totalPages = (int) ceil($totalRecords / $limit);
    $page       = min($page, max(1, $totalPages));
    $offset     = ($page - 1) * $limit;

    // ---- Step 1: paged grave IDs (stable order = same as the old ORDER BY) ----
    // $limit / $offset are strict ints → safe to interpolate.
    $idsSql = "
        SELECT g.grave_id
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE $where
        ORDER BY g.block_id, g.row_num, g.col_num
        LIMIT $limit OFFSET $offset
    ";
    $idsStmt = $pdo->prepare($idsSql);
    $idsStmt->execute($params);
    $graveIds = $idsStmt->fetchAll(PDO::FETCH_COLUMN);

    // ---- Step 2: fetch full data for those IDs ----
    $graves = [];
    if (!empty($graveIds)) {
        $placeholders = implode(',', array_fill(0, count($graveIds), '?'));

        if ($isStaff) {
            $sql = "
                SELECT
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status, g.remarks,
                    b.block_id, b.block_name, b.block_type,
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
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                LEFT JOIN interments i
                    ON g.grave_id = i.current_grave_id
                    AND i.status = 'Active'
                    AND i.deleted_at IS NULL
                WHERE g.grave_id IN ($placeholders)
                ORDER BY g.block_id, g.row_num, g.col_num, i.interment_id
            ";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($graveIds);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Group by grave_id
            $gravesMap = [];
            foreach ($rows as $row) {
                $gid = $row['grave_id'];
                if (!isset($gravesMap[$gid])) {
                    $gravesMap[$gid] = [
                        'grave_id'   => $row['grave_id'],
                        'grave_code' => $row['grave_code'],
                        'row_num'    => $row['row_num'],
                        'col_num'    => $row['col_num'],
                        'status'     => $row['status'],
                        'remarks'    => $row['remarks'],
                        'block_id'   => $row['block_id'],
                        'block_name' => $row['block_name'],
                        'block_type' => $row['block_type'],
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
                        'lease_expiration_date'       => $row['lease_expiration_date'],
                        'contact_person_name'         => $row['contact_person_name'],
                        'contact_person_phone_number' => $row['contact_person_phone_number'],
                        'contact_person_email'        => $row['contact_person_email'],
                        'contact_person_address'      => $row['contact_person_address'],
                    ];
                }
            }

            // Preserve the page-1 order (block_id, row, col)
            foreach ($graveIds as $gid) {
                if (isset($gravesMap[$gid])) {
                    $graves[] = $gravesMap[$gid];
                }
            }
        } else {
            // Public: no interments, no remarks
            $sql = "
                SELECT
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status,
                    b.block_id, b.block_name
                FROM graves g
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                WHERE g.grave_id IN ($placeholders)
                ORDER BY g.block_id, g.row_num, g.col_num
            ";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($graveIds);
            $graves = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
    }

    // ---- Response ----
    $payload = [
        'pagination' => [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ],
        'graves' => $graves,
    ];
    if ($searchTerm !== '') {
        $payload['search_term'] = $searchTerm;
    }
    if (!empty($wantedStatuses)) {
        $payload['status'] = implode(',', $wantedStatuses);
    }

    Response::success("Graves retrieved.", $payload);
}

// -----------------------------------------------------------------------------
// PUT – Update a single grave (only Admin/Office)
// -----------------------------------------------------------------------------
if (!$isAdminOffice) {
    Response::error("Forbidden. Only Admin and Office can update graves.", 403);
}

if ($method === 'PUT') {

    if (!is_numeric($resourceId)) {
        Response::error("Grave ID required.", 400);
    }
    $graveId = (int) $resourceId;

    // Fetch current grave data (only if not deleted)
    $currentStmt = $pdo->prepare("
        SELECT g.*, b.block_id AS block_id 
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE g.grave_id = ? AND g.deleted_at IS NULL
    ");
    $currentStmt->execute([$graveId]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        Response::error("Grave not found.", 404);
    }

    // Build update fields
    $updates = [];
    $params = [];
    $allowedFields = ['row_num', 'col_num', 'status', 'remarks'];
    foreach ($allowedFields as $field) {
        if (array_key_exists($field, $rawData)) {
            $updates[] = "$field = ?";
            $params[] = $rawData[$field];
        }
    }

    if (empty($updates)) {
        Response::error("No fields to update.", 400);
    }

    // --- Validation ---
    $newStatus = $rawData['status'] ?? $current['status'];

    // 1. If status is being changed to 'Vacant', ensure no active interment exists on this grave (and interment is not deleted)
    if ($newStatus === 'Vacant') {
        $interCheck = $pdo->prepare("
            SELECT interment_id FROM interments 
            WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL
        ");
        $interCheck->execute([$graveId]);
        if ($interCheck->fetch()) {
            Response::error("Cannot set grave to Vacant: it has an active interment.", 400);
        }
    }

    // 2. (Removed) – Occupied status can now be set without an active interment.
    //     Use remarks to explain why (e.g., maintenance, reserved, etc.).

    // 3. If row_num or col_num are being changed, ensure the new coordinates are unique within the block
    //    (and only consider non-deleted graves)
    if (isset($rawData['row_num']) || isset($rawData['col_num'])) {
        $newRow = isset($rawData['row_num']) ? (int) $rawData['row_num'] : (int) $current['row_num'];
        $newCol = isset($rawData['col_num']) ? (int) $rawData['col_num'] : (int) $current['col_num'];
        // Check if another grave in the same block already has these coordinates (excluding itself, and excluding deleted graves)
        $dupCheck = $pdo->prepare("
            SELECT grave_id FROM graves 
            WHERE block_id = ? AND row_num = ? AND col_num = ? AND grave_id != ? AND deleted_at IS NULL
        ");
        $dupCheck->execute([$current['block_id'], $newRow, $newCol, $graveId]);
        if ($dupCheck->fetch()) {
            Response::error("Another grave already exists with row_num=$newRow and col_num=$newCol in this block.", 400);
        }
    }

    // Add updated_by to the update list
    $updates[] = "updated_by = ?";
    $params[] = $userData['user_id'];
    // updated_at will auto-update via ON UPDATE CURRENT_TIMESTAMP

    // Execute update (only if not deleted – we already checked)
    $sql = "UPDATE graves SET " . implode(', ', $updates) . " WHERE grave_id = ? AND deleted_at IS NULL";
    $params[] = $graveId;
    $stmt = $pdo->prepare($sql);
    try {
        $stmt->execute($params);
        systemLog("Updated grave ID $graveId", $userData['user_id']);
        Response::success("Grave updated.");
    } catch (PDOException $e) {
        systemLog("Grave update error: " . $e->getMessage(), 'System');
        Response::error("Database error while updating grave.", 500);
    }
}

// -----------------------------------------------------------------------------
// Method not allowed
// -----------------------------------------------------------------------------
Response::error("Method Not Allowed", 405);
