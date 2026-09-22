<?php

<<<<<<< HEAD
=======
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
 * DELETE /records.php/{id} : Soft‑delete an interment (Active allowed; frees grave if empty)
 */

>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE])) {
    Response::error("Forbidden. You do not have permission.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

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
        'current_grave_id'           => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,
        'transfer_to_grave'          => $row['transfer_to_grave'] ? (int) $row['transfer_to_grave'] : null,
        'grave_code'                 => $row['grave_code'],
        'row_num'                    => $row['row_num'] ? (int) $row['row_num'] : null,
        'col_num'                    => $row['col_num'] ? (int) $row['col_num'] : null,
        'grave_status'               => $row['grave_status'],
        'grave_remarks'              => $row['grave_remarks'],
        'block_id'                   => $row['block_id'] ? (int) $row['block_id'] : null,
        'block_name'                 => $row['block_name'],
        'block_type'                 => $row['block_type'],
        'contact_person_name'        => $row['contact_person_name'],
        'contact_person_phone_number' => $row['contact_person_phone_number'],
        'contact_person_email'       => $row['contact_person_email'],
        'contact_person_address'     => $row['contact_person_address'],
        'contact_person_address_barangay' => $row['contact_person_address_barangay'],
        'assistance_type'            => $row['assistance_type'],
        'burial_permit_number'       => $row['burial_permit_number'],
        'burial_permit_date'         => $row['burial_permit_date'],
        'transfer_permit_number'     => $row['transfer_permit_number'],
        'transfer_permit_issued_by'  => $row['transfer_permit_issued_by'],
        'transfer_permit_date'       => $row['transfer_permit_date'],
        'exhumation_permit_number'   => $row['exhumation_permit_number'],
        'exhumation_permit_date'     => $row['exhumation_permit_date'],
        'date_buried'                => $row['date_buried'],
        'date_exhumed'               => $row['date_exhumed'],
        'burial_clearance_date'      => $row['burial_clearance_date'],
        'lease_expiration_date'      => $row['lease_expiration_date'],
        'status'                     => $row['status'],
        'remarks'                    => $row['remarks'],
    ];
}

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

function resolveGraveId(PDO $pdo, $blockName, $graveCode, $blockType = null)
{
    $graveCode = trim((string) $graveCode);
    if ($graveCode === '') return null;

    $stmt = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL LIMIT 1");
    $stmt->execute([$graveCode]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row) return (int) $row['grave_id'];

    $blockId = null;
    $blockName = trim((string) $blockName);
    if ($blockName !== '') {
        $b = $pdo->prepare("SELECT block_id FROM blocks WHERE block_name = ? AND deleted_at IS NULL LIMIT 1");
        $b->execute([$blockName]);
        $br = $b->fetch(PDO::FETCH_ASSOC);
        if ($br) {
            $blockId = (int) $br['block_id'];
        } else {
            $ins = $pdo->prepare("INSERT INTO blocks (block_name, block_type) VALUES (?, ?)");
            $ins->execute([$blockName, $blockType ?: null]);
            $blockId = (int) $pdo->lastInsertId();
        }
    }

    $ins = $pdo->prepare("INSERT INTO graves (grave_code, block_id, status) VALUES (?, ?, 'Occupied')");
    $ins->execute([$graveCode, $blockId]);
    return (int) $pdo->lastInsertId();
}

if ($method === 'GET') {

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

    if ($resourceId) {
        $flatList = $buildFlatList($resourceId);

        if (empty($flatList)) {
            Response::error('Interment not found.', 404);
        }

        Response::success('Interment retrieved', [
            'history_included' => true,
            'interments'       => $flatList,
        ]);
    } else {
        $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
        $page  = max(1, (int) ($_GET['page'] ?? 1));

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

            $hp[] = "CONCAT('[History ', COALESCE(tl.transfer_date, ''), '] ', COALESCE(i.deceased_name, '')) LIKE ?";
            $searchParams[] = $like;

            $hp[] = "CONCAT('Moved on ', COALESCE(tl.transfer_date, ''), '. Reason: ', COALESCE(tl.reason, ''), '. ', COALESCE(i.remarks, '')) LIKE ?";
            $searchParams[] = $like;

            $searchSQLHistory = ' AND (' . implode(' OR ', $hp) . ')';
        }

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
                i.remarks AS remarks,
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

        $unionSQL = "($currentSQL) UNION ALL ($historySQL)";

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($unionSQL) AS combined");
        $countStmt->execute($searchParams);
        $totalRecords = (int) $countStmt->fetchColumn();

        $totalPages = (int) ceil($totalRecords / $limit);
        $page       = min($page, max(1, $totalPages));
        $offset     = ($page - 1) * $limit;

        $pageSQL = "
            SELECT *
            FROM ($unionSQL) AS combined
            ORDER BY interment_id DESC, is_history ASC
            LIMIT $limit OFFSET $offset
        ";
        $pageStmt = $pdo->prepare($pageSQL);
        $pageStmt->execute($searchParams);
        $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

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

if ($method === 'POST') {
    if (empty($rawData['control_number']) && !empty($rawData['control_no'])) {
        $rawData['control_number'] = $rawData['control_no'];
    }
    if (empty($rawData['assistance_type'])) {
        $rawData['assistance_type'] = 'Burial';
    }
    if (empty($rawData['deceased_name'])) {
        Response::error("Field 'deceased_name' is required.", 400);
    }
    if (empty($rawData['control_number'])) {
        Response::error("Field 'control_number' is required.", 400);
    }
    if (!preg_match('/^[A-Z0-9-]+$/', (string) $rawData['control_number'])) {
        Response::error("Invalid control_number format.", 400);
    }
    if (!in_array($rawData['assistance_type'], ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
        Response::error("Invalid assistance_type.", 400);
    }

    $currentGraveId = !empty($rawData['current_grave_id'])
        ? (int) $rawData['current_grave_id']
        : resolveGraveId(
            $pdo,
            $rawData['block_name'] ?? $rawData['block'] ?? '',
            $rawData['grave_code'] ?? '',
            $rawData['block_type'] ?? null
        );

    if ($currentGraveId) {
        $graveCheck = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? AND deleted_at IS NULL");
        $graveCheck->execute([$currentGraveId]);
        if (!$graveCheck->fetch()) {
            Response::error("Current grave does not exist or is deleted.", 400);
        }
    }

<<<<<<< HEAD
    $status = 'Active';

=======
    // An Inactive interment must not have a grave assignment.
    if ($status === 'Inactive') {
        $rawData['current_grave_id'] = null;
        $currentGraveId = null;
    }

    // Prepare insert fields (including audit columns)
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
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
        } elseif ($field === 'current_grave_id') {
            $val = $currentGraveId;
        } else {
            $val = $rawData[$field] ?? null;
        }
        if (in_array($field, ['deceased_date_of_birth', 'deceased_date_of_death', 'burial_permit_date', 'transfer_permit_date', 'exhumation_permit_date', 'date_buried', 'date_exhumed', 'burial_clearance_date', 'lease_expiration_date'])) {
            if (!empty($val) && !strtotime($val)) {
                Response::error("Invalid date format for '$field'.", 400);
            }
            if ($val === '') $val = null;
        }
        $placeholders[] = '?';
        $values[] = $val;
    }

    $pdo->beginTransaction();
    try {
        $sql = "INSERT INTO interments (" . implode(', ', $fields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newId = $pdo->lastInsertId();

<<<<<<< HEAD
=======
        // Automatically mark grave as Occupied when inserting an Active interment
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
        if ($status === 'Active' && $currentGraveId) {
            $markOccupied = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
            $markOccupied->execute([$currentGraveId]);
        }

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

if ($method === 'PUT') {
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = $resourceId;
    }
    if (empty($rawData['interment_id']) && !empty($rawData['id'])) {
        $rawData['interment_id'] = $rawData['id'];
    }
    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    $currentStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ? AND deleted_at IS NULL");
    $currentStmt->execute([$id]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        Response::error("Interment not found.", 404);
    }

    if (empty($rawData['current_grave_id']) && !empty($rawData['grave_code'])) {
        $rawData['current_grave_id'] = resolveGraveId(
            $pdo,
            $rawData['block_name'] ?? $rawData['block'] ?? '',
            $rawData['grave_code'],
            $rawData['block_type'] ?? null
        );
    }

    if (!empty($rawData['assistance_type']) &&
        !in_array($rawData['assistance_type'], ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
        Response::error("Invalid assistance_type.", 400);
    }

    $rawData['status'] = 'Active';

    $updates = [];
    $params = [];

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

    // Snapshot the state BEFORE the update, so we can decide what to do with graves afterward
    $oldStatus         = $current['status'];
    $oldCurrentGraveId = $current['current_grave_id'] ? (int) $current['current_grave_id'] : null;

    $newStatus         = $current['status'];
    $newCurrentGraveId = $current['current_grave_id'];
    $graveIdChanged    = false;

    foreach ($updatable as $field) {
        if (array_key_exists($field, $rawData)) {
            $val = $rawData[$field];
<<<<<<< HEAD
=======

            // Validate date fields
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
            if (in_array($field, ['deceased_date_of_birth', 'deceased_date_of_death', 'burial_permit_date', 'transfer_permit_date', 'exhumation_permit_date', 'date_buried', 'date_exhumed', 'burial_clearance_date', 'lease_expiration_date'])) {
                if (!empty($val) && !strtotime($val)) {
                    Response::error("Invalid date format for '$field'.", 400);
                }
                if ($val === '') $val = null;
            }

            if ($field === 'status') {
                if (!in_array($val, ['Pending', 'Active', 'Inactive'])) {
                    Response::error("Invalid status.", 400);
                }
                $newStatus = $val;
            } elseif ($field === 'current_grave_id') {
                $newCurrentGraveId = !empty($val) ? (int) $val : null;
                $graveIdChanged = ((int) ($current['current_grave_id'] ?? 0)) !== ((int) ($newCurrentGraveId ?? 0));
            }

            $updates[] = "$field = ?";
            $params[]  = $val;
        }
    }

    // If the interment is becoming Inactive and the caller did not explicitly
    // provide a current_grave_id, clear it so we don't leave a stale grave
    // reference behind.
    if ($newStatus === 'Inactive' && !array_key_exists('current_grave_id', $rawData)) {
        $newCurrentGraveId = null;
        $graveIdChanged    = true;
        $updates[]         = "current_grave_id = ?";
        $params[]          = null;
    }

    if (empty($updates)) {
        Response::error("No fields to update.", 400);
    }

<<<<<<< HEAD
=======
    // --- Workflow safeguards (AFTER the payload has been read) ---

    // 1. Cannot change a Pending interment's status via Records.
    if ($current['status'] === 'Pending' && $newStatus !== 'Pending') {
        if ($newStatus === 'Active') {
            Response::error("Cannot activate a Pending interment directly. Use Monitor to execute the reservation.", 400);
        }
        if ($newStatus === 'Inactive') {
            Response::error("Cannot cancel a Pending interment here. Use Monitor DELETE to cancel reservations.", 400);
        }
    }

    // 2. Cannot move an interment whose current grave is targeted by a pending reservation.
    if ($graveIdChanged && $current['current_grave_id']) {
        $pendingOnGrave = $pdo->prepare("
            SELECT interment_id FROM interments
            WHERE transfer_to_grave = ?
              AND status = 'Pending'
              AND deleted_at IS NULL
            LIMIT 1
        ");
        $pendingOnGrave->execute([$current['current_grave_id']]);
        if ($pendingOnGrave->fetch()) {
            Response::error("Cannot move this interment: its grave is targeted by a pending reservation. Cancel the reservation first.", 409);
        }
    }

    // 3. Validate the new grave exists (if provided).
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
    if ($newCurrentGraveId) {
        $graveCheck = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? AND deleted_at IS NULL");
        $graveCheck->execute([$newCurrentGraveId]);
        if (!$graveCheck->fetch()) {
            Response::error("Target current_grave_id does not exist or is deleted.", 400);
        }
    }

    $updates[] = "updated_by = ?";
    $params[] = $userData['user_id'];
<<<<<<< HEAD

    $pdo->beginTransaction();
    try {
=======

    // --- Decide whether the old grave needs to be freed ---
    $vacatingOldGrave = false;
    if ($oldCurrentGraveId && $oldStatus === 'Active') {
        if ($newStatus !== 'Active' || (int) ($newCurrentGraveId ?? 0) !== $oldCurrentGraveId) {
            $vacatingOldGrave = true;
        }
    }

    $oldGraveFreed = false;

    $pdo->beginTransaction();
    try {
        // 1. Apply updates to interment
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
        $updateSql = "UPDATE interments SET " . implode(', ', $updates) . " WHERE interment_id = ? AND deleted_at IS NULL";
        $params[] = $id;
        $stmt = $pdo->prepare($updateSql);
        $stmt->execute($params);

<<<<<<< HEAD
=======
        // 2. If the old grave is being vacated, check for co-interments and free it if empty
        if ($vacatingOldGrave) {
            $stillOccupied = $pdo->prepare("
                SELECT interment_id FROM interments
                WHERE current_grave_id = ?
                  AND status = 'Active'
                  AND deleted_at IS NULL
                  AND interment_id != ?
                LIMIT 1
            ");
            $stillOccupied->execute([$oldCurrentGraveId, $id]);
            if (!$stillOccupied->fetch()) {
                $freeGrave = $pdo->prepare("UPDATE graves SET status = 'Vacant' WHERE grave_id = ?");
                $freeGrave->execute([$oldCurrentGraveId]);
                $oldGraveFreed = true;
            }
        }

        // 3. If the interment is Active and has a current grave, mark that grave as Occupied
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
        if ($newStatus === 'Active' && $newCurrentGraveId) {
            $markOccupied = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
            $markOccupied->execute([$newCurrentGraveId]);
        }

        $pdo->commit();

        systemLog(
            "Manually updated interment $id" .
                ($oldGraveFreed ? " and freed grave $oldCurrentGraveId" : ""),
            $userData['user_id']
        );

        Response::success("Interment updated.", [
            'interment_id'    => $id,
            'old_grave_id'    => $oldCurrentGraveId,
            'old_grave_freed' => $oldGraveFreed,
            'new_grave_id'    => $newCurrentGraveId ? (int) $newCurrentGraveId : null,
            'new_status'      => $newStatus,
        ]);
    } catch (PDOException $e) {
        $pdo->rollBack();
        if ($e->getCode() == 23000) {
            Response::error("Conflict: Control number already exists.", 409);
        }
        systemLog("Record update error: " . $e->getMessage(), 'System');
        Response::error("Database error while updating record.", 500);
    }
}

<<<<<<< HEAD
=======
// -----------------------------------------------------------------------------
// DELETE – Soft‑delete an interment (Active allowed)
// -----------------------------------------------------------------------------
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
if ($method === 'DELETE') {
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = $resourceId;
    }
    if (empty($rawData['interment_id']) && !empty($_GET['interment_id'])) {
        $rawData['interment_id'] = $_GET['interment_id'];
    }
    if (empty($rawData['interment_id']) && !empty($rawData['id'])) {
        $rawData['interment_id'] = $rawData['id'];
    }
    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

<<<<<<< HEAD
    $check = $pdo->prepare("SELECT status, current_grave_id FROM interments WHERE interment_id = ? AND deleted_at IS NULL");
=======
    // Check if exists and not already deleted
    $check = $pdo->prepare("
        SELECT status, current_grave_id 
        FROM interments 
        WHERE interment_id = ? AND deleted_at IS NULL
    ");
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
    $check->execute([$id]);
    $row = $check->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        Response::error("Interment not found or already deleted.", 404);
    }

    // Still block Pending — those must be cancelled via Monitor so the
    // old-occupant revert logic runs.
    if ($row['status'] === 'Pending') {
        Response::error("Cannot delete a Pending interment. Cancel the reservation first via Monitor.", 400);
    }

<<<<<<< HEAD
    $pdo->beginTransaction();
    try {
=======
    $graveId       = $row['current_grave_id'] ? (int) $row['current_grave_id'] : null;
    $graveFreed    = false;
    $pendingExists = false;

    $pdo->beginTransaction();
    try {
        // 1. Soft delete the interment
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
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

        // 2. If it was in a grave, decide whether to free the grave
        if ($graveId) {
            // Any other Active interments still physically in this grave?
            $stillOccupied = $pdo->prepare("
                SELECT interment_id FROM interments
                WHERE current_grave_id = ?
                  AND status = 'Active'
                  AND deleted_at IS NULL
                LIMIT 1
            ");
            $stillOccupied->execute([$graveId]);
            $activeOccupant = $stillOccupied->fetch(PDO::FETCH_ASSOC);

            if (!$activeOccupant) {
                // No co-interments remain → free the grave
                $freeGrave = $pdo->prepare("UPDATE graves SET status = 'Vacant' WHERE grave_id = ?");
                $freeGrave->execute([$graveId]);
                $graveFreed = true;
            }

            // Inform the client if a pending reservation targets this grave,
            // because deleting the occupant changes the reservation's shape
            // (replacement → vacant-grave insertion).
            $pendingCheck = $pdo->prepare("
                SELECT interment_id FROM interments
                WHERE transfer_to_grave = ?
                  AND status = 'Pending'
                  AND deleted_at IS NULL
                LIMIT 1
            ");
            $pendingCheck->execute([$graveId]);
            if ($pendingCheck->fetch()) {
                $pendingExists = true;
            }
        }

        $pdo->commit();
<<<<<<< HEAD
        systemLog("Soft-deleted interment $id", $userData['user_id']);
        Response::success("Interment deleted (soft delete).");
=======
        systemLog("Soft‑deleted interment $id" . ($graveFreed ? " and freed grave $graveId" : ""), $userData['user_id']);

        Response::success("Interment deleted (soft delete).", [
            'interment_id'        => $id,
            'grave_id'            => $graveId,
            'grave_freed'         => $graveFreed,
            'pending_on_grave'    => $pendingExists,
        ]);
>>>>>>> a9df4f541a7711b6d904fca59d8c829d71208bf3
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Record deletion error: " . $e->getMessage(), 'System');
        Response::error("Database error while deleting record.", 500);
    }
}

Response::error("Method Not Allowed", 405);