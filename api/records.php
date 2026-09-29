<?php

/**
 * Records.php – Full CRUD for interments (Master Admin Editor)
 *
 * Co-interment is allowed: multiple Active interments may point at the same
 * grave.  This file does NOT enforce grave.status = 'Vacant' for Active
 * interments; grave status is *derived* from the interments table instead
 * (see rederiveGraveStatus).
 *
 * Reservations live in `reservation_details`.  This file never writes to it;
 * it only READS it to check whether a grave is targeted by an active
 * reservation or whether an interment is the displaced "old occupant".
 *
 * GET    /records.php      : List interments (paginated, filterable)
 * GET    /records.php/{id} : Get one interment (+ its transfer history)
 * POST   /records.php      : Create a new interment manually
 * PUT    /records.php/{id} : Update an interment (any field, optional OCC)
 * DELETE /records.php/{id} : Soft-delete an interment (frees grave if empty)
 *
 * DISPLAY RULE
 *   Only 'Active' and 'Inactive' interments are ever SELECTed here.  'Pending'
 *   rows belong to the Monitor / Reserve flow until confirmed; they are never
 *   surfaced through any read path on this endpoint.
 *
 * CONCURRENCY
 *   - PUT / DELETE lock the interment row with SELECT ... FOR UPDATE so two
 *     writers on the same id serialize instead of racing.
 *   - Any grave whose status might change is locked FOR UPDATE first.  Locks
 *     are taken in ascending grave_id order to prevent deadlocks.
 *   - Grave status is re-derived from the interments table with a single
 *     atomic UPDATE, so a grave can never be left Occupied with zero
 *     occupants (or Vacant with one).
 *   - PUT accepts an optional `expected_updated_at` for optimistic locking.
 *     When supplied and the row has moved on, the request returns 409.
 *     Clients that don't send it keep last-write-wins semantics.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

// Only Admin and Office can manage records
$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Forbidden. You do not have permission.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// Path: /records.php/{id}
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function formatInterment($row)
{
    return [
        'interment_id'                    => (int) $row['interment_id'],
        'control_number'                  => $row['control_number'],
        'deceased_name'                   => $row['deceased_name'],
        'deceased_sex'                    => $row['deceased_sex'],
        'last_known_address'              => $row['last_known_address'],
        'death_certificate'               => $row['death_certificate'],
        'deceased_date_of_birth'          => $row['deceased_date_of_birth'],
        'deceased_date_of_death'          => $row['deceased_date_of_death'],

        'current_grave_id'                => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,

        'grave_code'                      => $row['grave_code'],
        'row_num'                         => $row['row_num'] ? (int) $row['row_num'] : null,
        'col_num'                         => $row['col_num'] ? (int) $row['col_num'] : null,
        'grave_status'                    => $row['grave_status'],
        'grave_remarks'                   => $row['grave_remarks'],
        'block_id'                        => $row['block_id'] ? (int) $row['block_id'] : null,
        'block_name'                      => $row['block_name'],
        'block_type'                      => $row['block_type'],

        'contact_person_name'             => $row['contact_person_name'],
        'contact_person_phone_number'     => $row['contact_person_phone_number'],
        'contact_person_email'            => $row['contact_person_email'],
        'contact_person_address'          => $row['contact_person_address'],
        'contact_person_address_barangay' => $row['contact_person_address_barangay'],

        'assistance_type'                 => $row['assistance_type'],
        'burial_permit_number'            => $row['burial_permit_number'],
        'burial_permit_date'              => $row['burial_permit_date'],
        'transfer_permit_number'          => $row['transfer_permit_number'],
        'transfer_permit_issued_by'       => $row['transfer_permit_issued_by'],
        'transfer_permit_date'            => $row['transfer_permit_date'],
        'exhumation_permit_number'        => $row['exhumation_permit_number'],
        'exhumation_permit_date'          => $row['exhumation_permit_date'],

        'date_buried'                     => $row['date_buried'],
        'date_exhumed'                    => $row['date_exhumed'],
        'burial_clearance_date'           => $row['burial_clearance_date'],
        'lease_expiration_date'           => $row['lease_expiration_date'],
        'status'                          => $row['status'],
        'remarks'                         => $row['remarks'],
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
// Concurrency helpers – must be called inside an active transaction
// -----------------------------------------------------------------------------

/**
 * Take FOR UPDATE locks on one or more grave rows, in ascending grave_id order.
 *
 * The ordering is what prevents deadlocks: two concurrent requests that each
 * need the same pair of graves will always grab them in the same order, so one
 * blocks cleanly instead of the two forming a circular wait.
 */
function lockGraveRows(PDO $pdo, array $graveIds): void
{
    $graveIds = array_values(array_unique(array_filter(
        array_map('intval', $graveIds),
        function ($v) {
            return $v > 0;
        }
    )));

    if (empty($graveIds)) {
        return;
    }

    sort($graveIds, SORT_NUMERIC);

    $stmt = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? FOR UPDATE");
    foreach ($graveIds as $gid) {
        $stmt->execute([$gid]);
    }
}

/**
 * Re-derive a grave's status from the interments table, atomically.
 *
 * Occupied  <=> at least one Active, non-deleted interment references it.
 * Vacant    otherwise.
 *
 * The caller MUST hold a FOR UPDATE lock on this grave row, otherwise the
 * derivation is racy.
 *
 * Returns the new status string, or null if the grave no longer exists.
 */
function rederiveGraveStatus(PDO $pdo, int $graveId): ?string
{
    $stmt = $pdo->prepare("
        UPDATE graves g
        SET g.status = CASE
            WHEN EXISTS (
                SELECT 1 FROM interments i
                WHERE i.current_grave_id = g.grave_id
                  AND i.status = 'Active'
                  AND i.deleted_at IS NULL
            ) THEN 'Occupied'
            ELSE 'Vacant'
        END
        WHERE g.grave_id = ?
    ");
    $stmt->execute([$graveId]);

    $read = $pdo->prepare("SELECT status FROM graves WHERE grave_id = ?");
    $read->execute([$graveId]);
    $val = $read->fetchColumn();
    return $val === false ? null : (string) $val;
}

// =============================================================================
// GET – list interments (with history flattened) or fetch a single one
// =============================================================================
if ($method === 'GET') {

    /**
     * Build a flat list of interments (current + transfer history) for one ID.
     * Scoped to a single interment, so it's cheap.
     *
     * Only Active / Inactive rows are eligible; Pending rows belong to the
     * Monitor flow and are deliberately excluded.
     */
    $buildFlatList = function ($filterId) use ($pdo) {
        $sql = getIntermentSelectSQL() . "
            WHERE i.deleted_at IS NULL
              AND i.interment_id = :id
              AND i.status IN ('Active', 'Inactive')
            ORDER BY i.interment_id DESC
        ";
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

        $ids          = array_keys($intermentMap);
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

            $historyRow['deceased_name']    = "[History {$log['transfer_date']}] " . $historyRow['deceased_name'];
            $historyRow['current_grave_id'] = $log['history_grave_id'] ? (int) $log['history_grave_id'] : null;
            $historyRow['grave_code']       = $log['history_grave_code'];
            $historyRow['row_num']          = $log['history_row_num'] ? (int) $log['history_row_num'] : null;
            $historyRow['col_num']          = $log['history_col_num'] ? (int) $log['history_col_num'] : null;
            $historyRow['grave_status']     = $log['history_grave_status'];
            $historyRow['grave_remarks']    = $log['history_grave_remarks'];
            $historyRow['block_id']         = $log['history_block_id'] ? (int) $log['history_block_id'] : null;
            $historyRow['block_name']       = $log['history_block_name'];
            $historyRow['block_type']       = $log['history_block_type'];
            $historyRow['transfer_date']    = $log['transfer_date'];
            $historyRow['remarks']          = "Moved on {$log['transfer_date']}. Reason: {$log['reason']}. " . ($historyRow['remarks'] ?? '');

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

    // --- /records.php/{id} -------------------------------------------------
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

    // --- /records.php -------------------------------------------------------
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

        // History branch also searches the transfer log AND the computed
        // display strings the API actually emits.
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

    // Current branch (is_history = 0)
    $currentSQL = "
        SELECT
            i.interment_id, 0 AS is_history,
            i.control_number, i.deceased_name, i.deceased_sex,
            i.last_known_address, i.death_certificate,
            i.deceased_date_of_birth, i.deceased_date_of_death,
            i.current_grave_id,
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
          AND i.status IN ('Active', 'Inactive')
        $searchSQLCurrent
    ";

    // History branch (is_history = 1)
    $historySQL = "
        SELECT
            i.interment_id, 1 AS is_history,
            i.control_number, i.deceased_name, i.deceased_sex,
            i.last_known_address, i.death_certificate,
            i.deceased_date_of_birth, i.deceased_date_of_death,
            tg.grave_id AS current_grave_id,
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
          AND i.status IN ('Active', 'Inactive')
        $searchSQLHistory
    ";

    // Outer parens around the WHOLE union; alias attaches to the union, not
    // just the second branch.
    $unionSQL = "($currentSQL) UNION ALL ($historySQL)";

    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($unionSQL) AS combined");
    $countStmt->execute($searchParams);
    $totalRecords = (int) $countStmt->fetchColumn();

    $totalPages = (int) ceil($totalRecords / $limit);
    $page       = min($page, max(1, $totalPages));
    $offset     = ($page - 1) * $limit;

    // $limit / $offset are strict ints at this point → safe to interpolate.
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
                    "[History {$row['transfer_date']}] " . $formatted['deceased_name'];
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

// =============================================================================
// POST – create a new interment manually (co-interment allowed)
// =============================================================================
if ($method === 'POST') {
    // Required fields
    $required = ['control_number', 'deceased_name', 'assistance_type'];
    foreach ($required as $field) {
        if (empty($rawData[$field])) {
            Response::error("Field '$field' is required.", 400);
        }
    }

    // Validate status if provided
    $status = $rawData['status'] ?? 'Inactive';
    if (!in_array($status, ['Pending', 'Active', 'Inactive'], true)) {
        Response::error("Invalid status. Must be exactly: Pending, Active, or Inactive.", 400);
    }

    // Validate assistance_type
    $assistance = $rawData['assistance_type'];
    if (!in_array($assistance, ['Burial', 'Transfer the remains of the late', 'Other'])) {
        Response::error("Invalid assistance_type.", 400);
    }

    // Capture the target grave; existence is checked *inside* the transaction
    // under a FOR UPDATE lock so the row can't disappear between check and
    // INSERT.
    $currentGraveId = !empty($rawData['current_grave_id']) ? (int) $rawData['current_grave_id'] : null;

    // Mirror the DB CHECK chk_status_grave: only Active interments may carry a
    // current_grave_id.
    if ($status === 'Inactive' || $status === 'Pending') {
        $rawData['current_grave_id'] = null;
        $currentGraveId              = null;
    }

    // Prepare insert fields (including audit columns)
    // NOTE: transfer_to_grave removed – it no longer exists on the schema.
    $fields = [
        'control_number',
        'deceased_name',
        'deceased_sex',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'current_grave_id',
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
        'updated_by',
    ];

    $dateFields = [
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'burial_permit_date',
        'transfer_permit_date',
        'exhumation_permit_date',
        'date_buried',
        'date_exhumed',
        'burial_clearance_date',
        'lease_expiration_date',
    ];

    $placeholders = [];
    $values       = [];
    foreach ($fields as $field) {
        if ($field === 'status') {
            $val = $status;
        } elseif ($field === 'created_by' || $field === 'updated_by') {
            $val = $userData['user_id'];
        } else {
            $val = $rawData[$field] ?? null;
        }

        if (in_array($field, $dateFields, true) && !empty($val) && !strtotime($val)) {
            Response::error("Invalid date format for '$field'.", 400);
        }

        $placeholders[] = '?';
        $values[]       = $val;
    }

    $pdo->beginTransaction();
    try {
        if ($currentGraveId) {
            lockGraveRows($pdo, [$currentGraveId]);

            $graveCheck = $pdo->prepare("
                SELECT grave_id FROM graves
                WHERE grave_id = ? AND deleted_at IS NULL
            ");
            $graveCheck->execute([$currentGraveId]);
            if (!$graveCheck->fetch()) {
                $pdo->rollBack();
                Response::error("Current grave does not exist or is deleted.", 400);
            }
            // No vacancy check – co-interment is allowed.
        }

        $sql = "INSERT INTO interments (" . implode(', ', $fields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newId = $pdo->lastInsertId();

        // Derive the grave's status from the table rather than blindly marking
        // it Occupied.  Idempotent, and consistent with PUT / DELETE.
        if ($status === 'Active' && $currentGraveId) {
            rederiveGraveStatus($pdo, $currentGraveId);
        }

        $pdo->commit();
        systemLog("Manually created interment $newId with status $status", $userData['user_id']);
        Response::success("Interment created.", ['interment_id' => $newId], 201);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }

        $sqlState = (string) $e->getCode();
        $msg      = $e->getMessage();

        // CHECK constraint violations: MySQL reports these as SQLSTATE HY000
        // (error 3819), not 23000.
        if ($sqlState === 'HY000') {
            if (strpos($msg, 'chk_status_grave') !== false) {
                Response::error(
                    "Conflict: Invalid status/grave combination. Only Active interments may have a current_grave_id.",
                    409
                );
            }

            // Unknown CHECK violation — log and return a generic 409.
            systemLog("Record creation CHECK violation: " . $msg, 'System');
            Response::error("Conflict: Record could not be created.", 409);
        }

        // Unique / FK violations.
        if ($sqlState === '23000') {
            if (strpos($msg, 'uk_active_control_number') !== false) {
                Response::error("Conflict: Control number already exists.", 409);
            }
            if (
                strpos($msg, 'fk_interments_grave') !== false
                || strpos($msg, 'current_grave_id') !== false
            ) {
                Response::error("Conflict: Current grave does not exist or has been deleted.", 409);
            }

            // Unknown integrity violation — log it, then give a generic 409.
            systemLog("Record creation integrity violation: " . $msg, 'System');
            Response::error("Conflict: Record could not be created.", 409);
        }

        systemLog("Record creation error: " . $msg, 'System');
        Response::error("Database error while creating record.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Record creation error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

// =============================================================================
// PUT – update an interment (co-interment allowed)
// =============================================================================
if ($method === 'PUT') {
    // REST functionality: allow PUT /records.php/{id}
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = $resourceId;
    }

    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    // Optional optimistic-lock token.  If supplied, we refuse the update when
    // the row's updated_at has moved on.  Clients that don't send it keep
    // last-write-wins semantics.
    $expectedUpdatedAt = array_key_exists('expected_updated_at', $rawData)
        ? $rawData['expected_updated_at']
        : null;

    $pdo->beginTransaction();
    try {
        // Lock the interment row so concurrent PUT / DELETE on the same id
        // serialize instead of racing on stale snapshots.
        $currentStmt = $pdo->prepare("
            SELECT * FROM interments
            WHERE interment_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $currentStmt->execute([$id]);
        $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
        if (!$current) {
            $pdo->rollBack();
            Response::error("Interment not found.", 404);
        }

        $updates = [];
        $params  = [];

        $updatable = [
            'control_number',
            'deceased_name',
            'deceased_sex',
            'last_known_address',
            'death_certificate',
            'deceased_date_of_birth',
            'deceased_date_of_death',
            'current_grave_id',
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
        ];

        $dateFields = [
            'deceased_date_of_birth',
            'deceased_date_of_death',
            'burial_permit_date',
            'transfer_permit_date',
            'exhumation_permit_date',
            'date_buried',
            'date_exhumed',
            'burial_clearance_date',
            'lease_expiration_date',
        ];

        // Snapshot before the update, so we can decide what to do with graves
        // afterwards.
        $oldStatus         = $current['status'];
        $oldCurrentGraveId = $current['current_grave_id'] ? (int) $current['current_grave_id'] : null;

        $newStatus         = $current['status'];
        $newCurrentGraveId = $current['current_grave_id'];
        $graveIdChanged    = false;

        foreach ($updatable as $field) {
            if (!array_key_exists($field, $rawData)) {
                continue;
            }

            $val = $rawData[$field];

            if (in_array($field, $dateFields, true) && !empty($val) && !strtotime($val)) {
                $pdo->rollBack();
                Response::error("Invalid date format for '$field'.", 400);
            }

            if ($field === 'status') {
                if (!in_array($val, ['Pending', 'Active', 'Inactive'], true)) {
                    $pdo->rollBack();
                    Response::error("Invalid status. Must be exactly: Pending, Active, or Inactive.", 400);
                }
                $newStatus = $val;
            } elseif ($field === 'current_grave_id') {
                $newCurrentGraveId = !empty($val) ? (int) $val : null;
                $graveIdChanged    = ((int) ($current['current_grave_id'] ?? 0)) !== ((int) ($newCurrentGraveId ?? 0));
            }

            $updates[] = "$field = ?";
            $params[]  = $val;
        }

        // If the interment is becoming Inactive / Pending and the caller didn't
        // explicitly set current_grave_id, clear it so no stale grave reference
        // is left behind.
        if (($newStatus === 'Inactive' || $newStatus === 'Pending')
            && !array_key_exists('current_grave_id', $rawData)
        ) {
            $newCurrentGraveId = null;
            $graveIdChanged    = true;
            $updates[]         = "current_grave_id = ?";
            $params[]          = null;
        }

        // Mirror chk_status_grave: only Active interments may hold a grave.
        if (($newStatus === 'Pending' || $newStatus === 'Inactive') && $newCurrentGraveId !== null) {
            $pdo->rollBack();
            Response::error(
                "Cannot assign a grave to a '$newStatus' interment. "
                    . "Only Active interments may have a current_grave_id.",
                400
            );
        }

        if (empty($updates)) {
            $pdo->rollBack();
            Response::error("No fields to update.", 400);
        }

        // --- Workflow safeguards -------------------------------------------

        // Pending rows are created and consumed only by the Reserve / Monitor
        // flow; they can't be promoted or cancelled from here.
        if ($current['status'] === 'Pending' && $newStatus !== 'Pending') {
            if ($newStatus === 'Active') {
                $pdo->rollBack();
                Response::error("Cannot activate a Pending interment directly. Use Monitor to execute the reservation.", 400);
            }
            if ($newStatus === 'Inactive') {
                $pdo->rollBack();
                Response::error("Cannot cancel a Pending interment here. Use Monitor DELETE to cancel reservations.", 400);
            }
        }

        if ($current['status'] !== 'Pending' && $newStatus === 'Pending') {
            $pdo->rollBack();
            Response::error("Cannot move an interment back to Pending. Pending rows are created only via Reserve.", 400);
        }

        // Lock every grave whose status we might touch, BEFORE we reason about
        // occupancy.  Ascending grave_id order avoids deadlocks when two
        // requests each need the same pair of graves.
        lockGraveRows($pdo, [$oldCurrentGraveId, $newCurrentGraveId]);

        // Refuse to move an interment off a grave that an active reservation
        // is targeting.  (The reservation table itself is not locked here; a
        // brand-new reservation could still appear between this check and
        // COMMIT — that's a Monitor-side concern.)
        if ($graveIdChanged && $current['current_grave_id']) {
            $pendingOnGrave = $pdo->prepare("
                SELECT reservation_id FROM reservation_details
                WHERE target_grave_id = ?
                  AND deleted_at IS NULL
                LIMIT 1
            ");
            $pendingOnGrave->execute([$current['current_grave_id']]);
            if ($pendingOnGrave->fetch()) {
                $pdo->rollBack();
                Response::error("Cannot move this interment: its grave is targeted by an active reservation. Cancel the reservation first.", 409);
            }
        }

        // Validate the new grave exists.  We already hold its lock, so it
        // can't vanish between here and COMMIT.
        if ($newCurrentGraveId) {
            $graveCheck = $pdo->prepare("
                SELECT grave_id FROM graves
                WHERE grave_id = ? AND deleted_at IS NULL
            ");
            $graveCheck->execute([$newCurrentGraveId]);
            if (!$graveCheck->fetch()) {
                $pdo->rollBack();
                Response::error("Target current_grave_id does not exist or is deleted.", 400);
            }
            // No vacancy / co-interment check – allowed by design.
        }

        // Audit.  updated_at is bumped by the schema's ON UPDATE trigger, which
        // the optimistic-lock check below relies on.
        $updates[] = "updated_by = ?";
        $params[]  = $userData['user_id'];

        // --- Apply the update, optionally guarded by an optimistic lock -----
        $updateSql = "UPDATE interments SET " . implode(', ', $updates) . " WHERE interment_id = ? AND deleted_at IS NULL";
        $params[]  = $id;
        if ($expectedUpdatedAt !== null) {
            $updateSql .= " AND updated_at = ?";
            $params[]  = $expectedUpdatedAt;
        }

        $stmt = $pdo->prepare($updateSql);
        $stmt->execute($params);

        if ($expectedUpdatedAt !== null && $stmt->rowCount() === 0) {
            // Two possibilities:
            //   (a) the row's updated_at moved on -> someone else won -> 409
            //   (b) no values actually changed and the DB didn't bump
            //       updated_at -> treat as success
            // Disambiguate by re-reading.
            $verify = $pdo->prepare("SELECT updated_at FROM interments WHERE interment_id = ? AND deleted_at IS NULL");
            $verify->execute([$id]);
            $actual = $verify->fetchColumn();

            if ($actual === false) {
                $pdo->rollBack();
                Response::error("Interment not found.", 404);
            }
            if ((string) $actual !== (string) $expectedUpdatedAt) {
                $pdo->rollBack();
                Response::error("Conflict: this record was modified by another user. Reload and try again.", 409);
            }
            // else: no-op update – fall through to success.
        }

        // --- Re-derive grave status(es) atomically --------------------------
        $oldGraveFreed = false;
        $statusChanged = ($oldStatus !== $newStatus);
        $graveChanged  = ((int) ($oldCurrentGraveId ?? 0)) !== ((int) ($newCurrentGraveId ?? 0));

        if ($oldCurrentGraveId && ($statusChanged || $graveChanged)) {
            $newOldGraveStatus = rederiveGraveStatus($pdo, $oldCurrentGraveId);
            $oldGraveFreed     = ($newOldGraveStatus === 'Vacant');
        }
        if (
            $newCurrentGraveId
            && ($statusChanged || $graveChanged)
            && $newCurrentGraveId !== $oldCurrentGraveId
        ) {
            rederiveGraveStatus($pdo, $newCurrentGraveId);
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
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        if ((string) $e->getCode() === '23000') {
            Response::error("Conflict: Control number already exists.", 409);
        }
        systemLog("Record update error: " . $e->getMessage(), 'System');
        Response::error("Database error while updating record.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

// =============================================================================
// DELETE – soft-delete an interment (Active allowed)
// =============================================================================
if ($method === 'DELETE') {
    // REST functionality: allow DELETE /records.php/{id}
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = $resourceId;
    }

    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    $pdo->beginTransaction();
    try {
        // Lock the interment row so a concurrent PUT can't slip in between our
        // read and our soft-delete.
        $check = $pdo->prepare("
            SELECT status, current_grave_id
            FROM interments
            WHERE interment_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $check->execute([$id]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            Response::error("Interment not found or already deleted.", 404);
        }

        // Pending rows must be cancelled through Monitor so the
        // reservation_details row is consumed properly.
        if ($row['status'] === 'Pending') {
            $pdo->rollBack();
            Response::error("Cannot delete a Pending interment. Cancel the reservation first via Monitor.", 400);
        }

        $graveId = $row['current_grave_id'] ? (int) $row['current_grave_id'] : null;
        if ($graveId) {
            lockGraveRows($pdo, [$graveId]);
        }

        // Refuse to delete an interment that is the displaced "old occupant"
        // of an active reservation: doing so would silently change a
        // replacement plan into a vacant-grave plan.  We check
        // old_interment_id specifically (not target_grave_id) so deleting a
        // bystander in a co-interment scenario stays allowed.
        $beingReplaced = $pdo->prepare("
            SELECT reservation_id FROM reservation_details
            WHERE old_interment_id = ?
              AND deleted_at IS NULL
              AND pending_interment_id IS NOT NULL
            LIMIT 1
        ");
        $beingReplaced->execute([$id]);
        if ($beingReplaced->fetch()) {
            $pdo->rollBack();
            Response::error(
                "Cannot delete this interment: it is the old occupant of an active reservation. "
                    . "Cancel the reservation via Monitor first.",
                409
            );
        }

        // Soft delete.  updated_at is bumped by the schema trigger.
        $updateSql = "
            UPDATE interments
            SET deleted_at = NOW(),
                updated_by = :updated_by
            WHERE interment_id = :id AND deleted_at IS NULL
        ";
        $stmt = $pdo->prepare($updateSql);
        $stmt->execute([
            ':id'         => $id,
            ':updated_by' => $userData['user_id'],
        ]);

        $graveFreed    = false;
        $pendingExists = false;

        if ($graveId) {
            // Derive the grave's new status atomically.  This replaces the old
            // read-then-write logic, which could leave a grave Occupied with
            // zero Active occupants when two deletes raced.
            $newGraveStatus = rederiveGraveStatus($pdo, $graveId);
            $graveFreed     = ($newGraveStatus === 'Vacant');

            // Informational: does an active reservation target this grave?
            // Deleting the occupant changes the reservation's shape
            // (replacement -> vacant-grave insertion).
            $pendingCheck = $pdo->prepare("
                SELECT reservation_id FROM reservation_details
                WHERE target_grave_id = ?
                  AND deleted_at IS NULL
                LIMIT 1
            ");
            $pendingCheck->execute([$graveId]);
            if ($pendingCheck->fetch()) {
                $pendingExists = true;
            }
        }

        $pdo->commit();
        systemLog(
            "Soft-deleted interment $id" . ($graveFreed ? " and freed grave $graveId" : ""),
            $userData['user_id']
        );

        Response::success("Interment deleted (soft delete).", [
            'interment_id'     => $id,
            'grave_id'         => $graveId,
            'grave_freed'      => $graveFreed,
            'pending_on_grave' => $pendingExists,
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Record deletion error: " . $e->getMessage(), 'System');
        Response::error("Database error while deleting record.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

// Anything else
Response::error("Method Not Allowed", 405);
