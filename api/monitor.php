<?php

/**
 * Monitor.php – View pending interments and execute them (activate)
 *
 * GET    /monitor.php         : List all pending interments (paginated).
 * GET    /monitor.php/{id}    : Get details of a specific pending interment.
 * POST   ?action=save_old_edits : Stage OLD occupant edits (incl. date of interment
 *                                 and the auto-calculated expiration date).
 * POST   ?action=save_new_edits : Stage NEW occupant edits on the Pending row.
 * POST   /monitor.php/{id}    : Execute a pending interment (confirm).
 * DELETE /monitor.php/{id}    : Cancel a pending interment (soft delete).
 *
 * IMPORTANT: the OLD occupant's "date_buried" and "lease_expiration_date"
 * edits are staged inside reservation_details.old_new_remarks.old_edits and
 * are applied to the interments row ONLY when Confirm runs.
 *
 * The Old Occupant's Exhumation Permit No. and Transfer Permit No. are also
 * staged — both in the JSON blob AND in the dedicated
 * reservation_details.exhumation_permit_number / transfer_permit_number
 * columns, which are the canonical source on read.
 *
 * CONCURRENCY
 *   - Execute (Confirm) and Cancel (DELETE) lock the pending interment row
 *     with SELECT ... FOR UPDATE, so two writers on the same pending row
 *     serialize instead of interleaving their writes.
 *   - The old occupant is read and locked FOR UPDATE *inside* the execute
 *     transaction (never on a stale snapshot taken before it).
 *   - Every grave whose status might change is locked FOR UPDATE first,
 *     in ascending grave_id order, to prevent deadlocks between concurrent
 *     requests that each touch the same pair of graves.
 *   - Grave status is re-derived from the interments table with a single
 *     atomic UPDATE (see rederiveGraveStatus), never set blindly.
 *   - save_old_edits / save_new_edits each run inside a transaction that
 *     locks their target row first, so a concurrent Confirm / Cancel cannot
 *     race them.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Forbidden.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

// -----------------------------------------------------------------------------
// Concurrency helpers – must be called inside an active transaction
// -----------------------------------------------------------------------------

/**
 * Take FOR UPDATE locks on one or more grave rows, in ascending grave_id
 * order, so two concurrent requests that each need the same pair of graves
 * cannot form a circular wait.
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
 * The caller MUST hold a FOR UPDATE lock on this grave row.
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

$formatTransfer = function ($row) {
    $newOccupant = [
        'interment_id'           => (int) $row['interment_id'],
        'control_number'         => $row['control_number'],
        'deceased_name'          => $row['deceased_name'],
        'last_known_address'     => $row['last_known_address'],
        'death_certificate'      => $row['death_certificate'],
        'deceased_date_of_birth' => $row['deceased_date_of_birth'],
        'deceased_date_of_death' => $row['deceased_date_of_death'],
        'current_grave_id'       => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,
        'contact_person_name'    => $row['contact_person_name'],
        'contact_person_phone_number' => $row['contact_person_phone_number'],
        'contact_person_email'   => $row['contact_person_email'],
        'assistance_type'        => $row['assistance_type'],
        'burial_permit_number'   => $row['burial_permit_number'],
        'burial_permit_date'     => $row['burial_permit_date'],
        'transfer_permit_number' => $row['transfer_permit_number'],
        'transfer_permit_issued_by' => $row['transfer_permit_issued_by'],
        'transfer_permit_date'   => $row['transfer_permit_date'],
        'exhumation_permit_number' => $row['exhumation_permit_number'],
        'exhumation_permit_date' => $row['exhumation_permit_date'],
        'date_buried'            => $row['date_buried'],
        'date_exhumed'           => $row['date_exhumed'],
        'burial_clearance_date'  => $row['burial_clearance_date'],
        'lease_expiration_date'  => $row['lease_expiration_date'],
        'status'                 => $row['status'],
        'remarks'                => $row['remarks'],
        'deceased_sex'             => $row['deceased_sex'],
        'contact_person_address'   => $row['contact_person_address'],
        'contact_person_address_barangay' => $row['contact_person_address_barangay']
    ];

    $oldOccupant = null;
    if ($row['old_interment_id']) {
        $oldOccupant = [
            'interment_id'           => (int) $row['old_interment_id'],
            'control_number'         => $row['old_control_number'],
            'deceased_name'          => $row['old_deceased_name'],
            'last_known_address'     => $row['old_last_known_address'],
            'death_certificate'      => $row['old_death_certificate'],
            'deceased_date_of_birth' => $row['old_deceased_date_of_birth'],
            'deceased_date_of_death' => $row['old_deceased_date_of_death'],
            'current_grave_id'       => $row['old_current_grave_id'] ? (int) $row['old_current_grave_id'] : null,
            'contact_person_name'    => $row['old_contact_person_name'],
            'contact_person_phone_number' => $row['old_contact_person_phone_number'],
            'contact_person_email'   => $row['old_contact_person_email'],
            'assistance_type'        => $row['old_assistance_type'],
            'burial_permit_number'   => $row['old_burial_permit_number'],
            'burial_permit_date'     => $row['old_burial_permit_date'],
            'transfer_permit_number' => $row['old_transfer_permit_number'],
            'transfer_permit_issued_by' => $row['old_transfer_permit_issued_by'],
            'transfer_permit_date'   => $row['old_transfer_permit_date'],
            'exhumation_permit_number' => $row['old_exhumation_permit_number'],
            'exhumation_permit_date' => $row['old_exhumation_permit_date'],
            'date_buried'            => $row['old_date_buried'],
            'date_exhumed'           => $row['old_date_exhumed'],
            'burial_clearance_date'  => $row['old_burial_clearance_date'],
            'lease_expiration_date'  => $row['old_lease_expiration_date'],
            'status'                 => $row['old_status'],
            'remarks'                => $row['old_remarks'],
            'deceased_sex'             => $row['old_deceased_sex'],
            'contact_person_address'   => $row['old_contact_person_address'],
            'contact_person_address_barangay' => $row['old_contact_person_address_barangay'],

            'planned_new_grave_id'        => $row['old_new_grave_id'] ? (int) $row['old_new_grave_id'] : null,
            'planned_new_status'          => $row['old_new_status'],
            'planned_new_assistance_type' => $row['old_new_assistance_type'],
            'planned_new_remarks'         => $row['old_new_remarks'],

            // Staged Old-Occupant permit values. Dedicated columns are the
            // canonical source; the JSON blob is a compatibility fallback.
            'planned_exhumation_permit_number' => $row['old_new_exhumation_permit_number'] ?? null,
            'planned_transfer_permit_number'   => $row['old_new_transfer_permit_number']   ?? null,

            'planned_grave_code'          => $row['old_new_grave_code']  ?? null,
            'planned_block_name'          => $row['old_new_block_name']  ?? null,
            'planned_block_type'          => $row['old_new_block_type']  ?? null,
        ];
    }

    $grave = [
        'grave_id'      => $row['target_grave_id'] ? (int) $row['target_grave_id'] : null,
        'grave_code'    => $row['grave_code'],
        'row_num'       => $row['row_num'] ? (int) $row['row_num'] : null,
        'col_num'       => $row['col_num'] ? (int) $row['col_num'] : null,
        'grave_status'  => $row['grave_status'],
        'grave_remarks' => $row['grave_remarks'],
        'block_id'      => $row['block_id'] ? (int) $row['block_id'] : null,
        'block_name'    => $row['block_name'],
        'block_type'    => $row['block_type'],
    ];

    return [
        'reservation_id' => $row['reservation_id'] ? (int) $row['reservation_id'] : null,
        'type'           => $oldOccupant ? 'replacement' : 'vacant',
        'new_occupant'   => $newOccupant,
        'old_occupant'   => $oldOccupant,
        'target_grave'   => $grave,
    ];
};

// -----------------------------------------------------------------------------
// GET
// -----------------------------------------------------------------------------
if ($method === 'GET') {
    $baseSql = "
        SELECT
            p.*,
            rd.reservation_id, rd.target_grave_id, rd.old_interment_id,
            rd.old_new_grave_id, rd.old_new_status, rd.old_new_assistance_type, rd.old_new_remarks,
            rd.exhumation_permit_number AS old_new_exhumation_permit_number,
            rd.transfer_permit_number   AS old_new_transfer_permit_number,

            o.control_number AS old_control_number, o.deceased_name AS old_deceased_name,
            o.last_known_address AS old_last_known_address, o.death_certificate AS old_death_certificate,
            o.deceased_date_of_birth AS old_deceased_date_of_birth, o.deceased_date_of_death AS old_deceased_date_of_death,
            o.current_grave_id AS old_current_grave_id,
            o.contact_person_name AS old_contact_person_name, o.contact_person_phone_number AS old_contact_person_phone_number,
            o.contact_person_email AS old_contact_person_email, o.assistance_type AS old_assistance_type,
            o.burial_permit_number AS old_burial_permit_number, o.burial_permit_date AS old_burial_permit_date,
            o.transfer_permit_number AS old_transfer_permit_number, o.transfer_permit_issued_by AS old_transfer_permit_issued_by,
            o.transfer_permit_date AS old_transfer_permit_date, o.exhumation_permit_number AS old_exhumation_permit_number,
            o.exhumation_permit_date AS old_exhumation_permit_date, o.date_buried AS old_date_buried,
            o.date_exhumed AS old_date_exhumed, o.burial_clearance_date AS old_burial_clearance_date,
            o.lease_expiration_date AS old_lease_expiration_date, o.status AS old_status, o.remarks AS old_remarks,
            o.contact_person_address AS old_contact_person_address, o.deceased_sex AS old_deceased_sex,
            o.contact_person_address_barangay AS old_contact_person_address_barangay,

            ong.grave_code  AS old_new_grave_code,
            onb.block_name  AS old_new_block_name,
            onb.block_type  AS old_new_block_type,

            g.grave_code, g.row_num, g.col_num, g.status AS grave_status, g.remarks AS grave_remarks,
            b.block_name, b.block_id, b.block_type
        FROM interments p
        INNER JOIN reservation_details rd
            ON rd.pending_interment_id = p.interment_id
            AND rd.deleted_at IS NULL
        LEFT JOIN interments o ON o.interment_id = rd.old_interment_id AND o.deleted_at IS NULL
        LEFT JOIN graves g     ON g.grave_id      = rd.target_grave_id  AND g.deleted_at IS NULL
        LEFT JOIN blocks b     ON b.block_id      = g.block_id          AND b.deleted_at IS NULL
        LEFT JOIN graves ong   ON ong.grave_id    = rd.old_new_grave_id AND ong.deleted_at IS NULL
        LEFT JOIN blocks onb   ON onb.block_id    = ong.block_id        AND onb.deleted_at IS NULL
        WHERE p.status = 'Pending'
          AND p.deleted_at IS NULL
    ";

    if ($resourceId) {
        $stmt = $pdo->prepare($baseSql . " AND p.interment_id = :id");
        $stmt->execute(['id' => $resourceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            Response::success('Pending transfer retrieved', ['transfer' => $formatTransfer($row)]);
        } else {
            Response::error('Pending transfer not found.', 404);
        }
    } else {
        $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
        $page  = max(1, (int) ($_GET['page'] ?? 1));

        $searchSQL    = '';
        $searchParams = [];

        if ($searchTerm !== '') {
            $like = '%' . $searchTerm . '%';

            $searchCols = [
                'p.control_number',
                'p.deceased_name',
                'p.deceased_sex',
                'p.last_known_address',
                'p.death_certificate',
                'p.contact_person_name',
                'p.contact_person_phone_number',
                'p.contact_person_email',
                'p.contact_person_address',
                'p.contact_person_address_barangay',
                'p.assistance_type',
                'p.burial_permit_number',
                'p.transfer_permit_number',
                'p.transfer_permit_issued_by',
                'p.exhumation_permit_number',
                'p.status',
                'p.remarks',

                'o.control_number',
                'o.deceased_name',
                'o.deceased_sex',
                'o.last_known_address',
                'o.death_certificate',
                'o.contact_person_name',
                'o.contact_person_phone_number',
                'o.contact_person_email',
                'o.contact_person_address',
                'o.contact_person_address_barangay',
                'o.assistance_type',
                'o.burial_permit_number',
                'o.transfer_permit_number',
                'o.transfer_permit_issued_by',
                'o.exhumation_permit_number',
                'o.status',
                'o.remarks',

                'rd.old_new_remarks',
                'rd.old_new_status',
                'rd.old_new_assistance_type',
                'rd.exhumation_permit_number',
                'rd.transfer_permit_number',

                'g.grave_code',
                'g.status',
                'g.remarks',
                'b.block_name',
                'b.block_type',
                'ong.grave_code',
                'onb.block_name',
                'onb.block_type',
            ];

            $parts = [];
            foreach ($searchCols as $c) {
                $parts[] = "$c LIKE ?";
                $searchParams[] = $like;
            }
            $searchSQL = ' AND (' . implode(' OR ', $parts) . ')';
        }

        $filteredSql = $baseSql . $searchSQL;

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($filteredSql) AS combined");
        $countStmt->execute($searchParams);
        $totalRecords = (int) $countStmt->fetchColumn();

        $totalPages = (int) ceil($totalRecords / $limit);
        $page       = min($page, max(1, $totalPages));
        $offset     = ($page - 1) * $limit;

        $pageSql = $filteredSql . " ORDER BY p.interment_id ASC LIMIT $limit OFFSET $offset";
        $pageStmt = $pdo->prepare($pageSql);
        $pageStmt->execute($searchParams);
        $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

        $pendingTransfers = array_map($formatTransfer, $rows);

        $payload = [
            'pagination' => [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ],
            'transfers'  => $pendingTransfers,
        ];
        if ($searchTerm !== '') {
            $payload['search_term'] = $searchTerm;
        }

        Response::success('Pending transfers retrieved', $payload);
    }
}

// -----------------------------------------------------------------------------
// POST
// -----------------------------------------------------------------------------
if ($method === 'POST') {

    // =========================================================================
    // POST ?action=save_old_edits
    //     Stages Old Occupant edits — including Date of Interment and the
    //     auto-calculated Expiration Date — inside reservation_details.
    //     The Old Occupant's Exhumation Permit No. and Transfer Permit No.
    //     are also written to their dedicated columns.
    //
    //     CONCURRENCY: the reservation_details row is locked FOR UPDATE for
    //     the duration of the transaction, so two concurrent saves cannot
    //     interleave their JSON blob writes.
    // =========================================================================
    if (isset($_GET['action']) && $_GET['action'] === 'save_old_edits') {

        $reservationId = isset($rawData['reservation_id']) && is_numeric($rawData['reservation_id'])
            ? (int) $rawData['reservation_id'] : 0;
        if (!$reservationId) {
            Response::error("reservation_id is required.", 400);
        }

        $pdo->beginTransaction();
        try {
            // Lock the reservation row for the whole edit.
            $rdStmt = $pdo->prepare("
                SELECT * FROM reservation_details
                WHERE reservation_id = ? AND deleted_at IS NULL
                FOR UPDATE
            ");
            $rdStmt->execute([$reservationId]);
            $rd = $rdStmt->fetch(PDO::FETCH_ASSOC);
            if (!$rd) {
                $pdo->rollBack();
                Response::error("Reservation not found.", 404);
            }

            $existing = [];
            if (!empty($rd['old_new_remarks'])) {
                $decoded = json_decode($rd['old_new_remarks'], true);
                if (is_array($decoded)) {
                    $existing = $decoded;
                } else {
                    $existing = ['burial_type' => '', 'remarks' => (string) $rd['old_new_remarks']];
                }
            }
            if (!isset($existing['burial_type'])) $existing['burial_type'] = '';
            if (!isset($existing['remarks']))     $existing['remarks']     = '';

            // Editable fields — includes date_buried and lease_expiration_date
            // so Confirm can apply them to the interments row.
            $oldEdits = [
                'deceased_name'                  => $rawData['deceased_name']                  ?? null,
                'deceased_sex'                   => $rawData['deceased_sex']                   ?? null,
                'deceased_date_of_birth'         => $rawData['deceased_date_of_birth']         ?? null,
                'deceased_date_of_death'         => $rawData['deceased_date_of_death']         ?? null,
                'last_known_address'             => $rawData['last_known_address']             ?? null,
                'death_certificate'              => $rawData['death_certificate']              ?? null,
                'contact_person_name'            => $rawData['contact_person_name']            ?? null,
                'contact_person_phone_number'    => $rawData['contact_person_phone_number']    ?? null,
                'contact_person_address'         => $rawData['contact_person_address']         ?? null,
                'contact_person_address_barangay' => $rawData['contact_person_address_barangay'] ?? null,
                'assistance_type'                => $rawData['assistance_type']                ?? null,
                'burial_permit_number'           => $rawData['burial_permit_number']           ?? null,
                'exhumation_permit_number'       => $rawData['exhumation_permit_number']       ?? null,
                'transfer_permit_number'         => $rawData['transfer_permit_number']         ?? null,
                'date_buried'                    => $rawData['date_buried']                    ?? null,
                'lease_expiration_date'          => $rawData['lease_expiration_date']          ?? null,
                'burial_clearance_date'          => $rawData['burial_clearance_date']          ?? null,
                'remarks'                        => $rawData['remarks']                        ?? null,
            ];

            if (!empty($rawData['block_type'])) {
                $existing['burial_type'] = (string) $rawData['block_type'];
            }
            if (!empty($rawData['remarks'])) {
                $existing['remarks'] = (string) $rawData['remarks'];
            }
            // Also mirror the date fields at the top level so Reserve's parser
            // can read them without having to look inside old_edits.
            if (!empty($rawData['date_buried'])) {
                $existing['date_interment'] = (string) $rawData['date_buried'];
            }
            if (!empty($rawData['lease_expiration_date'])) {
                $existing['expiration_date'] = (string) $rawData['lease_expiration_date'];
            }
            // Mirror the permit fields at the top level too, matching the shape
            // Reserve's update_reservation_plan writes.
            if (isset($rawData['exhumation_permit_number'])) {
                $existing['exhumation_permit_number'] = (string) $rawData['exhumation_permit_number'];
            }
            if (isset($rawData['transfer_permit_number'])) {
                $existing['transfer_permit_number'] = (string) $rawData['transfer_permit_number'];
            }

            $existing['old_edits'] = $oldEdits;

            $newJson = json_encode($existing, JSON_UNESCAPED_UNICODE);

            // Dedicated columns — NULL when blank, so the "blank stays blank"
            // contract holds on read.
            $exhumationPermitCol = isset($rawData['exhumation_permit_number']) && $rawData['exhumation_permit_number'] !== ''
                ? (string) $rawData['exhumation_permit_number'] : null;
            $transferPermitCol   = isset($rawData['transfer_permit_number']) && $rawData['transfer_permit_number'] !== ''
                ? (string) $rawData['transfer_permit_number'] : null;

            $upd = $pdo->prepare("
                UPDATE reservation_details
                SET old_new_remarks = ?,
                    exhumation_permit_number = ?,
                    transfer_permit_number = ?,
                    updated_by = ?
                WHERE reservation_id = ?
            ");
            $upd->execute([$newJson, $exhumationPermitCol, $transferPermitCol, $userData['user_id'], $reservationId]);

            if (!empty($rawData['grave_code'])) {
                $code = trim((string) $rawData['grave_code']);
                $gs = $pdo->prepare("
                    SELECT grave_id FROM graves
                    WHERE grave_code = ? AND deleted_at IS NULL
                ");
                $gs->execute([$code]);
                $gid = $gs->fetchColumn();

                // A typo'd grave code used to be silently ignored — the caller
                // got a 200 "saved" while the destination was never set. Reject
                // the request instead so the UI can surface the error.
                if ($gid === false) {
                    $pdo->rollBack();
                    Response::error("Grave code '$code' not found.", 400);
                }

                $upd2 = $pdo->prepare("
                    UPDATE reservation_details
                    SET old_new_grave_id = ?, old_new_status = 'Active'
                    WHERE reservation_id = ?
                ");
                $upd2->execute([(int) $gid, $reservationId]);
            }

            $pdo->commit();
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            systemLog("Old-occupant edit save error: " . $e->getMessage(), 'System');
            Response::error("Database error while saving old occupant edits.", 500);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            systemLog("Old-occupant edit save error: " . $e->getMessage(), 'System');
            Response::error($e->getMessage(), 409);
        }

        Response::success("Old occupant edits saved.", ['reservation_id' => $reservationId]);
    }

    // =========================================================================
    // POST ?action=save_new_edits
    //
    // CONCURRENCY: the pending interment row is locked FOR UPDATE inside a
    // transaction and its status is re-verified under the lock, so a
    // concurrent Confirm / Cancel cannot promote or cancel the row while an
    // edit is mid-flight.
    // =========================================================================
    if (isset($_GET['action']) && $_GET['action'] === 'save_new_edits') {

        $pendingId = isset($rawData['pending_interment_id']) && is_numeric($rawData['pending_interment_id'])
            ? (int) $rawData['pending_interment_id'] : 0;
        if (!$pendingId) {
            Response::error("pending_interment_id is required.", 400);
        }

        $fields = [
            'control_number',
            'deceased_name',
            'deceased_sex',
            'deceased_date_of_birth',
            'deceased_date_of_death',
            'last_known_address',
            'death_certificate',
            'contact_person_name',
            'contact_person_phone_number',
            'contact_person_address',
            'contact_person_address_barangay',
            'assistance_type',
            'burial_permit_number',
            'exhumation_permit_number',
            'transfer_permit_number',
            'date_buried',
            'lease_expiration_date',
            'burial_clearance_date',
            'remarks'
        ];

        $updates = [];
        $params  = [];
        foreach ($fields as $f) {
            if (array_key_exists($f, $rawData)) {
                $updates[] = "$f = ?";
                $params[]  = $rawData[$f] !== '' ? $rawData[$f] : null;
            }
        }

        if (empty($updates)) {
            Response::success("Nothing to update.", ['pending_interment_id' => $pendingId]);
        }

        $updates[] = "updated_by = ?";
        $params[]  = $userData['user_id'];
        $params[]  = $pendingId;

        $pdo->beginTransaction();
        try {
            // Lock the pending interment row and confirm it is still Pending.
            $chk = $pdo->prepare("
                SELECT status FROM interments
                WHERE interment_id = ? AND deleted_at IS NULL
                FOR UPDATE
            ");
            $chk->execute([$pendingId]);
            $row = $chk->fetch(PDO::FETCH_ASSOC);
            if (!$row) {
                $pdo->rollBack();
                Response::error("Pending interment not found.", 404);
            }
            if ($row['status'] !== 'Pending') {
                $pdo->rollBack();
                Response::error("Only Pending interments can be edited here.", 400);
            }

            $stmt = $pdo->prepare(
                "UPDATE interments SET " . implode(', ', $updates) . " WHERE interment_id = ?"
            );
            $stmt->execute($params);

            $pdo->commit();
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            systemLog("New-occupant edit save error: " . $e->getMessage(), 'System');
            Response::error("Database error while saving new occupant edits.", 500);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            systemLog("New-occupant edit save error: " . $e->getMessage(), 'System');
            Response::error($e->getMessage(), 409);
        }

        Response::success("New occupant edits saved.", ['pending_interment_id' => $pendingId]);
    }

    // =========================================================================
    // POST /monitor.php/{id}  →  Execute (Confirm)
    // =========================================================================
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['pending_interment_id'] = $resourceId;
    }

    if (empty($rawData['pending_interment_id'])) {
        Response::error("pending_interment_id is required.", 400);
    }
    $pendingId = (int) $rawData['pending_interment_id'];

    $pendingStmt = $pdo->prepare("
        SELECT * FROM interments
        WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
    ");
    $pendingStmt->execute([$pendingId]);
    $pending = $pendingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$pending) {
        Response::error("Pending interment not found or not in Pending status.", 404);
    }

    $rdStmt = $pdo->prepare("
        SELECT * FROM reservation_details
        WHERE pending_interment_id = ? AND deleted_at IS NULL
    ");
    $rdStmt->execute([$pendingId]);
    $rd = $rdStmt->fetch(PDO::FETCH_ASSOC);
    if (!$rd) {
        Response::error("No active reservation found for this pending interment.", 404);
    }

    $reservationId  = (int) $rd['reservation_id'];
    $targetGraveId  = (int) $rd['target_grave_id'];
    $oldIntermentId = $rd['old_interment_id'] ? (int) $rd['old_interment_id'] : null;

    $oldEdits = [];
    if (!empty($rd['old_new_remarks'])) {
        $decoded = json_decode($rd['old_new_remarks'], true);
        if (is_array($decoded)) {
            if (isset($decoded['old_edits']) && is_array($decoded['old_edits'])) {
                $oldEdits = $decoded['old_edits'];
            }
            // Pick up permit values staged by Reserve's update_reservation_plan
            // action, which stores them at the top level of the JSON blob.
            if (empty($oldEdits['exhumation_permit_number']) && !empty($decoded['exhumation_permit_number'])) {
                $oldEdits['exhumation_permit_number'] = $decoded['exhumation_permit_number'];
            }
            if (empty($oldEdits['transfer_permit_number']) && !empty($decoded['transfer_permit_number'])) {
                $oldEdits['transfer_permit_number'] = $decoded['transfer_permit_number'];
            }
        }
    }

    // The dedicated columns are the canonical storage for the staged
    // old-occupant permit values, so they take the highest priority.
    if (!empty($rd['exhumation_permit_number'])) {
        $oldEdits['exhumation_permit_number'] = $rd['exhumation_permit_number'];
    }
    if (!empty($rd['transfer_permit_number'])) {
        $oldEdits['transfer_permit_number'] = $rd['transfer_permit_number'];
    }

    $pdo->beginTransaction();
    try {

        // ---- 1. Lock the pending interment row so concurrent POST / DELETE
        //         on the same pending interment serialize. The re-check under
        //         the lock catches a request that slipped in between our
        //         pre-transaction read and now. ----
        $lockStmt = $pdo->prepare("
            SELECT interment_id FROM interments
            WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
            FOR UPDATE
        ");
        $lockStmt->execute([$pendingId]);
        if (!$lockStmt->fetch()) {
            throw new Exception(
                "Pending interment is no longer Pending (already processed by another request)."
            );
        }

        // ---- 2. Lock & re-read the old occupant INSIDE the transaction. The
        //         pre-transaction read we used to do could be stale: Records
        //         DELETE / PUT could have moved or soft-deleted the old
        //         occupant between then and now. ----
        $old = null;
        if ($oldIntermentId) {
            $oldStmt = $pdo->prepare("
                SELECT * FROM interments
                WHERE interment_id = ? AND status = 'Active' AND deleted_at IS NULL
                FOR UPDATE
            ");
            $oldStmt->execute([$oldIntermentId]);
            $old = $oldStmt->fetch(PDO::FETCH_ASSOC);
            if (!$old) {
                systemLog(
                    "Reservation $reservationId references old occupant $oldIntermentId who is no longer Active; proceeding as vacant-grave execution.",
                    $userData['user_id']
                );
            }
        }

        // ---- 3. Determine which graves we might touch, and lock them all in
        //         ascending grave_id order BEFORE we reason about occupancy.
        //         This is what prevents concurrent Records / Reserve requests
        //         from sliding into the destination grave while we validate it.
        $gravesToLock = [$targetGraveId];
        if ($old) {
            $peekOldUpdate = $rawData['old_occupant_update'] ?? [];
            $peekOldNewGraveId = array_key_exists('new_current_grave_id', $peekOldUpdate)
                ? (($peekOldUpdate['new_current_grave_id'] !== null && $peekOldUpdate['new_current_grave_id'] !== '')
                    ? (int) $peekOldUpdate['new_current_grave_id']
                    : null)
                : ($rd['old_new_grave_id'] ? (int) $rd['old_new_grave_id'] : null);
            if ($peekOldNewGraveId) {
                $gravesToLock[] = $peekOldNewGraveId;
            }
        }
        lockGraveRows($pdo, $gravesToLock);

        if ($old) {
            $oldUpdate = $rawData['old_occupant_update'] ?? [];

            $oldNewStatus = $oldUpdate['status']
                ?? $rd['old_new_status']
                ?? ($rd['old_new_grave_id'] ? 'Active' : 'Inactive');

            $oldNewGraveId = array_key_exists('new_current_grave_id', $oldUpdate)
                ? ($oldUpdate['new_current_grave_id'] !== null && $oldUpdate['new_current_grave_id'] !== ''
                    ? (int) $oldUpdate['new_current_grave_id']
                    : null)
                : ($rd['old_new_grave_id'] ? (int) $rd['old_new_grave_id'] : null);

            $oldNewAssistanceType = array_key_exists('assistance_type', $oldUpdate)
                ? $oldUpdate['assistance_type']
                : ($rd['old_new_assistance_type'] ?? null);

            // Human-readable remarks only — never the raw JSON blob.
            $planRemarksText = '';
            if (!empty($rd['old_new_remarks'])) {
                $decodedPlan = json_decode($rd['old_new_remarks'], true);
                if (is_array($decodedPlan)) {
                    $planRemarksText = (string) ($decodedPlan['remarks'] ?? '');
                } else {
                    $planRemarksText = (string) $rd['old_new_remarks'];
                }
            }

            $oldRemarks = trim(
                $oldUpdate['remarks']
                    ?? $planRemarksText
            );

            if (!in_array($oldNewStatus, ['Active', 'Inactive'], true)) {
                throw new Exception("Invalid old occupant status. Must be Active or Inactive.");
            }

            if ($oldNewStatus === 'Active') {
                if ($oldNewGraveId) {
                    if ((int) $oldNewGraveId === $targetGraveId) {
                        throw new Exception("Old occupant cannot stay in the same grave being reserved.");
                    }
                    // We already hold the FOR UPDATE lock on $oldNewGraveId,
                    // so this vacancy check is now race-free.
                    $checkNew = $pdo->prepare("
                        SELECT status FROM graves
                        WHERE grave_id = ? AND status = 'Vacant' AND deleted_at IS NULL
                          AND NOT EXISTS (SELECT 1 FROM interments WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL)
                    ");
                    $checkNew->execute([$oldNewGraveId, $oldNewGraveId]);
                    if (!$checkNew->fetch()) {
                        throw new Exception("The destination grave for the old occupant is not vacant or does not exist.");
                    }

                    // Move first (fires the trigger with original remarks),
                    // then apply assistance_type / remarks separately.
                    $moveStmt = $pdo->prepare("
                        UPDATE interments
                        SET current_grave_id = ?, status = 'Active', updated_by = ?
                        WHERE interment_id = ?
                    ");
                    $moveStmt->execute([$oldNewGraveId, $userData['user_id'], $old['interment_id']]);

                    $setClauses = [];
                    $setParams  = [];
                    if ($oldNewAssistanceType !== null) {
                        $setClauses[] = 'assistance_type = ?';
                        $setParams[]  = $oldNewAssistanceType;
                    }
                    if ($oldRemarks !== '') {
                        $setClauses[] = "remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)";
                        $setParams[]  = $oldRemarks;
                    }
                    if (!empty($setClauses)) {
                        $setClauses[] = 'updated_by = ?';
                        $setParams[]  = $userData['user_id'];
                        $setParams[]  = $old['interment_id'];

                        $tail = $pdo->prepare(
                            "UPDATE interments SET " . implode(', ', $setClauses) . " WHERE interment_id = ?"
                        );
                        $tail->execute($setParams);
                    }

                    // Derive rather than blindly set — idempotent and safe
                    // even if a co-interment already occupies this grave.
                    rederiveGraveStatus($pdo, (int) $oldNewGraveId);
                } else {
                    $setClauses = ['current_grave_id = NULL', "status = 'Active'"];
                    $setParams  = [];

                    if ($oldNewAssistanceType !== null) {
                        $setClauses[] = 'assistance_type = ?';
                        $setParams[]  = $oldNewAssistanceType;
                    }
                    if ($oldRemarks !== '') {
                        $setClauses[] = "remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)";
                        $setParams[]  = $oldRemarks;
                    }
                    $setClauses[] = 'updated_by = ?';
                    $setParams[]  = $userData['user_id'];
                    $setParams[]  = $old['interment_id'];

                    $updateOld = $pdo->prepare(
                        "UPDATE interments SET " . implode(', ', $setClauses) . " WHERE interment_id = ?"
                    );
                    $updateOld->execute($setParams);
                }
            } else {
                $setClauses = ['current_grave_id = NULL', "status = 'Inactive'"];
                $setParams  = [];

                if ($oldNewAssistanceType !== null) {
                    $setClauses[] = 'assistance_type = ?';
                    $setParams[]  = $oldNewAssistanceType;
                }
                if ($oldRemarks !== '') {
                    $setClauses[] = "remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)";
                    $setParams[]  = $oldRemarks;
                }
                $setClauses[] = 'updated_by = ?';
                $setParams[]  = $userData['user_id'];
                $setParams[]  = $old['interment_id'];

                $updateOld = $pdo->prepare(
                    "UPDATE interments SET " . implode(', ', $setClauses) . " WHERE interment_id = ?"
                );
                $updateOld->execute($setParams);
            }

            // Apply staged edits, including the Date of Interment and the
            // auto-calculated Expiration Date.
            if (!empty($oldEdits)) {
                $editableOldFields = [
                    'deceased_name',
                    'deceased_sex',
                    'deceased_date_of_birth',
                    'deceased_date_of_death',
                    'last_known_address',
                    'death_certificate',
                    'contact_person_name',
                    'contact_person_phone_number',
                    'contact_person_address',
                    'contact_person_address_barangay',
                    'assistance_type',
                    'burial_permit_number',
                    'exhumation_permit_number',
                    'transfer_permit_number',
                    'date_buried',
                    'lease_expiration_date',
                    'burial_clearance_date',
                    'remarks'
                ];

                $editUpdates = [];
                $editParams  = [];
                foreach ($editableOldFields as $f) {
                    if (array_key_exists($f, $oldEdits) && $oldEdits[$f] !== null && $oldEdits[$f] !== '') {
                        $editUpdates[] = "$f = ?";
                        $editParams[]  = $oldEdits[$f];
                    }
                }

                if (!empty($editUpdates)) {
                    $editUpdates[] = "updated_by = ?";
                    $editParams[]  = $userData['user_id'];
                    $editParams[]  = $old['interment_id'];

                    $applyEdits = $pdo->prepare(
                        "UPDATE interments SET " . implode(', ', $editUpdates) . " WHERE interment_id = ?"
                    );
                    $applyEdits->execute($editParams);
                }
            }
        }

        // Execute the pending interment (new occupant).
        $updatePending = $pdo->prepare("
            UPDATE interments
            SET status = 'Active', current_grave_id = ?, updated_by = ?
            WHERE interment_id = ?
        ");
        $updatePending->execute([$targetGraveId, $userData['user_id'], $pendingId]);

        if ($targetGraveId) {
            // Derive rather than blindly set — idempotent, and correct even
            // if the target grave already has other Active co-interments.
            rederiveGraveStatus($pdo, $targetGraveId);
        }

        $delStmt = $pdo->prepare("DELETE FROM reservation_details WHERE reservation_id = ?");
        $delStmt->execute([$reservationId]);

        $pdo->commit();
        systemLog(
            "Transfer executed: pending $pendingId activated to grave $targetGraveId." .
                ($old ? " Old occupant {$old['interment_id']} updated." : ""),
            $userData['user_id']
        );

        Response::success("Transfer executed successfully.", [
            'pending_interment_id' => $pendingId,
            'target_grave_id'      => $targetGraveId,
            'old_interment_id'     => $old ? $old['interment_id'] : null,
            'type'                 => $old ? 'replacement' : 'vacant'
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Monitor Database error: " . $e->getMessage(), 'System');
        Response::error("Database error while executing transfer.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Monitor execution error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 400);
    }
}

// -----------------------------------------------------------------------------
// DELETE
// -----------------------------------------------------------------------------
if ($method === 'DELETE') {
    $pendingId = null;
    if ($resourceId && is_numeric($resourceId)) {
        $pendingId = (int) $resourceId;
    } elseif (isset($_GET['pending_interment_id']) && is_numeric($_GET['pending_interment_id'])) {
        $pendingId = (int) $_GET['pending_interment_id'];
    } elseif (isset($rawData['pending_interment_id']) && is_numeric($rawData['pending_interment_id'])) {
        $pendingId = (int) $rawData['pending_interment_id'];
    } else {
        Response::error("pending_interment_id is required.", 400);
    }

    $pendingStmt = $pdo->prepare("
        SELECT * FROM interments
        WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
    ");
    $pendingStmt->execute([$pendingId]);
    $pending = $pendingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$pending) {
        Response::error("Pending interment not found or already processed.", 404);
    }

    $rdStmt = $pdo->prepare("
        SELECT reservation_id, target_grave_id, old_interment_id
        FROM reservation_details
        WHERE pending_interment_id = ? AND deleted_at IS NULL
    ");
    $rdStmt->execute([$pendingId]);
    $rd = $rdStmt->fetch(PDO::FETCH_ASSOC);

    $reservationId  = $rd ? (int) $rd['reservation_id'] : null;
    $targetGraveId  = ($rd && $rd['target_grave_id'])  ? (int) $rd['target_grave_id']  : null;
    $oldIntermentId = ($rd && $rd['old_interment_id']) ? (int) $rd['old_interment_id'] : null;

    $graveFreed = false;

    $pdo->beginTransaction();
    try {

        // ---- 1. Lock the pending interment row so a concurrent POST (execute)
        //         cannot interleave with this cancellation. ----
        $lockStmt = $pdo->prepare("
            SELECT interment_id FROM interments
            WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
            FOR UPDATE
        ");
        $lockStmt->execute([$pendingId]);
        if (!$lockStmt->fetch()) {
            throw new Exception(
                "Pending interment is no longer Pending (already processed by another request)."
            );
        }

        // ---- 2. Lock the target grave before reasoning about its status. ----
        if ($targetGraveId) {
            lockGraveRows($pdo, [$targetGraveId]);
        }

        $cancelRemark = "Cancelled on " . date('Y-m-d H:i:s');

        // current_grave_id is explicitly cleared so the chk_status_grave
        // CHECK (status = 'Active' OR current_grave_id IS NULL) always
        // passes, even if the pending row unexpectedly had a grave
        // attached due to data drift.
        $del = $pdo->prepare("
            UPDATE interments
            SET status = 'Inactive',
                current_grave_id = NULL,
                deleted_at = NOW(),
                remarks = CONCAT(COALESCE(remarks, ''), ' ', ?),
                updated_by = ?
            WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
        ");
        $del->execute([$cancelRemark, $userData['user_id'], $pendingId]);

        if ($targetGraveId) {
            // Derive the new status atomically. Replaces the previous
            // read-then-write pattern, which could leave a grave Occupied
            // with zero Active occupants when two requests raced.
            $newGraveStatus = rederiveGraveStatus($pdo, $targetGraveId);
            $graveFreed     = ($newGraveStatus === 'Vacant');
        }

        if ($reservationId) {
            $softDel = $pdo->prepare("
                UPDATE reservation_details
                SET deleted_at = NOW(),
                    updated_by = ?
                WHERE reservation_id = ?
            ");
            $softDel->execute([$userData['user_id'], $reservationId]);
        }

        $pdo->commit();

        systemLog(
            "Cancelled pending interment $pendingId (soft-deleted). " .
                ($oldIntermentId ? "Old occupant $oldIntermentId returned to Reserve." : ""),
            $userData['user_id']
        );

        Response::success("Pending interment cancelled.", [
            'pending_interment_id' => $pendingId,
            'target_grave_id'      => $targetGraveId,
            'old_interment_id'     => $oldIntermentId,
            'grave_freed'          => $graveFreed,
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Monitor cancellation error: " . $e->getMessage(), 'System');
        Response::error("Database error while cancelling.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Monitor cancellation error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

Response::error("Method Not Allowed", 405);
