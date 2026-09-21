<?php

/**
 * Records.php – Full CRUD for interments (Master Admin Editor)
 * 
 * This version ALLOWS multiple Active interments on the same grave (co‑interment).
 * It does NOT enforce grave.status = 'Vacant' for Active interments.
 * Grave status changes are left to the admin/front‑end.
 * 
 * GET    /records.php      : List all interments (paginated, filterable)
 * GET    /records.php/{id} : Get details of a specific interment by ID
 * POST   /records.php      : Create a new interment manually
 * PUT    /records.php/{id} : Update an interment manually (any field)
 * DELETE /records.php/{id} : Soft‑delete an interment (only if not active)
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

// Only Admin and Office can manage records
$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE])) {
    Response::error("Forbidden. You do not have permission.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// Parse path: /records.php/{id}
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

// -----------------------------------------------------------------------------
// Helper function: Format an interment record with block & grave details
// -----------------------------------------------------------------------------
function formatInterment($row)
{
    return [
        'interment_id'               => (int) $row['interment_id'],
        'control_number'             => $row['control_number'],
        'deceased_name'              => $row['deceased_name'],
        'deceased_sex'               => $row['deceased_sex'],
        'last_known_address'         => $row['last_known_address'],
        'death_certificate'          => $row['death_certificate'],
        'deceased_date_of_birth'     => $row['deceased_date_of_birth'],
        'deceased_date_of_death'     => $row['deceased_date_of_death'],

        // Grave References
        'current_grave_id'           => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,
        'transfer_to_grave'          => $row['transfer_to_grave'] ? (int) $row['transfer_to_grave'] : null,

        // Joined Current Grave Details
        'grave_code'                 => $row['grave_code'],
        'row_num'                    => $row['row_num'] ? (int) $row['row_num'] : null,
        'col_num'                    => $row['col_num'] ? (int) $row['col_num'] : null,
        'grave_status'               => $row['grave_status'],
        'grave_remarks'              => $row['grave_remarks'],
        'block_id'                   => $row['block_id'] ? (int) $row['block_id'] : null,
        'block_name'                 => $row['block_name'],
        'block_type'                 => $row['block_type'],

        // Contact Person
        'contact_person_name'        => $row['contact_person_name'],
        'contact_person_phone_number' => $row['contact_person_phone_number'],
        'contact_person_email'       => $row['contact_person_email'],
        'contact_person_address'     => $row['contact_person_address'],
        'contact_person_address_barangay' => $row['contact_person_address_barangay'],

        // Logistics & Permits
        'assistance_type'            => $row['assistance_type'],
        'burial_permit_number'       => $row['burial_permit_number'],
        'burial_permit_date'         => $row['burial_permit_date'],
        'transfer_permit_number'     => $row['transfer_permit_number'],
        'transfer_permit_issued_by'  => $row['transfer_permit_issued_by'],
        'transfer_permit_date'       => $row['transfer_permit_date'],
        'exhumation_permit_number'   => $row['exhumation_permit_number'],
        'exhumation_permit_date'     => $row['exhumation_permit_date'],

        // Timeline & Status
        'date_buried'                => $row['date_buried'],
        'date_exhumed'               => $row['date_exhumed'],
        'burial_clearance_date'      => $row['burial_clearance_date'],
        'lease_expiration_date'      => $row['lease_expiration_date'],
        'status'                     => $row['status'],
        'remarks'                    => $row['remarks'],
    ];
}

// Build the base SELECT with joins (joining on current physical location)
function getIntermentSelectSQL()
{
    return "
        SELECT 
            i.*,
            g.grave_code,
            g.row_num,
            g.col_num,
            g.status AS grave_status,
            g.remarks AS grave_remarks,
            b.block_id,
            b.block_name,
            b.block_type
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
    ";
}

// -----------------------------------------------------------------------------
// GET – List interments (with history flattened) or Get a specific one
// -----------------------------------------------------------------------------
if ($method === 'GET') {

    /**
     * Helper: Build a flat list of interments (current + history) for ONE ID.
     * Used by Scenario A only. Efficient because it scopes to a single interment.
     */
    $buildFlatList = function ($filterId) use ($pdo) {
        $sql = getIntermentSelectSQL() . " WHERE i.deleted_at IS NULL AND i.interment_id = :id
                                          ORDER BY i.interment_id DESC";
        $stmt = $pdo->prepare($sql);
        $stmt->execute(['id' => $filterId]);
        $baseRows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $intermentMap = [];
        foreach ($baseRows as $row) {
            $formatted = formatInterment($row);
            $formatted['is_history'] = false;
            $intermentMap[$row['interment_id']] = $formatted;
        }

        if (empty($intermentMap)) {
            return [];
        }

        $ids = array_keys($intermentMap);
        $placeholders = implode(',', array_fill(0, count($ids), '?'));

        $historySql = "
            SELECT
                tl.interment_id,
                tl.transfer_date,
                tl.reason,
                tg.grave_id   AS history_grave_id,
                tg.grave_code AS history_grave_code,
                tg.row_num    AS history_row_num,
                tg.col_num    AS history_col_num,
                tg.status     AS history_grave_status,
                tg.remarks    AS history_grave_remarks,
                b.block_id    AS history_block_id,
                b.block_name  AS history_block_name,
                b.block_type  AS history_block_type
            FROM transfer_log tl
            LEFT JOIN graves tg ON tl.from_grave_id = tg.grave_id
            LEFT JOIN blocks b  ON tg.block_id      = b.block_id
            WHERE tl.interment_id IN ($placeholders)
              AND tl.from_grave_id IS NOT NULL
            ORDER BY tl.transfer_date DESC
        ";
        $histStmt = $pdo->prepare($historySql);
        $histStmt->execute($ids);
        $historyLogs = $histStmt->fetchAll(PDO::FETCH_ASSOC);

        $flatList = array_values($intermentMap);

        foreach ($historyLogs as $log) {
            $intermentId = $log['interment_id'];
            if (!isset($intermentMap[$intermentId])) {
                continue;
            }

            $historyRow = $intermentMap[$intermentId];
            $historyRow['is_history'] = true;

            $historyRow['deceased_name']   = "[History " . $log['transfer_date'] . "] " . $historyRow['deceased_name'];
            $historyRow['current_grave_id'] = $log['history_grave_id'] ? (int) $log['history_grave_id'] : null;
            $historyRow['grave_code']      = $log['history_grave_code'];
            $historyRow['row_num']         = $log['history_row_num'] ? (int) $log['history_row_num'] : null;
            $historyRow['col_num']         = $log['history_col_num'] ? (int) $log['history_col_num'] : null;
            $historyRow['grave_status']    = $log['history_grave_status'];
            $historyRow['grave_remarks']   = $log['history_grave_remarks'];
            $historyRow['block_id']        = $log['history_block_id'] ? (int) $log['history_block_id'] : null;
            $historyRow['block_name']      = $log['history_block_name'];
            $historyRow['block_type']      = $log['history_block_type'];
            $historyRow['transfer_date']   = $log['transfer_date'];
            $historyRow['remarks']         = "Moved on {$log['transfer_date']}. Reason: {$log['reason']}. " . ($historyRow['remarks'] ?? '');

            $flatList[] = $historyRow;
        }

        usort($flatList, function ($a, $b) {
            if ($a['interment_id'] != $b['interment_id']) {
                return $b['interment_id'] - $a['interment_id'];
            }
            return $a['is_history'] ? 1 : -1;
        });

        return $flatList;
    };

    // --- Scenario A: specific resource /records.php/{id} ---
    if ($resourceId) {
        $flatList = $buildFlatList($resourceId);

        if (empty($flatList)) {
            Response::error('Interment not found.', 404);
        }

        Response::success('Interment retrieved', [
            'history_included' => true,
            'interments'       => $flatList,
        ]);
    }

    // --- Scenario B: collection /records.php ---
    else {
        // ---- Inputs ----
        $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
        $page  = max(1, (int) ($_GET['page'] ?? 1));

        // ---- Build search clauses (current branch: aliases i/g/b; history: i/tg/b/tl) ----
        $searchSQLCurrent = '';
        $searchSQLHistory = '';
        $searchParams     = [];

        if ($searchTerm !== '') {
            $like = '%' . $searchTerm . '%';

            $currentSearchCols = [
                'i.control_number',
                'i.deceased_name',
                'i.deceased_sex',
                'i.last_known_address',
                'i.death_certificate',
                'i.contact_person_name',
                'i.contact_person_phone_number',
                'i.contact_person_email',
                'i.contact_person_address',
                'i.contact_person_address_barangay',
                'i.assistance_type',
                'i.burial_permit_number',
                'i.transfer_permit_number',
                'i.transfer_permit_issued_by',
                'i.exhumation_permit_number',
                'i.status',
                'i.remarks',
                'g.grave_code',
                'b.block_name',
                'b.block_type',
            ];

            // For history we ALSO search:
            //   - tl.transfer_date (so searching a date works)
            //   - the display strings the API actually emits:
            //       "[History <date>] <name>"
            //       "Moved on <date>. Reason: <reason>. <remarks>"
            $historySearchCols = [
                'i.control_number',
                'i.deceased_name',
                'i.deceased_sex',
                'i.last_known_address',
                'i.death_certificate',
                'i.contact_person_name',
                'i.contact_person_phone_number',
                'i.contact_person_email',
                'i.contact_person_address',
                'i.contact_person_address_barangay',
                'i.assistance_type',
                'i.burial_permit_number',
                'i.transfer_permit_number',
                'i.transfer_permit_issued_by',
                'i.exhumation_permit_number',
                'i.status',
                'i.remarks',
                'tg.grave_code',
                'b.block_name',
                'b.block_type',
                'tl.reason',
                'tl.transfer_date',
            ];

            $cp = [];
            foreach ($currentSearchCols as $c) {
                $cp[] = "$c LIKE ?";
                $searchParams[] = $like;
            }
            $searchSQLCurrent = ' AND (' . implode(' OR ', $cp) . ')';

            $hp = [];
            foreach ($historySearchCols as $c) {
                $hp[] = "$c LIKE ?";
                $searchParams[] = $like;
            }

            // Extra: match against the *computed* strings shown in JSON.
            $hp[] = "CONCAT('[History ', COALESCE(tl.transfer_date, ''), '] ', COALESCE(i.deceased_name, '')) LIKE ?";
            $searchParams[] = $like;

            $hp[] = "CONCAT('Moved on ', COALESCE(tl.transfer_date, ''), '. Reason: ', COALESCE(tl.reason, ''), '. ', COALESCE(i.remarks, '')) LIKE ?";
            $searchParams[] = $like;

            $searchSQLHistory = ' AND (' . implode(' OR ', $hp) . ')';
        }

        // ---- Current branch (is_history = 0) ----
        $currentSQL = "
            SELECT
                i.interment_id, 0 AS is_history,
                i.control_number, i.deceased_name, i.deceased_sex,
                i.last_known_address, i.death_certificate,
                i.deceased_date_of_birth, i.deceased_date_of_death,
                i.current_grave_id, i.transfer_to_grave,
                i.contact_person_name, i.contact_person_phone_number,
                i.contact_person_email, i.contact_person_address, i.contact_person_address_barangay,
                i.assistance_type, i.burial_permit_number, i.burial_permit_date,
                i.transfer_permit_number, i.transfer_permit_issued_by, i.transfer_permit_date,
                i.exhumation_permit_number, i.exhumation_permit_date,
                i.date_buried, i.date_exhumed, i.burial_clearance_date,
                i.lease_expiration_date, i.status, i.remarks,
                g.grave_code, g.row_num, g.col_num,
                g.status AS grave_status, g.remarks AS grave_remarks,
                b.block_id, b.block_name, b.block_type,
                NULL AS transfer_date
            FROM interments i
            LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
            LEFT JOIN blocks b ON g.block_id          = b.block_id AND b.deleted_at IS NULL
            WHERE i.deleted_at IS NULL
            $searchSQLCurrent
        ";

        // ---- History branch (is_history = 1) ----
        $historySQL = "
            SELECT
                i.interment_id, 1 AS is_history,
                i.control_number, i.deceased_name, i.deceased_sex,
                i.last_known_address, i.death_certificate,
                i.deceased_date_of_birth, i.deceased_date_of_death,
                tg.grave_id AS current_grave_id, i.transfer_to_grave,
                i.contact_person_name, i.contact_person_phone_number,
                i.contact_person_email, i.contact_person_address, i.contact_person_address_barangay,
                i.assistance_type, i.burial_permit_number, i.burial_permit_date,
                i.transfer_permit_number, i.transfer_permit_issued_by, i.transfer_permit_date,
                i.exhumation_permit_number, i.exhumation_permit_date,
                i.date_buried, i.date_exhumed, i.burial_clearance_date,
                i.lease_expiration_date, i.status,
                CONCAT('Moved on ', tl.transfer_date, '. Reason: ',
                       COALESCE(tl.reason, ''), '. ', COALESCE(i.remarks, '')) AS remarks,
                tg.grave_code, tg.row_num, tg.col_num,
                tg.status AS grave_status, tg.remarks AS grave_remarks,
                b.block_id, b.block_name, b.block_type,
                tl.transfer_date
            FROM transfer_log tl
            INNER JOIN interments i ON tl.interment_id = i.interment_id AND i.deleted_at IS NULL
            LEFT  JOIN graves tg    ON tl.from_grave_id = tg.grave_id
            LEFT  JOIN blocks b     ON tg.block_id      = b.block_id
            WHERE tl.from_grave_id IS NOT NULL
            $searchSQLHistory
        ";

        // ---- Union (note the outer parens around the WHOLE union) ----
        $unionSQL = "($currentSQL) UNION ALL ($historySQL)";

        // ---- COUNT (filtered) ----
        // Wrapped in outer parens so the alias attaches to the union, not just the 2nd branch.
        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($unionSQL) AS combined");
        $countStmt->execute($searchParams);
        $totalRecords = (int) $countStmt->fetchColumn();

        $totalPages = (int) ceil($totalRecords / $limit);
        $page       = min($page, max(1, $totalPages));
        $offset     = ($page - 1) * $limit;

        // ---- Fetch page (filtered, ordered, limited) ----
        // $limit and $offset are strict ints at this point → safe to interpolate.
        $pageSQL = "
            SELECT *
            FROM ($unionSQL) AS combined
            ORDER BY interment_id DESC, is_history ASC
            LIMIT $limit OFFSET $offset
        ";
        $pageStmt = $pdo->prepare($pageSQL);
        $pageStmt->execute($searchParams);
        $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

        // ---- Format current page only (≤500 rows) ----
        $items = [];
        foreach ($rows as $row) {
            $isHistory = (bool) $row['is_history'];
            $formatted = formatInterment($row);
            $formatted['is_history'] = $isHistory;

            if ($isHistory) {
                $formatted['transfer_date'] = $row['transfer_date'];
                if (!empty($row['transfer_date'])) {
                    $formatted['deceased_name'] =
                        "[History " . $row['transfer_date'] . "] " . $formatted['deceased_name'];
                }
            }

            $items[] = $formatted;
        }

        // ---- Response ----
        $payload = [
            'pagination' => [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ],
            'interments' => $items,
        ];
        if ($searchTerm !== '') {
            $payload['search_term'] = $searchTerm;
        }

        Response::success('Interments retrieved', $payload);
    }
}

// -----------------------------------------------------------------------------
// POST – Create a new interment manually (co‑interment allowed)
// -----------------------------------------------------------------------------
if ($method === 'POST') {
    // Required fields
    $required = ['control_number', 'deceased_name', 'assistance_type'];
    foreach ($required as $field) {
        if (empty($rawData[$field])) {
            Response::error("Field '$field' is required.", 400);
        }
    }

    // Validate status if provided
    $status = $rawData['status'] ?? 'Pending';
    if (!in_array($status, ['Pending', 'Active', 'Inactive'])) {
        Response::error("Invalid status. Must be Pending, Active, or Inactive.", 400);
    }

    // Validate assistance_type
    $assistance = $rawData['assistance_type'];
    if (!in_array($assistance, ['Burial', 'Transfer the remains of the late', 'Other'])) {
        Response::error("Invalid assistance_type.", 400);
    }

    // If current_grave_id provided, validate existence ONLY (no vacancy check)
    $currentGraveId = !empty($rawData['current_grave_id']) ? (int) $rawData['current_grave_id'] : null;
    if ($currentGraveId) {
        $graveCheck = $pdo->prepare("
            SELECT grave_id FROM graves 
            WHERE grave_id = ? AND deleted_at IS NULL
        ");
        $graveCheck->execute([$currentGraveId]);
        if (!$graveCheck->fetch()) {
            Response::error("Current grave does not exist or is deleted.", 400);
        }
        // NO vacancy check – allows co‑interment
    }

    // Prepare insert fields (including audit columns)
    $fields = [
        'control_number',
        'deceased_name',
        'deceased_sex',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'current_grave_id',
        'transfer_to_grave',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'contact_person_address',
        'contact_person_address_barangay',
        'assistance_type',
        'burial_permit_number',
        'burial_permit_date',
        'transfer_permit_number',
        'transfer_permit_issued_by',
        'transfer_permit_date',
        'exhumation_permit_number',
        'exhumation_permit_date',
        'date_buried',
        'date_exhumed',
        'burial_clearance_date',
        'lease_expiration_date',
        'status',
        'remarks',
        // Audit
        'created_by',
        'updated_by'
    ];

    $placeholders = [];
    $values = [];
    foreach ($fields as $field) {
        if ($field === 'status') {
            $val = $status;
        } elseif ($field === 'created_by' || $field === 'updated_by') {
            $val = $userData['user_id'];
        } else {
            $val = $rawData[$field] ?? null;
        }
        // Validate date fields
        if (in_array($field, ['deceased_date_of_birth', 'deceased_date_of_death', 'burial_permit_date', 'transfer_permit_date', 'exhumation_permit_date', 'date_buried', 'date_exhumed', 'burial_clearance_date', 'lease_expiration_date'])) {
            if (!empty($val) && !strtotime($val)) {
                Response::error("Invalid date format for '$field'.", 400);
            }
        }
        $placeholders[] = '?';
        $values[] = $val;
    }

    $pdo->beginTransaction();
    try {
        // Insert interment (created_at/updated_at default automatically)
        $sql = "INSERT INTO interments (" . implode(', ', $fields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newId = $pdo->lastInsertId();

        // --- NEW ADDITION: Automatically mark grave as Occupied ---
        if ($status === 'Active' && $currentGraveId) {
            $markOccupied = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
            $markOccupied->execute([$currentGraveId]);
        }
        // ---------------------------------------------------------

        $pdo->commit();
        systemLog("Manually created interment $newId with status $status", $userData['user_id']);
        Response::success("Interment created.", ['interment_id' => $newId], 201);
    } catch (PDOException $e) {
        $pdo->rollBack();
        if ($e->getCode() == 23000) {
            Response::error("Conflict: Control number already exists.", 409);
        }
        systemLog("Record creation error: " . $e->getMessage(), 'System');
        Response::error("Database error while creating record.", 500);
    }
}

// -----------------------------------------------------------------------------
// PUT – Update an interment manually (co‑interment allowed)
// -----------------------------------------------------------------------------
if ($method === 'PUT') {
    // REST functionality: allow PUT /records.php/{id}
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = $resourceId;
    }

    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    // Fetch current record (only if not soft‑deleted)
    $currentStmt = $pdo->prepare("
        SELECT * FROM interments 
        WHERE interment_id = ? AND deleted_at IS NULL
    ");
    $currentStmt->execute([$id]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        Response::error("Interment not found.", 404);
    }

    $updates = [];
    $params = [];

    // Allowed fields to update (excluding audit columns – they are managed automatically)
    $updatable = [
        'control_number',
        'deceased_name',
        'deceased_sex',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'current_grave_id',
        'transfer_to_grave',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'contact_person_address',
        'contact_person_address_barangay',
        'assistance_type',
        'burial_permit_number',
        'burial_permit_date',
        'transfer_permit_number',
        'transfer_permit_issued_by',
        'transfer_permit_date',
        'exhumation_permit_number',
        'exhumation_permit_date',
        'date_buried',
        'date_exhumed',
        'burial_clearance_date',
        'lease_expiration_date',
        'status',
        'remarks'
    ];

    $newStatus = $current['status'];
    $newCurrentGraveId = $current['current_grave_id'];

    foreach ($updatable as $field) {
        if (array_key_exists($field, $rawData)) {
            $val = $rawData[$field];
            // Validate date fields
            if (in_array($field, ['deceased_date_of_birth', 'deceased_date_of_death', 'burial_permit_date', 'transfer_permit_date', 'exhumation_permit_date', 'date_buried', 'date_exhumed', 'burial_clearance_date', 'lease_expiration_date'])) {
                if (!empty($val) && !strtotime($val)) {
                    Response::error("Invalid date format for '$field'.", 400);
                }
            }
            if ($field === 'status') {
                if (!in_array($val, ['Pending', 'Active', 'Inactive'])) {
                    Response::error("Invalid status.", 400);
                }
                $newStatus = $val;
            } elseif ($field === 'current_grave_id') {
                $newCurrentGraveId = !empty($val) ? (int) $val : null;
            }
            $updates[] = "$field = ?";
            $params[] = $val;
        }
    }

    if (empty($updates)) {
        Response::error("No fields to update.", 400);
    }

    // --- Validation (co‑interment friendly) ---
    // Only check that the new current_grave_id exists (if provided) and is not deleted
    if ($newCurrentGraveId) {
        $graveCheck = $pdo->prepare("
            SELECT grave_id FROM graves 
            WHERE grave_id = ? AND deleted_at IS NULL
        ");
        $graveCheck->execute([$newCurrentGraveId]);
        if (!$graveCheck->fetch()) {
            Response::error("Target current_grave_id does not exist or is deleted.", 400);
        }
        // NO check for vacancy or other active interments – allows co‑interment
    }

    // Add updated_by to the update list
    $updates[] = "updated_by = ?";
    $params[] = $userData['user_id'];
    // updated_at will auto‑update via ON UPDATE CURRENT_TIMESTAMP

    $pdo->beginTransaction();
    try {
        // Apply updates to interment
        $updateSql = "UPDATE interments SET " . implode(', ', $updates) . " WHERE interment_id = ? AND deleted_at IS NULL";
        $params[] = $id;
        $stmt = $pdo->prepare($updateSql);
        $stmt->execute($params);

        // --- NEW ADDITION: Automatically mark grave as Occupied ---
        if ($newStatus === 'Active' && $newCurrentGraveId) {
            $markOccupied = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
            $markOccupied->execute([$newCurrentGraveId]);
        }
        // ---------------------------------------------------------

        $pdo->commit();
        systemLog("Manually updated interment $id", $userData['user_id']);
        Response::success("Interment updated.");
    } catch (PDOException $e) {
        $pdo->rollBack();
        if ($e->getCode() == 23000) {
            Response::error("Conflict: Control number already exists.", 409);
        }
        systemLog("Record update error: " . $e->getMessage(), 'System');
        Response::error("Database error while updating record.", 500);
    }
}

// -----------------------------------------------------------------------------
// DELETE – Soft‑delete an interment (only if not active and not already deleted)
// -----------------------------------------------------------------------------
if ($method === 'DELETE') {
    // REST functionality: allow DELETE /records.php/{id}
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = $resourceId;
    }

    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    // Check if exists, not already deleted, and status is not Active
    $check = $pdo->prepare("
        SELECT status, current_grave_id 
        FROM interments 
        WHERE interment_id = ? AND deleted_at IS NULL
    ");
    $check->execute([$id]);
    $row = $check->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        Response::error("Interment not found or already deleted.", 404);
    }
    if ($row['status'] === 'Active') {
        Response::error("Cannot delete an Active interment. Deactivate it first.", 400);
    }

    // We do NOT free the grave automatically because there might be other active interments
    // The admin must manually manage grave status via graves.php.

    $pdo->beginTransaction();
    try {
        // Soft delete: set deleted_at, updated_at, updated_by
        $updateSql = "
            UPDATE interments 
            SET deleted_at = NOW(), 
                updated_at = NOW(), 
                updated_by = :updated_by
            WHERE interment_id = :id AND deleted_at IS NULL
        ";
        $stmt = $pdo->prepare($updateSql);
        $stmt->execute([
            ':id' => $id,
            ':updated_by' => $userData['user_id']
        ]);

        $pdo->commit();
        systemLog("Soft‑deleted interment $id", $userData['user_id']);
        Response::success("Interment deleted (soft delete).");
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Record deletion error: " . $e->getMessage(), 'System');
        Response::error("Database error while deleting record.", 500);
    }
}

// If method not allowed
Response::error("Method Not Allowed", 405);
