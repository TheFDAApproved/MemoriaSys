<?php

// monitor.php - view Active reservations, edit them, Confirm or Cancel
// GET    /monitor.php         lists all Active reservations, paginated and searchable
// GET    /monitor.php/{id}    returns one Active reservation
// POST   /monitor.php/{id}    edit-and-execute, same payload shape as reserve.php POST
// DELETE /monitor.php/{id}    cancels the reservation
//
// POST is atomic
// Anchors pending_interment_id, target_grave_id, old_interment_id come from the reservation row, payload values for them are ignored
// Editable: N's biography fields, written to N's interments row
// Editable: O's planned future (old_new_status, old_new_grave_id, old_new_assistance_type, old_new_remarks)
// Editable: permits for the move (exhumation_permit_number, transfer_permit_number)
// Editable: reservation_notes
// Editable: old_edited_fields (JSON DIFF of O's biography), merged into the reservation and applied to O on execute
//
// POST flow
// lock the reservation row and verify reservation_state = 'Active'
// read anchors pending_interment_id, target_grave_id, old_interment_id from the row
// parse payload into effective field values, payload overrides the row
// lock graves (target and O's destination, ascending) then N and O
// re-validate every precondition, abort if anything drifted
// update the reservation with the editable non-anchor fields
// update O in one statement covering move, status, assistance_type, remarks, and staged old_edited_fields
// snapshot O before and after, then write placement_history
// update N in one statement covering biography fields, status = 'Active', and current_grave_id = target
// snapshot N before and after, then write placement_history
// re-derive grave statuses
// mark the reservation Executed
// commit
//
// old_edited_fields follows reserve.php exactly, only changed fields are stored and the same whitelist applies
//
// CANCEL is atomic
// lock the reservation row and verify reservation_state = 'Active'
// soft-delete N
// update the reservation to 'Cancelled' with actioned_at = NOW(), O is never touched

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';
require_once 'reusable_functions.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Forbidden. You do not have permission.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$userId = (int) $userData['user_id'];

// Enum lists shared between the parse and validate steps
$ASSISTANCE_ENUM = ['Burial', 'Transfer the remains of the late', 'Other'];
$SEX_ENUM        = ['Male', 'Female', 'Unknown'];

// Parse old_edited_fields into canonical JSON, or null when nothing valid (same contract as reserve.php)
$parseOldEditedFields = function ($input) use ($ASSISTANCE_ENUM, $SEX_ENUM): ?string {
    if (is_string($input)) {
        $decoded = json_decode($input, true);
        if (is_array($decoded)) $input = $decoded;
    }
    if (!is_array($input) || empty($input)) return null;

    $allowedString = [
        'deceased_name',
        'last_known_address',
        'death_certificate',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'contact_person_address',
        'contact_person_address_barangay',
        'burial_permit_number',
        'transfer_permit_number',
        'transfer_permit_issued_by',
        'exhumation_permit_number',
        'remarks',
    ];
    $allowedDate = [
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'burial_permit_date',
        'transfer_permit_date',
        'exhumation_permit_date',
        'date_exhumed',
        'burial_clearance_date',
    ];
    $allowedEnum = ['deceased_sex' => $SEX_ENUM];

    $staged = [];
    foreach ($allowedString as $f) {
        if (!array_key_exists($f, $input)) continue;
        $v = $input[$f];
        $staged[$f] = ($v === null || $v === '') ? null : (string) $v;
    }
    foreach ($allowedDate as $f) {
        if (!array_key_exists($f, $input)) continue;
        $v = $input[$f];
        if ($v === null || $v === '') {
            $staged[$f] = null;
            continue;
        }
        if (!strtotime($v)) {
            throw new InvalidArgumentException("Invalid date format for 'old_edited_fields.$f'.");
        }
        $staged[$f] = (string) $v;
    }
    foreach ($allowedEnum as $f => $allowed) {
        if (!array_key_exists($f, $input)) continue;
        $v = $input[$f];
        if ($v === null || $v === '') {
            $staged[$f] = null;
            continue;
        }
        if (!in_array($v, $allowed, true)) {
            throw new InvalidArgumentException("Invalid value for 'old_edited_fields.$f'.");
        }
        $staged[$f] = (string) $v;
    }
    return empty($staged) ? null : json_encode($staged, JSON_UNESCAPED_UNICODE);
};

// Shape a reservation row into the JSON structure the client expects
$formatReservation = function (array $r): array {
    return [
        'reservation_id'    => (int) $r['reservation_id'],
        'reservation_state' => $r['reservation_state'],
        'reservation_notes' => $r['reservation_notes'],
        'created_at'        => $r['created_at'],
        'updated_at'        => $r['updated_at'],
        'created_by'        => $r['created_by'] ? (int) $r['created_by'] : null,
        'created_by_name'   => $r['creator_name'],
        'actioned_at'       => $r['actioned_at'],
        'actioned_by'       => $r['actioned_by'] ? (int) $r['actioned_by'] : null,

        'target_grave' => [
            'grave_id'   => (int) $r['target_grave_id'],
            'grave_code' => $r['target_grave_code'],
            'block_id'   => $r['target_block_id'] ? (int) $r['target_block_id'] : null,
            'block_name' => $r['target_block_name'],
            'block_type' => $r['target_block_type'],
        ],

        'pending_interment' => [
            'interment_id'                    => (int) $r['pending_interment_id'],
            'control_number'                  => $r['pending_control_number'],
            'deceased_name'                   => $r['pending_deceased_name'],
            'deceased_sex'                    => $r['pending_deceased_sex'],
            'last_known_address'              => $r['pending_last_known_address'],
            'death_certificate'               => $r['pending_death_certificate'],
            'deceased_date_of_birth'          => $r['pending_deceased_date_of_birth'],
            'deceased_date_of_death'          => $r['pending_deceased_date_of_death'],
            'contact_person_name'             => $r['pending_contact_person_name'],
            'contact_person_phone_number'     => $r['pending_contact_person_phone_number'],
            'contact_person_email'            => $r['pending_contact_person_email'],
            'contact_person_address'          => $r['pending_contact_person_address'],
            'contact_person_address_barangay' => $r['pending_contact_person_address_barangay'],
            'assistance_type'                 => $r['pending_assistance_type'],
            'burial_permit_number'            => $r['pending_burial_permit_number'],
            'burial_permit_date'              => $r['pending_burial_permit_date'],
            'transfer_permit_number'          => $r['pending_transfer_permit_number'],
            'transfer_permit_issued_by'       => $r['pending_transfer_permit_issued_by'],
            'transfer_permit_date'            => $r['pending_transfer_permit_date'],
            'exhumation_permit_number'        => $r['pending_exhumation_permit_number'],
            'exhumation_permit_date'          => $r['pending_exhumation_permit_date'],
            'date_buried'                     => $r['pending_date_buried'],
            'date_exhumed'                    => $r['pending_date_exhumed'],
            'burial_clearance_date'           => $r['pending_burial_clearance_date'],
            'lease_expiration_date'           => $r['pending_lease_expiration_date'],
            'remarks'                         => $r['pending_remarks'],
        ],

        'old_interment' => $r['old_interment_id'] ? [
            'interment_id'                    => (int) $r['old_interment_id'],
            'control_number'                  => $r['old_control_number'],
            'deceased_name'                   => $r['old_deceased_name'],
            'deceased_sex'                    => $r['old_deceased_sex'],
            'last_known_address'              => $r['old_last_known_address'],
            'death_certificate'               => $r['old_death_certificate'],
            'deceased_date_of_birth'          => $r['old_deceased_date_of_birth'],
            'deceased_date_of_death'          => $r['old_deceased_date_of_death'],
            'current_grave_id'                => $r['old_current_grave_id'] ? (int) $r['old_current_grave_id'] : null,
            'contact_person_name'             => $r['old_contact_person_name'],
            'contact_person_phone_number'     => $r['old_contact_person_phone_number'],
            'contact_person_email'            => $r['old_contact_person_email'],
            'contact_person_address'          => $r['old_contact_person_address'],
            'contact_person_address_barangay' => $r['old_contact_person_address_barangay'],
            'assistance_type'                 => $r['old_assistance_type'],
            'burial_permit_number'            => $r['old_burial_permit_number'],
            'burial_permit_date'              => $r['old_burial_permit_date'],
            'transfer_permit_number'          => $r['old_transfer_permit_number'],
            'transfer_permit_issued_by'       => $r['old_transfer_permit_issued_by'],
            'transfer_permit_date'            => $r['old_transfer_permit_date'],
            'exhumation_permit_number'        => $r['old_exhumation_permit_number'],
            'exhumation_permit_date'          => $r['old_exhumation_permit_date'],
            'date_buried'                     => $r['old_date_buried'],
            'date_exhumed'                    => $r['old_date_exhumed'],
            'burial_clearance_date'           => $r['old_burial_clearance_date'],
            'lease_expiration_date'           => $r['old_lease_expiration_date'],
            'status'                          => $r['old_status'],
            'remarks'                         => $r['old_remarks'],
        ] : null,

        'old_new_status'            => $r['old_new_status'],
        'old_new_assistance_type'   => $r['old_new_assistance_type'],
        'old_new_remarks'           => $r['old_new_remarks'],
        'exhumation_permit_number'  => $r['exhumation_permit_number'],
        'transfer_permit_number'    => $r['transfer_permit_number'],
        'old_edited_fields'         => !empty($r['old_edited_fields'])
            ? (json_decode($r['old_edited_fields'], true) ?: null)
            : null,

        'old_new_grave' => $r['old_new_grave_id'] ? [
            'grave_id'   => (int) $r['old_new_grave_id'],
            'grave_code' => $r['old_new_grave_code'],
            'block_id'   => $r['old_new_block_id'] ? (int) $r['old_new_block_id'] : null,
            'block_name' => $r['old_new_block_name'],
            'block_type' => $r['old_new_block_type'],
        ] : null,
    ];
};

$baseReservationSelect = "
    SELECT
        rs.*,
        creator.name AS creator_name,
        g.grave_id   AS target_grave_id,
        g.grave_code AS target_grave_code,
        bg.block_id  AS target_block_id,
        bg.block_name AS target_block_name,
        bg.block_type AS target_block_type,
        p.interment_id                    AS pending_interment_id,
        p.control_number                  AS pending_control_number,
        p.deceased_name                   AS pending_deceased_name,
        p.deceased_sex                    AS pending_deceased_sex,
        p.last_known_address              AS pending_last_known_address,
        p.death_certificate               AS pending_death_certificate,
        p.deceased_date_of_birth          AS pending_deceased_date_of_birth,
        p.deceased_date_of_death          AS pending_deceased_date_of_death,
        p.contact_person_name             AS pending_contact_person_name,
        p.contact_person_phone_number     AS pending_contact_person_phone_number,
        p.contact_person_email            AS pending_contact_person_email,
        p.contact_person_address          AS pending_contact_person_address,
        p.contact_person_address_barangay AS pending_contact_person_address_barangay,
        p.assistance_type                 AS pending_assistance_type,
        p.burial_permit_number            AS pending_burial_permit_number,
        p.burial_permit_date              AS pending_burial_permit_date,
        p.transfer_permit_number          AS pending_transfer_permit_number,
        p.transfer_permit_issued_by       AS pending_transfer_permit_issued_by,
        p.transfer_permit_date            AS pending_transfer_permit_date,
        p.exhumation_permit_number        AS pending_exhumation_permit_number,
        p.exhumation_permit_date          AS pending_exhumation_permit_date,
        p.date_buried                     AS pending_date_buried,
        p.date_exhumed                    AS pending_date_exhumed,
        p.burial_clearance_date           AS pending_burial_clearance_date,
        p.lease_expiration_date           AS pending_lease_expiration_date,
        p.remarks                         AS pending_remarks,
        o.interment_id                    AS old_interment_id,
        o.control_number                  AS old_control_number,
        o.deceased_name                   AS old_deceased_name,
        o.deceased_sex                    AS old_deceased_sex,
        o.last_known_address              AS old_last_known_address,
        o.death_certificate               AS old_death_certificate,
        o.deceased_date_of_birth          AS old_deceased_date_of_birth,
        o.deceased_date_of_death          AS old_deceased_date_of_death,
        o.current_grave_id                AS old_current_grave_id,
        o.contact_person_name             AS old_contact_person_name,
        o.contact_person_phone_number     AS old_contact_person_phone_number,
        o.contact_person_email            AS old_contact_person_email,
        o.contact_person_address          AS old_contact_person_address,
        o.contact_person_address_barangay AS old_contact_person_address_barangay,
        o.assistance_type                 AS old_assistance_type,
        o.burial_permit_number            AS old_burial_permit_number,
        o.burial_permit_date              AS old_burial_permit_date,
        o.transfer_permit_number          AS old_transfer_permit_number,
        o.transfer_permit_issued_by       AS old_transfer_permit_issued_by,
        o.transfer_permit_date            AS old_transfer_permit_date,
        o.exhumation_permit_number        AS old_exhumation_permit_number,
        o.exhumation_permit_date          AS old_exhumation_permit_date,
        o.date_buried                     AS old_date_buried,
        o.date_exhumed                    AS old_date_exhumed,
        o.burial_clearance_date           AS old_burial_clearance_date,
        o.lease_expiration_date           AS old_lease_expiration_date,
        o.status                          AS old_status,
        o.remarks                         AS old_remarks,
        og.grave_code AS old_new_grave_code,
        obg.block_id  AS old_new_block_id,
        obg.block_name AS old_new_block_name,
        obg.block_type AS old_new_block_type
    FROM reservations rs
    LEFT JOIN users      creator ON creator.user_id = rs.created_by
    INNER JOIN graves    g  ON g.grave_id  = rs.target_grave_id AND g.deleted_at IS NULL
    LEFT  JOIN blocks    bg ON bg.block_id = g.block_id          AND bg.deleted_at IS NULL
    INNER JOIN interments p ON p.interment_id = rs.pending_interment_id
    LEFT  JOIN interments o ON o.interment_id = rs.old_interment_id
    LEFT  JOIN graves    og ON og.grave_id = rs.old_new_grave_id AND og.deleted_at IS NULL
    LEFT  JOIN blocks    obg ON obg.block_id = og.block_id        AND obg.deleted_at IS NULL
";

if ($method === 'GET') {

    if ($resourceId) {
        $stmt = $pdo->prepare($baseReservationSelect . "
            WHERE rs.reservation_id = ? AND rs.reservation_state = 'Active'
        ");
        $stmt->execute([$resourceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            Response::success('Reservation retrieved', ['reservation' => $formatReservation($row)]);
        } else {
            Response::error('Active reservation not found.', 404);
        }
    }

    $searchTerm = trim((string) ($_GET['search_term'] ?? ''));
    if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
        Response::error("Search term must be at least 3 characters long", 400);
    }

    $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
    $page  = max(1, (int) ($_GET['page'] ?? 1));

    $searchSQL    = '';
    $searchParams = [];

    if ($searchTerm !== '') {
        $like = '%' . $searchTerm . '%';
        $cols = [
            'p.control_number',
            'p.deceased_name',
            'p.deceased_sex',
            'p.contact_person_name',
            'p.contact_person_phone_number',
            'p.contact_person_email',
            'p.remarks',
            'o.control_number',
            'o.deceased_name',
            'o.deceased_sex',
            'o.contact_person_name',
            'o.contact_person_phone_number',
            'o.contact_person_email',
            'o.remarks',
            'g.grave_code',
            'bg.block_name',
            'bg.block_type',
            'og.grave_code',
            'obg.block_name',
            'obg.block_type',
            'rs.reservation_notes',
        ];
        $parts = [];
        foreach ($cols as $c) {
            $parts[] = "$c LIKE ?";
            $searchParams[] = $like;
        }

        // Date search covers the reservation, N, and O
        // convert_dates() returns empty arrays for plain text, so the extra cost is zero
        // DATE()/MONTH()/DAY()/YEAR() skip indexes but LIKE '%...%' already forced a scan
        // o.* columns are NULL when there is no old occupant, so those matches safely return NULL
        $dateCriteria = convert_dates($searchTerm);

        $dateCols = [
            // Reservation
            'rs.created_at',
            'rs.updated_at',
            // Pending interment (N)
            'p.deceased_date_of_birth',
            'p.deceased_date_of_death',
            'p.burial_permit_date',
            'p.transfer_permit_date',
            'p.exhumation_permit_date',
            'p.date_buried',
            'p.date_exhumed',
            'p.burial_clearance_date',
            'p.lease_expiration_date',
            'p.created_at',
            'p.updated_at',
            // Old occupant (O)
            'o.deceased_date_of_birth',
            'o.deceased_date_of_death',
            'o.burial_permit_date',
            'o.transfer_permit_date',
            'o.exhumation_permit_date',
            'o.date_buried',
            'o.date_exhumed',
            'o.burial_clearance_date',
            'o.lease_expiration_date',
            'o.created_at',
            'o.updated_at',
        ];

        foreach ($dateCriteria['exact_dates'] as $d) {
            foreach ($dateCols as $col) {
                $parts[] = "DATE($col) = ?";
                $searchParams[] = $d;
            }
        }
        foreach ($dateCriteria['month_days'] as $md) {
            foreach ($dateCols as $col) {
                $parts[] = "(MONTH($col) = ? AND DAY($col) = ?)";
                $searchParams[] = $md['m'];
                $searchParams[] = $md['d'];
            }
        }
        foreach ($dateCriteria['year_months'] as $ym) {
            foreach ($dateCols as $col) {
                $parts[] = "(YEAR($col) = ? AND MONTH($col) = ?)";
                $searchParams[] = $ym['y'];
                $searchParams[] = $ym['m'];
            }
        }
        foreach ($dateCriteria['years'] as $y) {
            foreach ($dateCols as $col) {
                $parts[] = "YEAR($col) = ?";
                $searchParams[] = $y;
            }
        }

        $searchSQL = ' AND (' . implode(' OR ', $parts) . ')';
    }

    $where = " WHERE rs.reservation_state = 'Active' " . $searchSQL;

    $countStmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM reservations rs
        LEFT JOIN users      creator ON creator.user_id = rs.created_by
        INNER JOIN graves    g  ON g.grave_id  = rs.target_grave_id AND g.deleted_at IS NULL
        LEFT  JOIN blocks    bg ON bg.block_id = g.block_id          AND bg.deleted_at IS NULL
        INNER JOIN interments p ON p.interment_id = rs.pending_interment_id
        LEFT  JOIN interments o ON o.interment_id = rs.old_interment_id
        LEFT  JOIN graves    og ON og.grave_id = rs.old_new_grave_id AND og.deleted_at IS NULL
        LEFT  JOIN blocks    obg ON obg.block_id = og.block_id        AND obg.deleted_at IS NULL
        $where
    ");
    $countStmt->execute($searchParams);
    $totalRecords = (int) $countStmt->fetchColumn();

    $totalPages = (int) ceil($totalRecords / $limit);
    $page       = min($page, max(1, $totalPages));
    $offset     = ($page - 1) * $limit;

    $pageSQL = $baseReservationSelect . $where . " ORDER BY rs.reservation_id ASC LIMIT $limit OFFSET $offset";
    $pageStmt = $pdo->prepare($pageSQL);
    $pageStmt->execute($searchParams);
    $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

    $reservations = array_map($formatReservation, $rows);

    $payload = [
        'pagination' => [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ],
        'reservations' => $reservations,
    ];
    if ($searchTerm !== '') $payload['search_term'] = $searchTerm;

    Response::success('Active reservations retrieved', $payload);
}

if ($method === 'DELETE') {
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['reservation_id'] = (int) $resourceId;
    }
    if (empty($rawData['reservation_id']) || !is_numeric($rawData['reservation_id'])) {
        Response::error("reservation_id is required.", 400);
    }
    $reservationId = (int) $rawData['reservation_id'];

    $pdo->beginTransaction();
    try {
        $resStmt = $pdo->prepare("
            SELECT * FROM reservations
            WHERE reservation_id = ? AND reservation_state = 'Active'
            FOR UPDATE
        ");
        $resStmt->execute([$reservationId]);
        $reservation = $resStmt->fetch(PDO::FETCH_ASSOC);

        if (!$reservation) {
            $pdo->rollBack();
            Response::error("Active reservation not found (it may have already been actioned).", 404);
        }

        $pendingId = (int) $reservation['pending_interment_id'];

        $nStmt = $pdo->prepare("
            SELECT * FROM interments
            WHERE interment_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $nStmt->execute([$pendingId]);
        $n = $nStmt->fetch(PDO::FETCH_ASSOC);
        if (!$n) throw new Exception("Incoming person no longer exists.");
        if ($n['status'] !== 'Pending') throw new Exception("Incoming person is no longer Pending; cannot cancel.");

        $del = $pdo->prepare("
            UPDATE interments SET deleted_at = NOW(), updated_by = ?
            WHERE interment_id = ?
        ");
        $del->execute([$userId, $pendingId]);

        $upd = $pdo->prepare("
            UPDATE reservations
            SET reservation_state = 'Cancelled',
                actioned_at = NOW(), actioned_by = ?, updated_by = ?
            WHERE reservation_id = ? AND reservation_state = 'Active'
        ");
        $upd->execute([$userId, $userId, $reservationId]);
        if ($upd->rowCount() === 0) throw new Exception("Reservation was modified by another user.");

        $pdo->commit();

        systemLog("Reservation $reservationId cancelled. Pending interment $pendingId soft-deleted.", $userId);

        Response::success("Reservation cancelled.", [
            'reservation_id'       => $reservationId,
            'reservation_state'    => 'Cancelled',
            'pending_interment_id' => $pendingId,
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Reservation cancel DB error: " . $e->getMessage(), 'System');
        Response::error("Database error while cancelling the reservation.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Reservation cancel error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

if ($method === 'POST') {
    if ($resourceId && is_numeric($resourceId)) {
        $rawData['reservation_id'] = (int) $resourceId;
    }
    if (empty($rawData['reservation_id']) || !is_numeric($rawData['reservation_id'])) {
        Response::error("reservation_id is required.", 400);
    }
    $reservationId = (int) $rawData['reservation_id'];

    // Validate N's required biography fields (same set as reserve.php)
    $required = [
        'control_number',
        'deceased_name',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'assistance_type',
        'date_buried',
        'lease_expiration_date'
    ];

    foreach ($required as $f) {
        if (empty($rawData[$f])) Response::error("Field '$f' is required.", 400);
    }
    if (!in_array($rawData['assistance_type'], $ASSISTANCE_ENUM, true)) {
        Response::error("Invalid assistance_type.", 400);
    }
    if (!empty($rawData['deceased_sex']) && !in_array($rawData['deceased_sex'], $SEX_ENUM, true)) {
        Response::error("Invalid deceased_sex.", 400);
    }

    try {
        $oldEditedFieldsJson = $parseOldEditedFields($rawData['old_edited_fields'] ?? null);
    } catch (InvalidArgumentException $e) {
        Response::error($e->getMessage(), 400);
    }

    // Parse O-future inputs, each records whether the payload set it
    $oldNewStatusInput = null;
    if (!empty($rawData['old_new_status'])) {
        $candidate = (string) $rawData['old_new_status'];
        if (!in_array($candidate, ['Active', 'Inactive'], true)) {
            Response::error("Invalid old_new_status. Must be 'Active' or 'Inactive'.", 400);
        }
        $oldNewStatusInput = $candidate;
    }

    $oldNewGraveIdInput = null;
    $oldNewGraveProvided = false;
    if (!empty($rawData['old_new_grave_id']) && is_numeric($rawData['old_new_grave_id'])) {
        $oldNewGraveIdInput = (int) $rawData['old_new_grave_id'];
        $oldNewGraveProvided = true;
    } elseif (!empty($rawData['old_new_grave_code'])) {
        $g = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL");
        $g->execute([trim((string) $rawData['old_new_grave_code'])]);
        $gid = $g->fetchColumn();
        if ($gid === false) {
            Response::error("Old occupant's destination grave code not found.", 400);
        }
        $oldNewGraveIdInput = (int) $gid;
        $oldNewGraveProvided = true;
    }

    $oldNewAssistanceTypeInput = null;
    $oldNewAssistanceProvided  = false;
    if (array_key_exists('old_new_assistance_type', $rawData)) {
        $oldNewAssistanceProvided = true;
        if (!empty($rawData['old_new_assistance_type'])) {
            if (!in_array($rawData['old_new_assistance_type'], $ASSISTANCE_ENUM, true)) {
                Response::error("Invalid old_new_assistance_type.", 400);
            }
            $oldNewAssistanceTypeInput = (string) $rawData['old_new_assistance_type'];
        }
    }

    $oldNewRemarksInput = null;
    $oldNewRemarksProvided = false;
    if (array_key_exists('old_new_remarks', $rawData)) {
        $oldNewRemarksProvided = true;
        if ($rawData['old_new_remarks'] !== '' && $rawData['old_new_remarks'] !== null) {
            $oldNewRemarksInput = (string) $rawData['old_new_remarks'];
        }
    }

    $exhumationPermitInput = array_key_exists('exhumation_permit_number', $rawData)
        ? ($rawData['exhumation_permit_number'] !== '' ? (string) $rawData['exhumation_permit_number'] : null)
        : false;  // false = not provided
    $transferPermitInput = array_key_exists('transfer_permit_number', $rawData)
        ? ($rawData['transfer_permit_number'] !== '' ? (string) $rawData['transfer_permit_number'] : null)
        : false;
    $reservationNotesInput = array_key_exists('reservation_notes', $rawData)
        ? ($rawData['reservation_notes'] !== '' ? (string) $rawData['reservation_notes'] : null)
        : false;

    $nDateFields = [
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
    foreach ($nDateFields as $field) {
        if (!empty($rawData[$field]) && !strtotime($rawData[$field])) {
            Response::error("Invalid date format for '$field'.", 400);
        }
    }

    $nBioFields = [
        'control_number',
        'deceased_name',
        'deceased_sex',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
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
        'remarks',
    ];

    $pdo->beginTransaction();
    try {
        $resStmt = $pdo->prepare("
            SELECT * FROM reservations
            WHERE reservation_id = ? AND reservation_state = 'Active'
            FOR UPDATE
        ");
        $resStmt->execute([$reservationId]);
        $reservation = $resStmt->fetch(PDO::FETCH_ASSOC);
        if (!$reservation) {
            $pdo->rollBack();
            Response::error("Active reservation not found (it may have already been actioned).", 404);
        }

        // Anchors come from the row, payload values are ignored
        $pendingId      = (int) $reservation['pending_interment_id'];
        $targetGraveId  = (int) $reservation['target_grave_id'];
        $oldIntermentId = $reservation['old_interment_id'] !== null ? (int) $reservation['old_interment_id'] : null;

        // Effective O-future values: payload overrides the row when present
        $oldNewGraveId = $oldNewGraveProvided
            ? $oldNewGraveIdInput
            : ($reservation['old_new_grave_id'] !== null ? (int) $reservation['old_new_grave_id'] : null);

        $oldNewStatus = $oldNewStatusInput ?? $reservation['old_new_status'];

        if ($oldIntermentId && empty($oldNewStatus)) {
            // Fallback same as reserve: if O exists, status must be decided
            $oldNewStatus = $oldNewGraveId ? 'Active' : 'Inactive';
        }
        if ($oldNewStatus === 'Inactive') {
            // Inactive O has no grave by definition
            $oldNewGraveId = null;
        }

        $oldNewAssistanceType = $oldNewAssistanceProvided
            ? $oldNewAssistanceTypeInput
            : $reservation['old_new_assistance_type'];

        $oldNewRemarks = $oldNewRemarksProvided
            ? $oldNewRemarksInput
            : $reservation['old_new_remarks'];

        $exhumationPermit = $exhumationPermitInput !== false
            ? $exhumationPermitInput
            : $reservation['exhumation_permit_number'];

        $transferPermit = $transferPermitInput !== false
            ? $transferPermitInput
            : $reservation['transfer_permit_number'];

        $reservationNotes = $reservationNotesInput !== false
            ? $reservationNotesInput
            : $reservation['reservation_notes'];

        $oldEditedFieldsEffective = $oldEditedFieldsJson !== null
            ? $oldEditedFieldsJson
            : $reservation['old_edited_fields'];

        // Lock in ascending order to prevent deadlocks
        $gravesToLock = [$targetGraveId];
        if ($oldNewGraveId) $gravesToLock[] = $oldNewGraveId;
        lockGraveRows($pdo, $gravesToLock);

        $nStmt = $pdo->prepare("
            SELECT * FROM interments
            WHERE interment_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $nStmt->execute([$pendingId]);
        $nBefore = $nStmt->fetch(PDO::FETCH_ASSOC);
        if (!$nBefore) throw new Exception("Incoming person no longer exists.");
        if ($nBefore['status'] !== 'Pending') throw new Exception("Incoming person is no longer Pending; cannot confirm.");
        if ($nBefore['current_grave_id'] !== null) throw new Exception("Incoming person already has a grave; cannot confirm.");

        $oBefore = null;
        if ($oldIntermentId) {
            $oStmt = $pdo->prepare("
                SELECT * FROM interments
                WHERE interment_id = ? AND deleted_at IS NULL
                FOR UPDATE
            ");
            $oStmt->execute([$oldIntermentId]);
            $oBefore = $oStmt->fetch(PDO::FETCH_ASSOC);
            if (!$oBefore) throw new Exception("Old occupant no longer exists; reservation is stale.");
            if ($oBefore['status'] !== 'Active') throw new Exception("Old occupant is no longer Active; reservation is stale.");
            if ((int) $oBefore['current_grave_id'] !== $targetGraveId) {
                throw new Exception("Old occupant is no longer in the target grave; reservation is stale.");
            }
        }

        // Re-validate the target grave and its occupant count
        $gStmt = $pdo->prepare("SELECT * FROM graves WHERE grave_id = ? AND deleted_at IS NULL");
        $gStmt->execute([$targetGraveId]);
        if (!$gStmt->fetch()) throw new Exception("Target grave no longer exists.");

        $occStmt = $pdo->prepare("
            SELECT COUNT(*) FROM interments
            WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL
        ");
        $occStmt->execute([$targetGraveId]);
        $occupantCount = (int) $occStmt->fetchColumn();

        if ($oldIntermentId) {
            if ($occupantCount !== 1) throw new Exception("Target grave no longer has exactly one occupant; reservation is stale.");
        } else {
            if ($occupantCount !== 0) throw new Exception("Target grave is no longer vacant; reservation is stale.");
        }

        // Re-validate O's destination if one is set
        if ($oldNewGraveId) {
            $dStmt = $pdo->prepare("SELECT * FROM graves WHERE grave_id = ? AND deleted_at IS NULL");
            $dStmt->execute([$oldNewGraveId]);
            if (!$dStmt->fetch()) throw new Exception("Old occupant's destination grave no longer exists.");

            $destOcc = $pdo->prepare("
                SELECT COUNT(*) FROM interments
                WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL
                  AND interment_id <> ?
            ");
            $destOcc->execute([$oldNewGraveId, $oldIntermentId ?? 0]);
            if ((int) $destOcc->fetchColumn() > 0) {
                throw new Exception("Old occupant's destination grave is no longer vacant; reservation is stale.");
            }
        }

        // Persist reservation-level edits before touching interments
        $resUpdates = [
            'old_new_grave_id = ?',
            'old_new_status = ?',
            'old_new_assistance_type = ?',
            'old_new_remarks = ?',
            'exhumation_permit_number = ?',
            'transfer_permit_number = ?',
            'reservation_notes = ?',
            'old_edited_fields = ?',
            'updated_by = ?',
        ];
        $resParams = [
            $oldNewGraveId,
            $oldNewStatus,
            $oldNewAssistanceType,
            $oldNewRemarks,
            $exhumationPermit,
            $transferPermit,
            $reservationNotes,
            $oldEditedFieldsEffective,
            $userId,
            $reservationId,
        ];
        $updResRow = $pdo->prepare(
            "UPDATE reservations SET " . implode(', ', $resUpdates) . " WHERE reservation_id = ?"
        );
        $updResRow->execute($resParams);

        // Apply O's move plus any staged biography edits
        if ($oBefore) {
            $setClauses = ['current_grave_id = ?', 'status = ?'];
            $setParams  = [$oldNewGraveId, $oldNewStatus];
            $alreadySet = ['current_grave_id', 'status'];

            if ($oldNewAssistanceType !== null) {
                $setClauses[] = 'assistance_type = ?';
                $setParams[]  = $oldNewAssistanceType;
                $alreadySet[] = 'assistance_type';
            }
            if ($oldNewRemarks !== null && $oldNewRemarks !== '') {
                $setClauses[] = "remarks = ?";
                $setParams[]  = $oldNewRemarks;
                $alreadySet[] = 'remarks';
            }

            if (!empty($oldEditedFieldsEffective)) {
                $staged = json_decode((string) $oldEditedFieldsEffective, true);
                if (is_array($staged)) {
                    $editableFields = [
                        'deceased_name',
                        'deceased_sex',
                        'last_known_address',
                        'death_certificate',
                        'deceased_date_of_birth',
                        'deceased_date_of_death',
                        'contact_person_name',
                        'contact_person_phone_number',
                        'contact_person_email',
                        'contact_person_address',
                        'contact_person_address_barangay',
                        'burial_permit_number',
                        'burial_permit_date',
                        'transfer_permit_number',
                        'transfer_permit_issued_by',
                        'transfer_permit_date',
                        'exhumation_permit_number',
                        'exhumation_permit_date',
                        'date_exhumed',
                        'burial_clearance_date',
                        'remarks',
                    ];
                    foreach ($editableFields as $f) {
                        if (in_array($f, $alreadySet, true)) continue;
                        if (!array_key_exists($f, $staged)) continue;
                        $setClauses[] = "$f = ?";
                        $setParams[]  = $staged[$f];
                        $alreadySet[] = $f;
                    }
                }
            }

            $setClauses[] = 'updated_by = ?';
            $setParams[]  = $userId;
            $setParams[]  = $oldIntermentId;

            $updO = $pdo->prepare(
                "UPDATE interments SET " . implode(', ', $setClauses) . " WHERE interment_id = ?"
            );
            $updO->execute($setParams);

            $oAfterStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ?");
            $oAfterStmt->execute([$oldIntermentId]);
            $oAfter = $oAfterStmt->fetch(PDO::FETCH_ASSOC);

            $eventType = $oldNewGraveId ? 'Move' : 'Removal';
            $reason = "Replaced by {$nBefore['deceased_name']} (control #{$nBefore['control_number']})";
            if (!empty($reservationNotes)) $reason .= " — " . $reservationNotes;

            logPlacement($pdo, $oBefore, $oAfter, $eventType, $reason, $reservationId, $pendingId, $userId);
        }

        // Activate N in one UPDATE alongside the biography fields
        $nSetClauses = [];
        $nSetParams  = [];
        foreach ($nBioFields as $f) {
            $val = isset($rawData[$f]) && $rawData[$f] !== '' ? $rawData[$f] : null;
            $nSetClauses[] = "$f = ?";
            $nSetParams[]  = $val;
        }
        $nSetClauses[] = "status = 'Active'";
        $nSetClauses[] = 'current_grave_id = ?';
        $nSetParams[]  = $targetGraveId;
        $nSetClauses[] = 'updated_by = ?';
        $nSetParams[]  = $userId;
        $nSetParams[]  = $pendingId;

        $updN = $pdo->prepare(
            "UPDATE interments SET " . implode(', ', $nSetClauses) . " WHERE interment_id = ?"
        );
        $updN->execute($nSetParams);

        $nAfterStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ?");
        $nAfterStmt->execute([$pendingId]);
        $nAfter = $nAfterStmt->fetch(PDO::FETCH_ASSOC);

        $nReason = $oBefore
            ? "Replaces {$oBefore['deceased_name']} (control #{$oBefore['control_number']})"
            : "Initial placement";
        if (!empty($reservationNotes)) $nReason .= " — " . $reservationNotes;

        logPlacement($pdo, $nBefore, $nAfter, 'Initial', $nReason, $reservationId, $oldIntermentId, $userId);

        rederiveGraveStatus($pdo, $targetGraveId);
        if ($oldNewGraveId) rederiveGraveStatus($pdo, $oldNewGraveId);

        $updRes = $pdo->prepare("
            UPDATE reservations
            SET reservation_state = 'Executed',
                actioned_at = NOW(), actioned_by = ?, updated_by = ?
            WHERE reservation_id = ? AND reservation_state = 'Active'
        ");
        $updRes->execute([$userId, $userId, $reservationId]);
        if ($updRes->rowCount() === 0) throw new Exception("Reservation was modified by another user.");

        $pdo->commit();

        systemLog(
            "Reservation $reservationId confirmed (edit-and-execute). Pending interment $pendingId activated in grave $targetGraveId."
                . ($oBefore ? " Old occupant $oldIntermentId moved/removed." : ""),
            $userId
        );

        Response::success("Reservation confirmed and executed.", [
            'reservation_id'       => $reservationId,
            'reservation_state'    => 'Executed',
            'pending_interment_id' => $pendingId,
            'target_grave_id'      => $targetGraveId,
            'old_interment_id'     => $oldIntermentId,
            'old_new_grave_id'     => $oldNewGraveId,
            'old_new_status'       => $oldNewStatus,
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $sqlState = (string) $e->getCode();
        $msg      = $e->getMessage();

        if ($sqlState === '23000') {
            if (strpos($msg, 'uk_active_control_number') !== false) {
                Response::error("Conflict: Control number already exists.", 409);
            }
            systemLog("Reservation action integrity violation: " . $msg, 'System');
            Response::error("Conflict: Reservation action could not be completed.", 409);
        }
        if ($sqlState === 'HY000') {
            if (strpos($msg, 'chk_status_grave') !== false) {
                Response::error("Conflict: Invalid status/grave combination.", 409);
            }
            if (strpos($msg, 'chk_old_pairing') !== false) {
                Response::error("Conflict: Old occupant fields are inconsistent.", 409);
            }
            if (strpos($msg, 'chk_inactive_has_no_grave') !== false) {
                Response::error("Conflict: Inactive old occupant cannot have a destination grave.", 409);
            }
            if (strpos($msg, 'chk_old_new_grave_not_target') !== false) {
                Response::error("Conflict: Old occupant's destination cannot be the target grave.", 409);
            }
        }
        if ($sqlState === '22007') {
            Response::error("The Date Formats are invalid, please check again!", 409);
        }

        systemLog("Reservation action DB error: " . $msg, 'System');
        Response::error("Database error while actioning the reservation.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Reservation action error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

Response::error("Method Not Allowed", 405);
