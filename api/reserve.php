<?php

/**
 * Reserve.php – Discover graves and initiate a reservation (REST API)
 *
 * POST /reserve.php?action=update_reservation_plan : Save edits from View Detail Burial Clearance
 *
 * NOTE (Old Occupant editable fields):
 *   - The Reserve View Detail modal can edit the Old Occupant's
 *     Date of Interment, Expiration Date, Exhumation Permit No. and
 *     Transfer Permit No.
 *   - All four are stored in reservation_details.old_new_remarks as JSON
 *     alongside burial_type / remarks. The dedicated columns
 *     reservation_details.exhumation_permit_number and
 *     reservation_details.transfer_permit_number are now also written and
 *     are the canonical source on read.
 *   - The original interments row remains unchanged until Monitor confirmation.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE])) {
    Response::error("Forbidden. You do not have permission to perform this action.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

// -----------------------------------------------------------------------------
// Helper: parse a reservation_details.old_new_remarks value that may be JSON
// (written by the View Detail modal) or plain text (written by the reserve flow).
// Returns burial_type, remarks, date_interment, expiration_date,
// exhumation_permit_number, transfer_permit_number.
// -----------------------------------------------------------------------------
$parsePlanRemarks = function ($raw) {
    if ($raw === null || $raw === '') {
        return [
            'burial_type'              => null,
            'remarks'                  => null,
            'date_interment'           => null,
            'expiration_date'          => null,
            'exhumation_permit_number' => null,
            'transfer_permit_number'   => null,
        ];
    }
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) {
        return [
            'burial_type'              => isset($decoded['burial_type'])              ? (string) $decoded['burial_type']              : null,
            'remarks'                  => isset($decoded['remarks'])                  ? (string) $decoded['remarks']                  : null,
            'date_interment'           => isset($decoded['date_interment'])           ? (string) $decoded['date_interment']           : null,
            'expiration_date'          => isset($decoded['expiration_date'])          ? (string) $decoded['expiration_date']          : null,
            'exhumation_permit_number' => isset($decoded['exhumation_permit_number']) ? (string) $decoded['exhumation_permit_number'] : null,
            'transfer_permit_number'   => isset($decoded['transfer_permit_number'])   ? (string) $decoded['transfer_permit_number']   : null,
        ];
    }
    return [
        'burial_type'              => null,
        'remarks'                  => (string) $raw,
        'date_interment'           => null,
        'expiration_date'          => null,
        'exhumation_permit_number' => null,
        'transfer_permit_number'   => null,
    ];
};

$formatItem = function ($row) use ($parsePlanRemarks) {
    $planParts = $parsePlanRemarks($row['plan_remarks'] ?? null);

    $planBurialType = $planParts['burial_type'];
    if (($planBurialType === null || $planBurialType === '') && !empty($row['plan_block_type'])) {
        $planBurialType = (string) $row['plan_block_type'];
    }

    // Dedicated reservation_details columns take priority; fall back to the
    // value staged inside the old_new_remarks JSON blob for older rows.
    $planExhumationPermit = $row['plan_exhumation_permit_number'] ?? null;
    if ($planExhumationPermit === null || $planExhumationPermit === '') {
        $planExhumationPermit = $planParts['exhumation_permit_number'];
    }
    $planTransferPermit = $row['plan_transfer_permit_number'] ?? null;
    if ($planTransferPermit === null || $planTransferPermit === '') {
        $planTransferPermit = $planParts['transfer_permit_number'];
    }

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

        'interment_id'             => $row['interment_id'] ? (int) $row['interment_id'] : null,
        'control_number'           => $row['control_number'],
        'deceased_name'            => $row['deceased_name'],
        'last_known_address'       => $row['last_known_address'],
        'death_certificate'        => $row['death_certificate'],
        'deceased_date_of_birth'   => $row['deceased_date_of_birth'],
        'deceased_date_of_death'   => $row['deceased_date_of_death'],
        'current_grave_id'         => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,
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
        'contact_person_address_barangay' => $row['contact_person_address_barangay'],

        // ---- Saved reservation plan ----
        'plan_reservation_id'  => isset($row['plan_reservation_id']) && $row['plan_reservation_id'] !== null
            ? (int) $row['plan_reservation_id'] : null,
        'plan_assistance_type' => $row['plan_assistance_type'] ?? null,
        'plan_burial_type'     => $planBurialType,
        'plan_remarks'         => $planParts['remarks'],
        'plan_grave_code'      => $row['plan_grave_code'] ?? null,
        'plan_block_name'      => $row['plan_block_name'] ?? null,
        'plan_date_interment'  => $planParts['date_interment'],
        'plan_expiration_date' => $planParts['expiration_date'],
        'plan_exhumation_permit_number' => $planExhumationPermit,
        'plan_transfer_permit_number'   => $planTransferPermit,
    ];
};

// -----------------------------------------------------------------------------
// 1. GET
// -----------------------------------------------------------------------------
if ($method === 'GET') {

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
               b.block_name, b.block_id, b.block_type,
               rd.reservation_id           AS plan_reservation_id,
               rd.old_new_assistance_type  AS plan_assistance_type,
               rd.old_new_remarks          AS plan_remarks,
               rd.exhumation_permit_number AS plan_exhumation_permit_number,
               rd.transfer_permit_number   AS plan_transfer_permit_number,
               png.grave_code              AS plan_grave_code,
               pnb.block_name              AS plan_block_name,
               pnb.block_type              AS plan_block_type
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        LEFT JOIN reservation_details rd
               ON rd.old_interment_id = i.interment_id
              AND rd.deleted_at IS NULL
        LEFT JOIN graves png ON png.grave_id = rd.old_new_grave_id AND png.deleted_at IS NULL
        LEFT JOIN blocks pnb ON pnb.block_id = png.block_id AND pnb.deleted_at IS NULL
        WHERE i.status = 'Active'
          AND i.deleted_at IS NULL
          AND i.lease_expiration_date IS NOT NULL
          AND i.lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
          AND NOT EXISTS (
              SELECT 1 FROM reservation_details rd2
              WHERE rd2.target_grave_id = i.current_grave_id
                AND rd2.deleted_at IS NULL
                AND rd2.pending_interment_id IS NOT NULL
          )
    ";

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
               b.block_name, b.block_id, b.block_type,
               NULL AS plan_reservation_id,
               NULL AS plan_assistance_type,
               NULL AS plan_remarks,
               NULL AS plan_exhumation_permit_number,
               NULL AS plan_transfer_permit_number,
               NULL AS plan_grave_code,
               NULL AS plan_block_name,
               NULL AS plan_block_type
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
                AND rd.pending_interment_id IS NOT NULL
          )
    ";

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
    } else {
        $searchTerm = trim((string) ($_GET['search_term'] ?? ''));
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }

        $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
        $page  = max(1, (int) ($_GET['page'] ?? 1));

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

        $runVacant   = empty($wantedStatuses) || in_array('vacant',   $wantedStatuses);
        $runExpiring = empty($wantedStatuses)
            || in_array('expired',  $wantedStatuses)
            || in_array('expiring', $wantedStatuses);

        $expiringDateClause = '';
        if (!empty($wantedStatuses)) {
            $hasExpired  = in_array('expired',  $wantedStatuses);
            $hasExpiring = in_array('expiring', $wantedStatuses);
            if ($hasExpired && !$hasExpiring) {
                $expiringDateClause = " AND i.lease_expiration_date < CURDATE()";
            } elseif ($hasExpiring && !$hasExpired) {
                $expiringDateClause = " AND i.lease_expiration_date >= CURDATE()";
            }
        }

        $subqueries   = [];
        $searchParams = [];

        if ($runExpiring) {
            $expiringSearchSQL = '';
            if ($searchTerm !== '') {
                $like = '%' . $searchTerm . '%';
                $expiringSearchCols = [
                    'i.control_number', 'i.deceased_name', 'i.deceased_sex', 'i.last_known_address',
                    'i.death_certificate', 'i.contact_person_name', 'i.contact_person_phone_number',
                    'i.contact_person_email', 'i.contact_person_address', 'i.contact_person_address_barangay',
                    'i.assistance_type', 'i.burial_permit_number', 'i.transfer_permit_number',
                    'i.transfer_permit_issued_by', 'i.exhumation_permit_number', 'i.status', 'i.remarks',
                    'g.grave_code', 'g.status', 'g.remarks', 'b.block_name', 'b.block_type',
                    'png.grave_code', 'pnb.block_name', 'pnb.block_type',
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
                $vacantSearchCols = ['g.grave_code', 'g.status', 'g.remarks', 'b.block_name', 'b.block_type'];
                $parts = [];
                foreach ($vacantSearchCols as $c) {
                    $parts[] = "$c LIKE ?";
                    $searchParams[] = $like;
                }
                $vacantSearchSQL = ' AND (' . implode(' OR ', $parts) . ')';
            }
            $subqueries[] = "($vacantSelect $vacantSearchSQL)";
        }

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

        $unionSQL = implode(' UNION ALL ', $subqueries);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($unionSQL) AS combined");
        $countStmt->execute($searchParams);
        $totalRecords = (int) $countStmt->fetchColumn();

        $totalPages = (int) ceil($totalRecords / $limit);
        $page       = min($page, max(1, $totalPages));
        $offset     = ($page - 1) * $limit;

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

        $payload = [
            'pagination' => [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ],
            'items' => $items,
        ];
        if ($searchTerm !== '')      $payload['search_term'] = $searchTerm;
        if (!empty($wantedStatuses)) $payload['status']      = implode(',', $wantedStatuses);

        Response::success('Available graves retrieved', $payload);
    }
}

// -----------------------------------------------------------------------------
// 2. POST
// -----------------------------------------------------------------------------
if ($method === 'POST') {

    // =========================================================================
    // 2A. Save a reservation plan (edits from View Detail Burial Clearance)
    //     Persists the Old Occupant's Date of Interment, Expiration Date,
    //     Exhumation Permit No. and Transfer Permit No. inside the JSON blob
    //     AND into the dedicated reservation_details columns.
    // =========================================================================
    if (isset($_GET['action']) && $_GET['action'] === 'update_reservation_plan') {

        $oldIntermentId = (isset($rawData['old_interment_id']) && is_numeric($rawData['old_interment_id']))
            ? (int) $rawData['old_interment_id'] : 0;
        if (!$oldIntermentId) {
            Response::error("old_interment_id is required.", 400);
        }

        $oldStmt = $pdo->prepare("
            SELECT current_grave_id
            FROM interments
            WHERE interment_id = ?
              AND status = 'Active'
              AND deleted_at IS NULL
        ");
        $oldStmt->execute([$oldIntermentId]);
        $oldRow = $oldStmt->fetch(PDO::FETCH_ASSOC);
        if (!$oldRow) {
            Response::error("Old occupant not found or not active.", 404);
        }
        $targetGraveId = $oldRow['current_grave_id'] ? (int) $oldRow['current_grave_id'] : null;

        $newGraveId   = null;
        $newGraveCode = trim((string) ($rawData['grave_code'] ?? ''));
        if ($newGraveCode !== '') {
            $gs = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL");
            $gs->execute([$newGraveCode]);
            $gid = $gs->fetchColumn();
            if ($gid === false) {
                Response::error("Grave code '$newGraveCode' not found.", 400);
            }
            $newGraveId = (int) $gid;
        }

        $assistanceType = null;
        if (!empty($rawData['assistance_type'])) {
            $candidate = $rawData['assistance_type'];
            if (!in_array($candidate, ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
                Response::error("Invalid assistance_type.", 400);
            }
            $assistanceType = $candidate;
        }

        // Bundle plan fields (burial_type / remarks / date_interment /
        // expiration_date / exhumation_permit_number / transfer_permit_number)
        // into a single JSON blob.
        $remarksText    = trim((string) ($rawData['remarks']         ?? ''));
        $burialType     = trim((string) ($rawData['burial_type']     ?? ''));
        $dateInterment  = trim((string) ($rawData['date_interment']  ?? ''));
        $expirationDate = trim((string) ($rawData['expiration_date'] ?? ''));
        $exhumationPermit = trim((string) ($rawData['exhumation_permit_number'] ?? ''));
        $transferPermit   = trim((string) ($rawData['transfer_permit_number']   ?? ''));

        // Validate date formats when provided.
        foreach (['date_interment' => $dateInterment, 'expiration_date' => $expirationDate] as $k => $v) {
            if ($v !== '' && !strtotime($v)) {
                Response::error("Invalid date format for '$k'.", 400);
            }
        }

        $oldNewRemarks = null;
        if (
            $remarksText !== '' || $burialType !== '' || $dateInterment !== '' || $expirationDate !== ''
            || $exhumationPermit !== '' || $transferPermit !== ''
        ) {
            $oldNewRemarks = json_encode([
                'burial_type'              => $burialType,
                'remarks'                  => $remarksText,
                'date_interment'           => $dateInterment,
                'expiration_date'          => $expirationDate,
                'exhumation_permit_number' => $exhumationPermit,
                'transfer_permit_number'   => $transferPermit,
            ], JSON_UNESCAPED_UNICODE);
        }

        $oldNewStatus = $newGraveId ? 'Active' : 'Inactive';

        // Dedicated columns use NULL rather than '' when the field is blank,
        // so the "blank stays blank" contract holds on read.
        $exhumationPermitCol = $exhumationPermit !== '' ? $exhumationPermit : null;
        $transferPermitCol   = $transferPermit   !== '' ? $transferPermit   : null;

        $now    = date('Y-m-d H:i:s');
        $userId = $userData['user_id'];

        $existStmt = $pdo->prepare("
            SELECT reservation_id
            FROM reservation_details
            WHERE old_interment_id = ?
              AND deleted_at IS NULL
            LIMIT 1
        ");
        $existStmt->execute([$oldIntermentId]);
        $existingId = $existStmt->fetchColumn();

        try {
            if ($existingId !== false) {
                $stmt = $pdo->prepare("
                    UPDATE reservation_details SET
                        target_grave_id          = ?,
                        old_new_grave_id         = ?,
                        old_new_status           = ?,
                        old_new_assistance_type  = ?,
                        old_new_remarks          = ?,
                        exhumation_permit_number = ?,
                        transfer_permit_number   = ?,
                        updated_at               = ?,
                        updated_by               = ?
                    WHERE reservation_id = ?
                ");
                $stmt->execute([
                    $targetGraveId,
                    $newGraveId,
                    $oldNewStatus,
                    $assistanceType,
                    $oldNewRemarks,
                    $exhumationPermitCol,
                    $transferPermitCol,
                    $now,
                    $userId,
                    $existingId,
                ]);
                $reservationId = (int) $existingId;
            } else {
                $stmt = $pdo->prepare("
                    INSERT INTO reservation_details (
                        pending_interment_id,
                        target_grave_id,
                        old_interment_id,
                        old_new_grave_id,
                        old_new_status,
                        old_new_assistance_type,
                        old_new_remarks,
                        exhumation_permit_number,
                        transfer_permit_number,
                        created_at,
                        updated_at,
                        created_by,
                        updated_by
                    ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ");
                $stmt->execute([
                    $targetGraveId,
                    $oldIntermentId,
                    $newGraveId,
                    $oldNewStatus,
                    $assistanceType,
                    $oldNewRemarks,
                    $exhumationPermitCol,
                    $transferPermitCol,
                    $now,
                    $now,
                    $userId,
                    $userId,
                ]);
                $reservationId = (int) $pdo->lastInsertId();
            }
        } catch (PDOException $e) {
            systemLog("Reservation plan save error: " . $e->getMessage(), 'System');
            Response::error("Database error while saving the reservation plan.", 500);
        }

        systemLog(
            "Reservation plan saved (reservation $reservationId, old interment $oldIntermentId, new grave " .
                ($newGraveId ?? 'NULL') . ")",
            $userId
        );

        Response::success("Reservation plan saved.", [
            'reservation_id'          => $reservationId,
            'old_interment_id'        => $oldIntermentId,
            'target_grave_id'         => $targetGraveId,
            'old_new_grave_id'        => $newGraveId,
            'old_new_status'          => $oldNewStatus,
            'old_new_assistance_type' => $assistanceType,
        ]);
        exit;
    }

    // =========================================================================
    // 2B. Create a new pending reservation (Add action) — UNCHANGED.
    //     The Date of Interment / Expiration Date behavior for the Add action
    //     is untouched.
    // =========================================================================

    if ($resourceId && is_numeric($resourceId)) {
        $rawData['grave_id'] = $resourceId;
    }

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

    $resolveGraveCode = function ($code) use ($pdo) {
        $stmt = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL");
        $stmt->execute([$code]);
        $id = $stmt->fetchColumn();
        if ($id === false) {
            Response::error("Grave code '$code' not found.", 400);
        }
        return (int) $id;
    };

    if (!empty($rawData['grave_code']) && empty($rawData['grave_id'])) {
        $rawData['grave_id'] = $resolveGraveCode($rawData['grave_code']);
    }
    if (!empty($rawData['old_transfer_to_grave_code']) && empty($rawData['old_transfer_to_grave'])) {
        $rawData['old_transfer_to_grave'] = $resolveGraveCode($rawData['old_transfer_to_grave_code']);
    }

    $graveId            = null;
    $oldIntermentId     = null;
    $oldNewGraveId      = null;
    $oldNewStatus       = null;
    $oldNewAssistance   = null;
    $oldNewRemarks      = null;

    if (!empty($rawData['grave_id']) && is_numeric($rawData['grave_id'])) {
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

        $pendingCheck = $pdo->prepare("
            SELECT reservation_id FROM reservation_details
            WHERE target_grave_id = ?
              AND deleted_at IS NULL
              AND pending_interment_id IS NOT NULL
            LIMIT 1
        ");
        $pendingCheck->execute([$graveId]);
        if ($pendingCheck->fetch()) {
            Response::error("This grave already has a pending reservation. Cancel it first.", 409);
        }
    } elseif (!empty($rawData['old_interment_id']) && is_numeric($rawData['old_interment_id'])) {
        $oldIntermentId = (int) $rawData['old_interment_id'];

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

        $checkGrave = $pdo->prepare("
            SELECT status FROM graves 
            WHERE grave_id = ? AND deleted_at IS NULL
        ");
        $checkGrave->execute([$graveId]);
        if ($checkGrave->fetchColumn() !== 'Occupied') {
            Response::error("The grave is not currently occupied. Cannot replace.", 400);
        }

        $pendingCheck = $pdo->prepare("
            SELECT reservation_id FROM reservation_details
            WHERE target_grave_id = ?
              AND deleted_at IS NULL
              AND pending_interment_id IS NOT NULL
            LIMIT 1
        ");
        $pendingCheck->execute([$graveId]);
        if ($pendingCheck->fetch()) {
            Response::error("This grave already has a pending reservation. Cancel it first.", 409);
        }

        $oldNewGraveId = !empty($rawData['old_transfer_to_grave'])
            ? (int) $rawData['old_transfer_to_grave']
            : null;

        if (!empty($rawData['old_occupant_status'])) {
            $candidate = $rawData['old_occupant_status'];
            if (!in_array($candidate, ['Active', 'Inactive'], true)) {
                Response::error("Invalid old_occupant_status. Must be Active or Inactive.", 400);
            }
            $oldNewStatus = $candidate;
        } else {
            $oldNewStatus = $oldNewGraveId ? 'Active' : 'Inactive';
        }

        if (!empty($rawData['old_occupant_assistance_type'])) {
            $candidate = $rawData['old_occupant_assistance_type'];
            if (!in_array($candidate, ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
                Response::error("Invalid old_occupant_assistance_type.", 400);
            }
            $oldNewAssistance = $candidate;
        }

        $newDeceased     = trim($rawData['deceased_name']);
        $newControl      = trim($rawData['control_number']);
        $transferRemarks = trim($rawData['remarks_old_occupant'] ?? '');
        $defaultRemarks  = "To be replaced by $newDeceased (control: $newControl).";
        $oldNewRemarks   = $transferRemarks ?: $defaultRemarks;
    } else {
        Response::error("You must provide either 'grave_id' (or 'grave_code') for a vacant grave, or 'old_interment_id' for replacement.", 400);
    }

    $insertFields = [
        'control_number', 'deceased_name', 'last_known_address', 'death_certificate',
        'deceased_date_of_birth', 'deceased_date_of_death', 'current_grave_id',
        'contact_person_name', 'contact_person_phone_number', 'contact_person_email',
        'assistance_type', 'burial_permit_number', 'burial_permit_date',
        'transfer_permit_number', 'transfer_permit_issued_by', 'transfer_permit_date',
        'exhumation_permit_number', 'exhumation_permit_date', 'date_buried', 'date_exhumed',
        'burial_clearance_date', 'lease_expiration_date', 'status', 'remarks',
        'deceased_sex', 'contact_person_address', 'contact_person_address_barangay',
        'created_at', 'updated_at', 'created_by', 'updated_by'
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
        $sql = "INSERT INTO interments (" . implode(', ', $insertFields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newIntermentId = $pdo->lastInsertId();

        $existingPlanId = null;
        if ($oldIntermentId) {
            $planStmt = $pdo->prepare("
                SELECT reservation_id FROM reservation_details
                WHERE old_interment_id = ?
                  AND deleted_at IS NULL
                LIMIT 1
            ");
            $planStmt->execute([$oldIntermentId]);
            $existingPlanId = $planStmt->fetchColumn();
        }

        $now    = date('Y-m-d H:i:s');
        $userId = $userData['user_id'];

        if ($existingPlanId !== false && $existingPlanId !== null) {
            $resvStmt = $pdo->prepare("
                UPDATE reservation_details SET
                    pending_interment_id     = ?,
                    target_grave_id          = ?,
                    old_new_grave_id         = COALESCE(old_new_grave_id, ?),
                    old_new_status           = COALESCE(old_new_status, ?),
                    old_new_assistance_type  = COALESCE(old_new_assistance_type, ?),
                    old_new_remarks          = COALESCE(old_new_remarks, ?),
                    updated_at               = ?,
                    updated_by               = ?
                WHERE reservation_id = ?
            ");
            $resvStmt->execute([
                $newIntermentId,
                $graveId,
                $oldNewGraveId,
                $oldNewStatus,
                $oldNewAssistance,
                $oldNewRemarks,
                $now,
                $userId,
                $existingPlanId,
            ]);
        } else {
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
                $userId,
                $userId,
            ]);
        }

        $pdo->commit();
        systemLog(
            "Reservation created: pending interment $newIntermentId targets grave $graveId" .
                ($oldIntermentId ? ", replacing old occupant $oldIntermentId" : ""),
            $userId
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
            Response::error("Conflict: Control number already exists.", 409);
        }
        systemLog("Reservation error: " . $e->getMessage(), 'System');
        Response::error("Database error while creating reservation.", 500);
    }
}

Response::error("Method Not Allowed", 405);