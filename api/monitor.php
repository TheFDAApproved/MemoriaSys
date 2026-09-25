<?php

/**
 * Monitor.php – View pending interments and execute them (activate)
 * 
 * GET    /monitor.php      : List all pending interments (paginated).
 * GET    /monitor.php/{id} : Get details of a specific pending interment.
 * POST   /monitor.php/{id} : Execute a pending interment (activate it).
 * DELETE /monitor.php/{id} : Cancel a pending interment.
 *
 * NOTE (schema v2):
 *   - interments.transfer_to_grave no longer exists.
 *   - The plan lives in reservation_details (one row per active reservation).
 *   - Executing a reservation APPLIES the plan to the old occupant's row,
 *     then CONSUMES the reservation row.
 *   - Cancelling simply CONSUMES the reservation row; nothing needs reverting.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

// Only Admin and Office
$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE])) {
    Response::error("Forbidden.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// Parse path: /monitor.php/{id}
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

// Helper closure to format the transfer item
$formatTransfer = function ($row) {
    // New occupant (Pending) – identity data from interments p.
    // NOTE: transfer_to_grave removed; the target comes from reservation_details.
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

    // Old occupant (if any) – identity from interments o, planned changes from
    // reservation_details. The planned_* fields are what Monitor will APPLY on
    // execution (unless the frontend overrides them).
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

            // Planned changes (from reservation_details):
            'planned_new_grave_id'        => $row['old_new_grave_id'] ? (int) $row['old_new_grave_id'] : null,
            'planned_new_status'          => $row['old_new_status'],
            'planned_new_assistance_type' => $row['old_new_assistance_type'],
            'planned_new_remarks'         => $row['old_new_remarks'],
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
        'type'           => $oldOccupant ? 'replacement' : 'vacant',  // indicate case
        'new_occupant'   => $newOccupant,
        'old_occupant'   => $oldOccupant,
        'target_grave'   => $grave,
    ];
};

// -----------------------------------------------------------------------------
// GET – List all pending interments (or fetch a specific one)
// -----------------------------------------------------------------------------
if ($method === 'GET') {
    // Base SQL:
    //   - The plan comes from reservation_details (INNER JOIN: no reservation → not shown).
    //   - The old occupant (if any) is joined via reservation_details.old_interment_id.
    //   - The target grave is joined via reservation_details.target_grave_id.
    $baseSql = "
        SELECT
            p.*,
            rd.reservation_id,
            rd.target_grave_id,
            rd.old_interment_id,
            rd.old_new_grave_id,
            rd.old_new_status,
            rd.old_new_assistance_type,
            rd.old_new_remarks,
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
            g.grave_code, g.row_num, g.col_num, g.status AS grave_status, g.remarks AS grave_remarks,
            b.block_name, b.block_id, b.block_type
        FROM interments p
        INNER JOIN reservation_details rd
            ON rd.pending_interment_id = p.interment_id
            AND rd.deleted_at IS NULL
        LEFT JOIN interments o
            ON o.interment_id = rd.old_interment_id
            AND o.deleted_at IS NULL
        LEFT JOIN graves g
            ON g.grave_id = rd.target_grave_id
            AND g.deleted_at IS NULL
        LEFT JOIN blocks b
            ON b.block_id = g.block_id
            AND b.deleted_at IS NULL
        WHERE p.status = 'Pending'
          AND p.deleted_at IS NULL
    ";

    // --- Scenario A: Requesting a SPECIFIC resource /monitor.php/{id} ---
    if ($resourceId) {
        $stmt = $pdo->prepare($baseSql . " AND p.interment_id = :id");
        $stmt->execute(['id' => $resourceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            Response::success('Pending transfer retrieved', ['transfer' => $formatTransfer($row)]);
        } else {
            Response::error('Pending transfer not found.', 404);
        }
    }

    // --- Scenario B: COLLECTION with search + pagination (oldest first) ---
    else {
        // ---- Inputs ----
        $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
        $page  = max(1, (int) ($_GET['page'] ?? 1));

        // ---- Build search clause (aliases: p = pending, rd = reservation, o = old, g = grave, b = block) ----
        $searchSQL    = '';
        $searchParams = [];

        if ($searchTerm !== '') {
            $like = '%' . $searchTerm . '%';

            $searchCols = [
                // Pending occupant (p)
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

                // Old occupant (o)
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

                // Planned changes (rd)
                'rd.old_new_remarks',
                'rd.old_new_status',
                'rd.old_new_assistance_type',

                // Grave + Block
                'g.grave_code',
                'g.status',
                'g.remarks',
                'b.block_name',
                'b.block_type',
            ];

            $parts = [];
            foreach ($searchCols as $c) {
                $parts[] = "$c LIKE ?";
                $searchParams[] = $like;
            }
            $searchSQL = ' AND (' . implode(' OR ', $parts) . ')';
        }

        // Filtered query used by both COUNT and page fetch → guarantees consistent totals.
        $filteredSql = $baseSql . $searchSQL;

        // ---- COUNT ----
        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($filteredSql) AS combined");
        $countStmt->execute($searchParams);
        $totalRecords = (int) $countStmt->fetchColumn();

        $totalPages = (int) ceil($totalRecords / $limit);
        $page       = min($page, max(1, $totalPages));
        $offset     = ($page - 1) * $limit;

        // ---- Fetch page: oldest reserved first ----
        // $limit / $offset are strict ints → safe to interpolate.
        $pageSql = $filteredSql . " ORDER BY p.interment_id ASC LIMIT $limit OFFSET $offset";
        $pageStmt = $pdo->prepare($pageSql);
        $pageStmt->execute($searchParams);
        $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

        $pendingTransfers = array_map($formatTransfer, $rows);

        $pagination = [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ];

        // ---- Response ----
        $payload = [
            'pagination' => $pagination,
            'transfers'  => $pendingTransfers,
        ];
        if ($searchTerm !== '') {
            $payload['search_term'] = $searchTerm;
        }

        Response::success('Pending transfers retrieved', $payload);
    }
}

// -----------------------------------------------------------------------------
// POST – Execute a pending interment (activate)
// -----------------------------------------------------------------------------
if ($method === 'POST') {
    // REST functionality: allow POST /monitor.php/{id}
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['pending_interment_id'] = $resourceId;
    }

    if (empty($rawData['pending_interment_id'])) {
        Response::error("pending_interment_id is required.", 400);
    }
    $pendingId = (int) $rawData['pending_interment_id'];

    // Fetch pending interment (only if not soft‑deleted)
    $pendingStmt = $pdo->prepare("
        SELECT * FROM interments 
        WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
    ");
    $pendingStmt->execute([$pendingId]);
    $pending = $pendingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$pending) {
        Response::error("Pending interment not found or not in Pending status.", 404);
    }

    // Fetch the reservation (the plan)
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

    // Load the old occupant (if any). If they're no longer Active, we'll simply
    // skip them — the reservation may be stale. A warning goes to the log.
    $old = null;
    if ($oldIntermentId) {
        $oldStmt = $pdo->prepare("
            SELECT * FROM interments 
            WHERE interment_id = ? AND status = 'Active' AND deleted_at IS NULL
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

    $pdo->beginTransaction();
    try {

        // Acquire an exclusive lock on the pending interment row for the
        // duration of this transaction. Serializes concurrent POST/DELETE
        // requests so only one wins; the loser sees the state change and
        // bails out with 409 instead of interleaving its writes.
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

        // --- CASE: Handle Old Occupant first if they exist ---
        if ($old) {
            // Frontend can optionally override the old occupant's fate during execution.
            $oldUpdate = $rawData['old_occupant_update'] ?? [];

            // Defaults now come from reservation_details (the plan), not from a column
            // on the old occupant's own row.
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

            $oldRemarks = trim(
                $oldUpdate['remarks']
                    ?? ($rd['old_new_remarks'] ?? '')
            );

            // Validate status override
            if (!in_array($oldNewStatus, ['Active', 'Inactive'], true)) {
                throw new Exception("Invalid old occupant status. Must be Active or Inactive.");
            }

            if ($oldNewStatus === 'Active') {
                if ($oldNewGraveId) {
                    if ((int) $oldNewGraveId === $targetGraveId) {
                        throw new Exception("Old occupant cannot stay in the same grave being reserved.");
                    }
                    // Validate new grave is vacant and not deleted
                    $checkNew = $pdo->prepare("
                        SELECT status FROM graves 
                        WHERE grave_id = ? AND status = 'Vacant' AND deleted_at IS NULL
                          AND NOT EXISTS (SELECT 1 FROM interments WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL)
                    ");
                    $checkNew->execute([$oldNewGraveId, $oldNewGraveId]);
                    if (!$checkNew->fetch()) {
                        throw new Exception("The destination grave for the old occupant is not vacant or does not exist.");
                    }

                    // Move old occupant to their new physical grave
                    $setClauses = ['current_grave_id = ?', "status = 'Active'"];
                    $setParams  = [$oldNewGraveId];

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

                    // Mark their new grave as Occupied
                    $markNew = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
                    $markNew->execute([$oldNewGraveId]);
                } else {
                    // COMMON BONE CHAMBER CASE: Active status, but no physical grave_id (NULL).
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
                // Status is Inactive (Removed from cemetery completely)
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
        }

        // --- Execute the Pending Interment (The New Occupant) ---
        // They take over current_grave_id. Their plan lives in reservation_details,
        // which we consume below.
        $updatePending = $pdo->prepare("
            UPDATE interments 
            SET status = 'Active', current_grave_id = ?, updated_by = ?
            WHERE interment_id = ?
        ");
        $updatePending->execute([$targetGraveId, $userData['user_id'], $pendingId]);

        // Ensure their target grave is marked as Occupied
        if ($targetGraveId) {
            $markTarget = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
            $markTarget->execute([$targetGraveId]);
        }

        // --- Consume the reservation row ---
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
        $pdo->rollBack();
        systemLog("Monitor Database error: " . $e->getMessage(), 'System');
        Response::error("Database error while executing transfer.", 500);
    } catch (Exception $e) {
        $pdo->rollBack();
        systemLog("Monitor execution error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 400); // Send the specific validation error message back
    }
}

// -----------------------------------------------------------------------------
// DELETE – Cancel a pending interment
// -----------------------------------------------------------------------------
if ($method === 'DELETE') {
    // Get pending_interment_id from URL path first, then query string, then request body
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

    // Fetch the pending interment (only if not soft‑deleted)
    $pendingStmt = $pdo->prepare("
        SELECT * FROM interments 
        WHERE interment_id = ? AND status = 'Pending' AND deleted_at IS NULL
    ");
    $pendingStmt->execute([$pendingId]);
    $pending = $pendingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$pending) {
        Response::error("Pending interment not found or already processed.", 404);
    }

    // Fetch the reservation (to know the target grave + to consume the row).
    // It should exist, but handle the orphan case gracefully.
    $rdStmt = $pdo->prepare("
        SELECT reservation_id, target_grave_id FROM reservation_details
        WHERE pending_interment_id = ? AND deleted_at IS NULL
    ");
    $rdStmt->execute([$pendingId]);
    $rd = $rdStmt->fetch(PDO::FETCH_ASSOC);

    $reservationId = $rd ? (int) $rd['reservation_id'] : null;
    $targetGraveId = ($rd && $rd['target_grave_id']) ? (int) $rd['target_grave_id'] : null;

    $hasActive = false; // Flag to check if target grave is still occupied

    $pdo->beginTransaction();
    try {

        // Acquire an exclusive lock on the pending interment row so a
        // concurrent POST (execute) cannot interleave with this cancel.
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

        // 1. Mark pending interment as Inactive (its plan is being discarded).
        //    We explicitly null current_grave_id so the chk_status_grave CHECK
        //    (status = 'Active' OR current_grave_id IS NULL) always passes,
        //    even if the row unexpectedly had a grave attached due to drift.
        //    Log a warning so the anomaly is visible for investigation.
        if (!empty($pending['current_grave_id'])) {
            systemLog(
                "Pending interment $pendingId unexpectedly had current_grave_id="
                    . $pending['current_grave_id']
                    . "; clearing it on cancellation.",
                $userData['user_id']
            );
        }

        $cancelRemark = "Cancelled on " . date('Y-m-d H:i:s');
        $update = $pdo->prepare("
            UPDATE interments 
            SET status = 'Inactive',
                current_grave_id = NULL,
                remarks = CONCAT(COALESCE(remarks, ''), ' ', ?),
                updated_by = ?
            WHERE interment_id = ?
        ");
        $update->execute([$cancelRemark, $userData['user_id'], $pendingId]);

        // 2. Check the fate of the Target Grave
        if ($targetGraveId) {
            $checkActive = $pdo->prepare("
                SELECT interment_id FROM interments 
                WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL
                LIMIT 1
            ");
            $checkActive->execute([$targetGraveId]);
            $activeOccupant = $checkActive->fetch(PDO::FETCH_ASSOC);

            if (!$activeOccupant) {
                // If nobody is actively occupying it, we safely set it back to Vacant
                $freeGrave = $pdo->prepare("UPDATE graves SET status = 'Vacant' WHERE grave_id = ?");
                $freeGrave->execute([$targetGraveId]);
            } else {
                $hasActive = true;

                // NOTE: We intentionally do NOT touch the active occupant's row.
                // Because Memoria allows co-interments, automatically altering the
                // first active occupant the query finds can corrupt innocent records.
                // Since reservation_details now stored the plan and it was never
                // applied to the old occupant, there is nothing to revert here.
            }
        }

        // 3. Consume the reservation row. Nothing to revert — the old occupant's
        //    row was never touched at reserve time.
        if ($reservationId) {
            $softDel = $pdo->prepare("
                UPDATE reservation_details
                SET deleted_at = NOW(),
                    updated_at = NOW(),
                    updated_by = ?
                WHERE reservation_id = ?
            ");
            $softDel->execute([$userData['user_id'], $reservationId]);
        }

        $pdo->commit();
        systemLog("Cancelled pending interment $pendingId", $userData['user_id']);
        Response::success("Pending interment cancelled.", [
            'pending_interment_id' => $pendingId,
            'target_grave_id'      => $targetGraveId,
            'grave_freed'          => ($targetGraveId && !$hasActive),
        ]);
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Monitor cancellation error: " . $e->getMessage(), 'System');
        Response::error("Database error while cancelling.", 500);
    } catch (Exception $e) {
        $pdo->rollBack();
        systemLog("Monitor cancellation error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

// If method not allowed
Response::error("Method Not Allowed", 405);
