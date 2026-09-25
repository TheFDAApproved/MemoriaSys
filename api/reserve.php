<?php

/**
 * Reserve.php – Discover graves and initiate a reservation (REST API)
 *
 * GET  /reserve.php      : List all graves that can be reserved (paginated)
 * GET  /reserve.php/{id} : Check availability of a specific grave by ID
 * POST /reserve.php      : Create a reservation (provide `grave_id` or `old_interment_id` in body)
 * POST /reserve.php/{id} : Create a reservation specifically for grave {id}
 *
 * NOTE (schema v2):
 *   - interments.transfer_to_grave no longer exists.
 *   - Planned changes live in reservation_details (one row per active reservation).
 *   - The OLD occupant's row is NOT touched at reserve time. Their fate is
 *     stored in reservation_details and applied when Monitor executes.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';      // for systemLog

$userData = checkuser();        // Must be authenticated
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

// Only Admin and Office are allowed
$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE])) {
    Response::error("Forbidden. You do not have permission to perform this action.", 403);
}

// Hybrid input parser (JSON + form)
$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// Parse path: /reserve.php/{id} or /reserve.php
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

// Helper function to format the flat item response
$formatItem = function ($row) {
    return [
        'type'                     => $row['type'],
        'grave_id'                 => (int) $row['grave_id'],
        'grave_code'               => $row['grave_code'],
        'row_num'                  => $row['row_num'] ? (int) $row['row_num'] : null,
        'col_num'                  => $row['col_num'] ? (int) $row['col_num'] : null,
        'grave_status'             => $row['grave_status'],
        'grave_remarks'            => $row['grave_remarks'],
        'block_id'                 => $row['block_id'] ? (int) $row['block_id'] : null,
        'block_name'               => $row['block_name'],
        'block_type'               => $row['block_type'],

        // Interment details (Will be null if type is 'vacant')
        'interment_id'             => $row['interment_id'] ? (int) $row['interment_id'] : null,
        'control_number'           => $row['control_number'],
        'deceased_name'            => $row['deceased_name'],
        'last_known_address'       => $row['last_known_address'],
        'death_certificate'        => $row['death_certificate'],
        'deceased_date_of_birth'   => $row['deceased_date_of_birth'],
        'deceased_date_of_death'   => $row['deceased_date_of_death'],
        'current_grave_id'         => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,
        // NOTE: transfer_to_grave removed – column no longer exists.
        'contact_person_name'      => $row['contact_person_name'],
        'contact_person_phone_number' => $row['contact_person_phone_number'],
        'contact_person_email'     => $row['contact_person_email'],
        'assistance_type'          => $row['assistance_type'],
        'burial_permit_number'     => $row['burial_permit_number'],
        'burial_permit_date'       => $row['burial_permit_date'],
        'transfer_permit_number'   => $row['transfer_permit_number'],
        'transfer_permit_issued_by' => $row['transfer_permit_issued_by'],
        'transfer_permit_date'     => $row['transfer_permit_date'],
        'exhumation_permit_number' => $row['exhumation_permit_number'],
        'exhumation_permit_date'   => $row['exhumation_permit_date'],
        'date_buried'              => $row['date_buried'],
        'date_exhumed'             => $row['date_exhumed'],
        'burial_clearance_date'    => $row['burial_clearance_date'],
        'lease_expiration_date'    => $row['lease_expiration_date'],
        'interment_status'         => $row['interment_status'],
        'interment_remarks'        => $row['interment_remarks'],
        'deceased_sex'             => $row['deceased_sex'],
        'contact_person_address'   => $row['contact_person_address'],
        'contact_person_address_barangay' => $row['contact_person_address_barangay']
    ];
};

// -----------------------------------------------------------------------------
// 1. GET – List available graves OR fetch a specific grave's availability
// -----------------------------------------------------------------------------
if ($method === 'GET') {

    // ---- Base SELECT: expiring/expired interments (aliases: i, g, b) ----
    // Excludes any interment whose current grave is already targeted by an
    // active reservation (reservation_details.target_grave_id).
    $expiringSelect = "
        SELECT
               CASE
                   WHEN i.lease_expiration_date < CURDATE() THEN 'expired'
                   ELSE 'expiring'
               END AS type,
               i.interment_id, i.control_number, i.deceased_name, i.last_known_address,
               i.death_certificate, i.deceased_date_of_birth, i.deceased_date_of_death, i.current_grave_id,
               i.contact_person_name, i.contact_person_phone_number, i.contact_person_email,
               i.assistance_type, i.burial_permit_number, i.burial_permit_date, i.transfer_permit_number,
               i.transfer_permit_issued_by, i.transfer_permit_date, i.exhumation_permit_number,
               i.exhumation_permit_date, i.date_buried, i.date_exhumed, i.burial_clearance_date,
               i.lease_expiration_date, i.status AS interment_status, i.remarks AS interment_remarks,
               i.deceased_sex, i.contact_person_address, i.contact_person_address_barangay,
               g.grave_id, g.grave_code, g.row_num, g.col_num, g.status AS grave_status, g.remarks AS grave_remarks,
               b.block_name, b.block_id, b.block_type
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE i.status = 'Active'
          AND i.deleted_at IS NULL
          AND i.lease_expiration_date IS NOT NULL
          AND i.lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
          AND NOT EXISTS (
              SELECT 1 FROM reservation_details rd
              WHERE rd.target_grave_id = i.current_grave_id
                AND rd.deleted_at IS NULL
          )
    ";

    // ---- Base SELECT: vacant graves (aliases: g, b; interment fields are NULL) ----
    // IMPORTANT: column order must match $expiringSelect exactly (MySQL UNION ALL is positional).
    // Excludes any grave already targeted by an active reservation.
    $vacantSelect = "
        SELECT 'vacant' AS type, NULL AS interment_id, NULL AS control_number, NULL AS deceased_name,
               NULL AS last_known_address, NULL AS death_certificate, NULL AS deceased_date_of_birth,
               NULL AS deceased_date_of_death, NULL AS current_grave_id,
               NULL AS contact_person_name, NULL AS contact_person_phone_number, NULL AS contact_person_email,
               NULL AS assistance_type, NULL AS burial_permit_number, NULL AS burial_permit_date,
               NULL AS transfer_permit_number, NULL AS transfer_permit_issued_by, NULL AS transfer_permit_date,
               NULL AS exhumation_permit_number, NULL AS exhumation_permit_date, NULL AS date_buried,
               NULL AS date_exhumed, NULL AS burial_clearance_date, NULL AS lease_expiration_date,
               NULL AS interment_status, NULL AS interment_remarks,
               NULL AS deceased_sex, NULL AS contact_person_address, NULL AS contact_person_address_barangay,
               g.grave_id, g.grave_code, g.row_num, g.col_num,
               g.status AS grave_status, g.remarks AS grave_remarks,
               b.block_name, b.block_id, b.block_type
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE g.status = 'Vacant'
          AND g.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM interments i
              WHERE i.current_grave_id = g.grave_id
                AND i.status = 'Active'
                AND i.deleted_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1 FROM reservation_details rd
              WHERE rd.target_grave_id = g.grave_id
                AND rd.deleted_at IS NULL
          )
    ";

    // --- Scenario A: Requesting a SPECIFIC resource /reserve.php/{id} ---
    if ($resourceId) {
        $expiringById = $expiringSelect . " AND g.grave_id = :id1";
        $vacantById   = $vacantSelect   . " AND g.grave_id = :id2";

        $combinedSQL = "($expiringById) UNION ALL ($vacantById)";

        $stmt = $pdo->prepare($combinedSQL);
        $stmt->execute(['id1' => $resourceId, 'id2' => $resourceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            Response::success('Available grave retrieved', ['item' => $formatItem($row)]);
        } else {
            Response::error('Grave not found or not available for reservation', 404);
        }
    }

    // --- Scenario B: Requesting the COLLECTION /reserve.php ---
    else {
        // ---- Inputs ----
        $searchTerm = trim((string) ($_GET['search_term'] ?? ''));
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
        $page  = max(1, (int) ($_GET['page'] ?? 1));

        // ---- Status filter (vacant / expired / expiring, comma-separated) ----
        $statusRaw = $_GET['status'] ?? '';
        if (is_array($statusRaw)) {
            $statusRaw = implode(',', $statusRaw);
        }
        $statusFilter    = strtolower(trim((string) $statusRaw));
        $allowedStatuses = ['vacant', 'expired', 'expiring'];
        $wantedStatuses  = [];

        if ($statusFilter !== '') {
            foreach (explode(',', $statusFilter) as $s) {
                $s = trim($s);
                if (!in_array($s, $allowedStatuses, true)) {
                    Response::error("Invalid status '$s'. Allowed: vacant, expired, expiring.", 400);
                }
                if (!in_array($s, $wantedStatuses, true)) {
                    $wantedStatuses[] = $s;
                }
            }
        }

        // Which branches to run?
        $runVacant   = empty($wantedStatuses) || in_array('vacant',   $wantedStatuses);
        $runExpiring = empty($wantedStatuses)
            || in_array('expired',  $wantedStatuses)
            || in_array('expiring', $wantedStatuses);

        // Date split for the expiring branch (only when narrowed)
        $expiringDateClause = '';
        if (!empty($wantedStatuses)) {
            $hasExpired  = in_array('expired',  $wantedStatuses);
            $hasExpiring = in_array('expiring', $wantedStatuses);
            if ($hasExpired && !$hasExpiring) {
                $expiringDateClause = " AND i.lease_expiration_date < CURDATE()";
            } elseif ($hasExpiring && !$hasExpired) {
                $expiringDateClause = " AND i.lease_expiration_date >= CURDATE()";
            }
            // both → no extra clause (both sides already covered by <= CURDATE()+1M)
        }

        // ---- Build subqueries + search params in matching order ----
        $subqueries   = [];
        $searchParams = [];

        if ($runExpiring) {
            $expiringSearchSQL = '';
            if ($searchTerm !== '') {
                $like = '%' . $searchTerm . '%';
                $expiringSearchCols = [
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
                    'g.status',
                    'g.remarks',
                    'b.block_name',
                    'b.block_type',
                ];
                $parts = [];
                foreach ($expiringSearchCols as $c) {
                    $parts[] = "$c LIKE ?";
                    $searchParams[] = $like;
                }
                $expiringSearchSQL = ' AND (' . implode(' OR ', $parts) . ')';
            }
            $subqueries[] = "($expiringSelect $expiringDateClause $expiringSearchSQL)";
        }

        if ($runVacant) {
            $vacantSearchSQL = '';
            if ($searchTerm !== '') {
                $like = '%' . $searchTerm . '%';
                $vacantSearchCols = [
                    'g.grave_code',
                    'g.status',
                    'g.remarks',
                    'b.block_name',
                    'b.block_type',
                ];
                $parts = [];
                foreach ($vacantSearchCols as $c) {
                    $parts[] = "$c LIKE ?";
                    $searchParams[] = $like;
                }
                $vacantSearchSQL = ' AND (' . implode(' OR ', $parts) . ')';
            }
            $subqueries[] = "($vacantSelect $vacantSearchSQL)";
        }

        // No runnable branch (shouldn't happen given the defaults, but be safe)
        if (empty($subqueries)) {
            $payload = [
                'pagination' => [
                    'current_page'  => 1,
                    'per_page'      => $limit,
                    'total_records' => 0,
                    'total_pages'   => 0,
                ],
                'items' => [],
            ];
            if ($searchTerm !== '')      $payload['search_term'] = $searchTerm;
            if (!empty($wantedStatuses)) $payload['status']      = implode(',', $wantedStatuses);
            Response::success('Available graves retrieved', $payload);
            exit;
        }

        // Outer parens around the WHOLE union so COUNT's alias attaches correctly
        $unionSQL = implode(' UNION ALL ', $subqueries);

        // ---- COUNT (filtered) ----
        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($unionSQL) AS combined");
        $countStmt->execute($searchParams);
        $totalRecords = (int) $countStmt->fetchColumn();

        $totalPages = (int) ceil($totalRecords / $limit);
        $page       = min($page, max(1, $totalPages));
        $offset     = ($page - 1) * $limit;

        // ---- Fetch page (filtered + ordered + limited in SQL) ----
        // $limit / $offset are strict ints at this point → safe to interpolate.
        $pageSQL = "
            SELECT *
            FROM ($unionSQL) AS combined
            ORDER BY
                CASE type
                    WHEN 'vacant'   THEN 0
                    WHEN 'expired'  THEN 1
                    WHEN 'expiring' THEN 2
                    ELSE 3
                END ASC,
                lease_expiration_date ASC,
                block_name,
                grave_code
            LIMIT $limit OFFSET $offset
        ";
        $pageStmt = $pdo->prepare($pageSQL);
        $pageStmt->execute($searchParams);
        $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map($formatItem, $rows);

        // ---- Response ----
        $payload = [
            'pagination' => [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ],
            'items' => $items,
        ];
        if ($searchTerm !== '') {
            $payload['search_term'] = $searchTerm;
        }
        if (!empty($wantedStatuses)) {
            $payload['status'] = implode(',', $wantedStatuses);
        }

        Response::success('Available graves retrieved', $payload);
    }
}

// -----------------------------------------------------------------------------
// 2. POST – Create a new pending reservation
// -----------------------------------------------------------------------------
if ($method === 'POST') {

    // REST functionality: allow POST /reserve.php/{id} to set the target grave_id
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['grave_id'] = $resourceId;
    }

    // Required fields for the new occupant
    $required = [
        'control_number',
        'deceased_name',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'assistance_type'
    ];
    foreach ($required as $field) {
        if (empty($rawData[$field])) {
            Response::error("Field '$field' is required.", 400);
        }
    }

    // -------------------------------------------------------------------------
    // Helper to resolve grave_code to grave_id
    // -------------------------------------------------------------------------
    $resolveGraveCode = function ($code) use ($pdo) {
        $stmt = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL");
        $stmt->execute([$code]);
        $id = $stmt->fetchColumn();
        if ($id === false) {
            Response::error("Grave code '$code' not found.", 400);
        }
        return (int) $id;
    };

    // If 'grave_code' is provided and 'grave_id' is not, convert it
    if (!empty($rawData['grave_code']) && empty($rawData['grave_id'])) {
        $rawData['grave_id'] = $resolveGraveCode($rawData['grave_code']);
    }

    // If 'old_transfer_to_grave_code' is provided and 'old_transfer_to_grave' is not, convert it
    if (!empty($rawData['old_transfer_to_grave_code']) && empty($rawData['old_transfer_to_grave'])) {
        $rawData['old_transfer_to_grave'] = $resolveGraveCode($rawData['old_transfer_to_grave_code']);
    }
    // -------------------------------------------------------------------------

    $graveId            = null;   // The grave being reserved (incoming occupant's target)
    $oldIntermentId     = null;   // The displaced occupant (null if the target grave is vacant)
    $oldNewGraveId      = null;   // Where the displaced occupant goes (null = bone chamber / removed)
    $oldNewStatus       = null;   // 'Active' | 'Inactive' | null (only set when oldIntermentId is set)
    $oldNewAssistance   = null;   // Optional override of the old occupant's assistance_type
    $oldNewRemarks      = null;   // Free-text remark for the old occupant

    if (!empty($rawData['grave_id']) && is_numeric($rawData['grave_id'])) {
        // Case 1: Direct reservation on a vacant grave
        $graveId = (int) $rawData['grave_id'];

        $check = $pdo->prepare("
            SELECT g.grave_id, g.status 
            FROM graves g
            WHERE g.grave_id = ? 
              AND g.status = 'Vacant'
              AND g.deleted_at IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM interments i
                  WHERE i.current_grave_id = g.grave_id 
                    AND i.status = 'Active'
                    AND i.deleted_at IS NULL
              )
        ");
        $check->execute([$graveId]);
        if (!$check->fetch()) {
            Response::error("The specified grave is not vacant or does not exist.", 400);
        }

        // Reject if an active reservation already targets this grave
        $pendingCheck = $pdo->prepare("
            SELECT reservation_id FROM reservation_details
            WHERE target_grave_id = ?
              AND deleted_at IS NULL
            LIMIT 1
        ");
        $pendingCheck->execute([$graveId]);
        if ($pendingCheck->fetch()) {
            Response::error("This grave already has a pending reservation. Cancel it first.", 409);
        }
        // No old-occupant fields for a vacant-grave reservation.
    } elseif (!empty($rawData['old_interment_id']) && is_numeric($rawData['old_interment_id'])) {
        // Case 2: Replace an existing occupant
        $oldIntermentId = (int) $rawData['old_interment_id'];

        // NOTE: transfer_to_grave removed from SELECT list – column no longer exists.
        $oldStmt = $pdo->prepare("
            SELECT current_grave_id, deceased_name
            FROM interments 
            WHERE interment_id = ? 
              AND status = 'Active'
              AND deleted_at IS NULL
        ");
        $oldStmt->execute([$oldIntermentId]);
        $old = $oldStmt->fetch(PDO::FETCH_ASSOC);

        if (!$old) {
            Response::error("Old occupant not found or not active.", 404);
        }
        if (is_null($old['current_grave_id'])) {
            Response::error("Old occupant does not have a valid current_grave_id assignment.", 400);
        }

        $graveId = (int) $old['current_grave_id'];

        // Ensure grave is occupied and not deleted
        $checkGrave = $pdo->prepare("
            SELECT status FROM graves 
            WHERE grave_id = ? AND deleted_at IS NULL
        ");
        $checkGrave->execute([$graveId]);
        if ($checkGrave->fetchColumn() !== 'Occupied') {
            Response::error("The grave is not currently occupied. Cannot replace.", 400);
        }

        // Reject if an active reservation already targets this grave
        $pendingCheck = $pdo->prepare("
            SELECT reservation_id FROM reservation_details
            WHERE target_grave_id = ?
              AND deleted_at IS NULL
            LIMIT 1
        ");
        $pendingCheck->execute([$graveId]);
        if ($pendingCheck->fetch()) {
            Response::error("This grave already has a pending reservation. Cancel it first.", 409);
        }

        // Where is the old occupant going? (null = Common Bone Chamber / out of cemetery)
        $oldNewGraveId = !empty($rawData['old_transfer_to_grave'])
            ? (int) $rawData['old_transfer_to_grave']
            : null;

        // Frontend may explicitly state the old occupant's future status.
        // Default mirrors the historical behaviour: Active if they still have a
        // physical target grave, otherwise Inactive.
        if (!empty($rawData['old_occupant_status'])) {
            $candidate = $rawData['old_occupant_status'];
            if (!in_array($candidate, ['Active', 'Inactive'], true)) {
                Response::error("Invalid old_occupant_status. Must be Active or Inactive.", 400);
            }
            $oldNewStatus = $candidate;
        } else {
            $oldNewStatus = $oldNewGraveId ? 'Active' : 'Inactive';
        }

        // Optional: assist the old occupant's assistance_type.
        if (!empty($rawData['old_occupant_assistance_type'])) {
            $candidate = $rawData['old_occupant_assistance_type'];
            if (!in_array($candidate, ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
                Response::error("Invalid old_occupant_assistance_type.", 400);
            }
            $oldNewAssistance = $candidate;
        }

        // Prepare remarks for the old occupant.
        $newDeceased     = trim($rawData['deceased_name']);
        $newControl      = trim($rawData['control_number']);
        $transferRemarks = trim($rawData['remarks_old_occupant'] ?? '');
        $defaultRemarks  = "To be replaced by $newDeceased (control: $newControl).";
        $oldNewRemarks   = $transferRemarks ?: $defaultRemarks;
    } else {
        Response::error("You must provide either 'grave_id' (or 'grave_code') for a vacant grave, or 'old_interment_id' for replacement.", 400);
    }

    // Prepare fields for NEW occupant.
    // They are not in a grave yet, so current_grave_id is NULL.
    // The target grave is stored in reservation_details.
    // NOTE: transfer_to_grave removed – column no longer exists.
    $insertFields = [
        'control_number',
        'deceased_name',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'current_grave_id',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
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
        'deceased_sex',
        'contact_person_address',
        'contact_person_address_barangay',

        // Audit columns
        'created_at',
        'updated_at',
        'created_by',
        'updated_by'
    ];

    $placeholders = [];
    $values = [];

    foreach ($insertFields as $field) {
        if ($field === 'current_grave_id') {
            $val = null;
        } elseif ($field === 'status') {
            $val = 'Pending';
        } elseif ($field === 'created_at' || $field === 'updated_at') {
            $val = date('Y-m-d H:i:s');
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

        // Lock the target grave row for the duration of the transaction.
        // Serializes concurrent reservations against the same grave so
        // only one can commit; the loser sees the winner's row and bails.
        $lockStmt = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? FOR UPDATE");
        $lockStmt->execute([$graveId]);
        if (!$lockStmt->fetch()) {
            throw new Exception("Target grave does not exist.");
        }

        // Re-check inside the lock.
        $pendingCheck = $pdo->prepare("
            SELECT reservation_id FROM reservation_details
            WHERE target_grave_id = ?
              AND deleted_at IS NULL
            LIMIT 1
        ");
        $pendingCheck->execute([$graveId]);
        if ($pendingCheck->fetch()) {
            throw new Exception("This grave already has a pending reservation. Cancel it first.");
        }

        // 1. Insert new pending interment (with audit columns)
        $sql = "INSERT INTO interments (" . implode(', ', $insertFields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newIntermentId = $pdo->lastInsertId();

        // 2. Record the reservation (the plan) in reservation_details.
        //    The OLD occupant's row is intentionally left untouched here —
        //    Monitor applies these changes when the reservation executes.
        $resvStmt = $pdo->prepare("
            INSERT INTO reservation_details (
                pending_interment_id,
                target_grave_id,
                old_interment_id,
                old_new_grave_id,
                old_new_status,
                old_new_assistance_type,
                old_new_remarks,
                created_by,
                updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $resvStmt->execute([
            $newIntermentId,
            $graveId,
            $oldIntermentId,
            $oldNewGraveId,
            $oldNewStatus,
            $oldNewAssistance,
            $oldNewRemarks,
            $userData['user_id'],
            $userData['user_id'],
        ]);

        $pdo->commit();
        systemLog(
            "Reservation created: pending interment $newIntermentId targets grave $graveId" .
                ($oldIntermentId ? ", replacing old occupant $oldIntermentId" : ""),
            $userData['user_id']
        );

        Response::success("Reservation created successfully.", [
            'new_interment_id' => $newIntermentId,
            'target_grave_id'  => $graveId,
            'old_interment_id' => $oldIntermentId,
            'old_new_grave_id' => $oldNewGraveId,
            'old_new_status'   => $oldNewStatus,
        ], 201);
    } catch (PDOException $e) {
        $pdo->rollBack();
        if ($e->getCode() == 23000) {
            $msg = $e->getMessage();

            // MySQL embeds the violated index name in the error text, so we
            // can route to a precise message instead of guessing.
            //
            //  uk_active_control_number      -> from the interments INSERT
            //  uk_active_target_grave        -> from the reservation_details INSERT
            //                                    (usually a race between two
            //                                    concurrent requests for the
            //                                    same grave)
            //  uk_active_pending_interment   -> from the reservation_details INSERT
            //                                    (the pending interment already
            //                                    has a live reservation)
            if (strpos($msg, 'uk_active_control_number') !== false) {
                Response::error("Conflict: Control number already exists.", 409);
            }
            if (strpos($msg, 'uk_active_target_grave') !== false) {
                Response::error("Conflict: This grave already has a pending reservation.", 409);
            }
            if (strpos($msg, 'uk_active_pending_interment') !== false) {
                Response::error("Conflict: This pending interment already has a reservation.", 409);
            }

            // Unknown integrity violation — log it, then give a generic 409.
            systemLog("Reservation integrity violation: " . $msg, 'System');
            Response::error("Conflict: Reservation could not be created.", 409);
        }

        systemLog("Reservation error: " . $e->getMessage(), 'System');
        Response::error("Database error while creating reservation.", 500);
    } catch (Exception $e) {
        $pdo->rollBack();
        systemLog("Reservation validation error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

// If method not allowed
Response::error("Method Not Allowed", 405);
