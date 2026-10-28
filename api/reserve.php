<?php

// reserve.php - discover graves and create a reservation
// GET    /reserve.php         lists all graves eligible for a reservation, paginated, returns expired, expiring and vacant graves
// GET    /reserve.php/{id}    checks eligibility of a specific grave by ID
// POST   /reserve.php         creates a reservation
// POST   /reserve.php/{id}    creates a reservation specifically for grave {id}
//
// ELIGIBLE GRAVES
// a grave is eligible if it is vacant with no Active occupant
// or if it is occupied by exactly one Active occupant whose lease is expiring within a month or already expired
// co-interment graves with 2 or more Active occupants are never eligible
// graves already referenced by an Active reservation as target or destination are excluded
//
// RESERVATION CREATION
// a reservation is a proposal to place an incoming person N into a target grave G, optionally displacing an existing occupant O
// once created the reservation is frozen
// it can only be Confirmed or Cancelled in monitor.php
// to change it, cancel it and create a new one
// mode 1 Vacant uses grave_id or grave_code, N incoming, no O
// mode 2 Replace uses old_interment_id, O leaving, N incoming into O's grave
// nothing is moved at reservation-creation time
// N is created as Pending with no grave, O is untouched, and no placement_history is written
// movements happen only when the reservation is Confirmed in monitor.php
//
// OLD OCCUPANT BIOGRAPHY EDITS
// when replacing an occupant, staff may optionally stage edits to O's biography alongside the reservation
// the edits live in reservations.old_edited_fields as a JSON DIFF, only fields the user actually changed
// they are applied to O's interments row only on Confirm
// on Cancel they are discarded and O is untouched
// editable O fields staged into old_edited_fields: deceased_name, deceased_sex, last_known_address, death_certificate
// also editable: deceased_date_of_birth, deceased_date_of_death
// also editable: contact_person_name, contact_person_phone_number, contact_person_email
// also editable: contact_person_address, contact_person_address_barangay
// also editable: burial_permit_number, burial_permit_date
// also editable: transfer_permit_number, transfer_permit_issued_by, transfer_permit_date
// also editable: exhumation_permit_number, exhumation_permit_date
// also editable: date_exhumed, burial_clearance_date, remarks
// assistance_type is intentionally not in the list above
// it has a dedicated column on reservations called old_new_assistance_type and would conflict with it on Confirm
// locked O fields that are never editable via reserve
// control_number is identity, cancel and re-reserve to fix it
// current_grave_id is the target grave and defines the reservation
// status is Active and decided by old_new_status
// date_buried is historical
// lease_expiration_date is historical
//
// ROLE SCOPING
// ADMIN and OFFICE have full access, GET and POST
// GROUNDS is view-only, GET only
// for GROUNDS, sensitive interment data is redacted from responses, that is deceased identity, contacts, addresses, permits, certificates, and dates
// for GROUNDS, search_term cannot be matched against those fields
//
// TIMESTAMPS
// created_at and updated_at are maintained by the database
// this file never writes them

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';
require_once 'reusable_functions.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

// ADMIN and OFFICE can read and write, GROUNDS is read-only
$role         = $userData['role'] ?? null;
$allowedRoles = [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS];
if (!in_array($role, $allowedRoles, true)) {
    Response::error("Forbidden. You do not have permission to perform this action.", 403);
}
if ($role === ROLE_GROUNDS && $method !== 'GET') {
    Response::error("Forbidden. ROLE_GROUNDS has view-only access and may only perform GET requests.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$formatItem = function (array $row): array {
    return [
        'type'          => $row['type'],
        'grave' => [
            'grave_id'     => (int) $row['grave_id'],
            'grave_code'   => $row['grave_code'],
            'row_num'      => $row['row_num'] !== null ? (int) $row['row_num'] : null,
            'col_num'      => $row['col_num'] !== null ? (int) $row['col_num'] : null,
            'grave_status' => $row['grave_status'],
            'grave_remarks' => $row['grave_remarks'],
            'block_id'     => $row['block_id'] !== null ? (int) $row['block_id'] : null,
            'block_name'   => $row['block_name'],
            'block_type'   => $row['block_type'],
        ],
        'interment' => $row['interment_id'] !== null ? [
            'interment_id'                    => (int) $row['interment_id'],
            'control_number'                  => $row['control_number'],
            'deceased_name'                   => $row['deceased_name'],
            'deceased_sex'                    => $row['deceased_sex'],
            'last_known_address'              => $row['last_known_address'],
            'death_certificate'               => $row['death_certificate'],
            'deceased_date_of_birth'          => $row['deceased_date_of_birth'],
            'deceased_date_of_death'          => $row['deceased_date_of_death'],
            'current_grave_id'                => $row['current_grave_id'] !== null ? (int) $row['current_grave_id'] : null,
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
            'status'                          => $row['interment_status'],
            'remarks'                         => $row['interment_remarks'],
            'created_at'                      => $row['interment_created_at'],
            'updated_at'                      => $row['interment_updated_at'],
        ] : null,
    ];
};

// Strip sensitive interment fields for GROUNDS but keep the response shape so the frontend stays the same
// To show the deceased's name to grounds, add 'deceased_name' to $keep below
$redactForGrounds = function (array $item): array {
    if ($item['interment'] === null) {
        return $item; // vacant grave, nothing to redact
    }
    $keep = ['interment_id', 'current_grave_id', 'status', 'lease_expiration_date'];
    foreach ($item['interment'] as $k => $v) {
        if (!in_array($k, $keep, true)) {
            $item['interment'][$k] = null;
        }
    }
    return $item;
};

// The two eligibility queries: one for vacant graves, one for single-occupant graves whose lease is ending
$vacantSelect = "
    SELECT
        'vacant' AS type,
        g.grave_id, g.grave_code, g.row_num, g.col_num,
        g.status AS grave_status, g.remarks AS grave_remarks,
        b.block_id, b.block_name, b.block_type,
        NULL AS interment_id, NULL AS control_number, NULL AS deceased_name,
        NULL AS deceased_sex, NULL AS last_known_address, NULL AS death_certificate,
        NULL AS deceased_date_of_birth, NULL AS deceased_date_of_death,
        NULL AS current_grave_id,
        NULL AS contact_person_name, NULL AS contact_person_phone_number,
        NULL AS contact_person_email, NULL AS contact_person_address,
        NULL AS contact_person_address_barangay,
        NULL AS assistance_type,
        NULL AS burial_permit_number, NULL AS burial_permit_date,
        NULL AS transfer_permit_number, NULL AS transfer_permit_issued_by,
        NULL AS transfer_permit_date, NULL AS exhumation_permit_number,
        NULL AS exhumation_permit_date,
        NULL AS date_buried, NULL AS date_exhumed, NULL AS burial_clearance_date,
        NULL AS lease_expiration_date,
        NULL AS interment_status, NULL AS interment_remarks,
        NULL AS interment_created_at, NULL AS interment_updated_at
    FROM graves g
    LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
    WHERE g.deleted_at IS NULL
      AND g.status = 'Vacant'
      AND NOT EXISTS (
          SELECT 1 FROM interments i
          WHERE i.current_grave_id = g.grave_id
            AND i.status = 'Active'
            AND i.deleted_at IS NULL
      )
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND (r.target_grave_id = g.grave_id OR r.old_new_grave_id = g.grave_id)
      )
";

$expiringSelect = "
    SELECT
        CASE WHEN i.lease_expiration_date < CURDATE() THEN 'expired' ELSE 'expiring' END AS type,
        g.grave_id, g.grave_code, g.row_num, g.col_num,
        g.status AS grave_status, g.remarks AS grave_remarks,
        b.block_id, b.block_name, b.block_type,
        i.interment_id, i.control_number, i.deceased_name,
        i.deceased_sex, i.last_known_address, i.death_certificate,
        i.deceased_date_of_birth, i.deceased_date_of_death,
        i.current_grave_id,
        i.contact_person_name, i.contact_person_phone_number,
        i.contact_person_email, i.contact_person_address,
        i.contact_person_address_barangay,
        i.assistance_type,
        i.burial_permit_number, i.burial_permit_date,
        i.transfer_permit_number, i.transfer_permit_issued_by,
        i.transfer_permit_date, i.exhumation_permit_number,
        i.exhumation_permit_date,
        i.date_buried, i.date_exhumed, i.burial_clearance_date,
        i.lease_expiration_date,
        i.status AS interment_status, i.remarks AS interment_remarks,
        i.created_at AS interment_created_at, i.updated_at AS interment_updated_at
    FROM interments i
    INNER JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
    LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
    WHERE i.status = 'Active'
      AND i.deleted_at IS NULL
      AND i.lease_expiration_date IS NOT NULL
      AND i.lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
      AND (
          SELECT COUNT(*) FROM interments i2
          WHERE i2.current_grave_id = g.grave_id
            AND i2.status = 'Active'
            AND i2.deleted_at IS NULL
      ) = 1
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND (r.target_grave_id = g.grave_id OR r.old_new_grave_id = g.grave_id)
      )
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND r.old_interment_id = i.interment_id
      )
";

if ($method === 'GET') {

    if ($resourceId) {
        $combinedSQL = "($expiringSelect AND g.grave_id = :id1) UNION ALL ($vacantSelect AND g.grave_id = :id2)";
        $stmt = $pdo->prepare($combinedSQL);
        $stmt->execute(['id1' => $resourceId, 'id2' => $resourceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            $item = $formatItem($row);
            if ($role === ROLE_GROUNDS) {
                $item = $redactForGrounds($item);
            }
            Response::success('Eligible grave retrieved', ['item' => $item]);
        } else {
            Response::error('Grave not found or not eligible for a reservation.', 404);
        }
    }

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

    // Only narrow to expired or expiring when exactly one of them is asked for
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
            if ($role === ROLE_GROUNDS) {
                // Grounds may only search grave-side fields plus the lease date they can already see
                // Matching against redacted interment columns would leak that a person exists by name, phone, or email
                $cols = ['g.grave_code', 'g.status', 'g.remarks', 'b.block_name', 'b.block_type'];
            } else {
                $cols = [
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
                    'i.remarks',
                    'g.grave_code',
                    'g.status',
                    'g.remarks',
                    'b.block_name',
                    'b.block_type',
                ];
            }
            $parts = [];
            foreach ($cols as $c) {
                $parts[] = "$c LIKE ?";
                $searchParams[] = $like;
            }

            // Date search covers only the columns each role can actually see
            // convert_dates() returns empty arrays for plain text, so a text search adds nothing here
            $dateCriteria = convert_dates($searchTerm);
            if ($role === ROLE_GROUNDS) {
                $expiringDateCols = [
                    'i.lease_expiration_date',
                ];
            } else {
                $expiringDateCols = [
                    'i.deceased_date_of_birth',
                    'i.deceased_date_of_death',
                    'i.burial_permit_date',
                    'i.transfer_permit_date',
                    'i.exhumation_permit_date',
                    'i.date_buried',
                    'i.date_exhumed',
                    'i.burial_clearance_date',
                    'i.lease_expiration_date',
                    'i.created_at',
                    'i.updated_at',
                ];
            }
            foreach ($dateCriteria['exact_dates'] as $d) {
                foreach ($expiringDateCols as $col) {
                    $parts[] = "DATE($col) = ?";
                    $searchParams[] = $d;
                }
            }
            foreach ($dateCriteria['month_days'] as $md) {
                foreach ($expiringDateCols as $col) {
                    $parts[] = "(MONTH($col) = ? AND DAY($col) = ?)";
                    $searchParams[] = $md['m'];
                    $searchParams[] = $md['d'];
                }
            }
            foreach ($dateCriteria['year_months'] as $ym) {
                foreach ($expiringDateCols as $col) {
                    $parts[] = "(YEAR($col) = ? AND MONTH($col) = ?)";
                    $searchParams[] = $ym['y'];
                    $searchParams[] = $ym['m'];
                }
            }
            foreach ($dateCriteria['years'] as $y) {
                foreach ($expiringDateCols as $col) {
                    $parts[] = "YEAR($col) = ?";
                    $searchParams[] = $y;
                }
            }

            $expiringSearchSQL = ' AND (' . implode(' OR ', $parts) . ')';
        }
        $subqueries[] = "($expiringSelect $expiringDateClause $expiringSearchSQL)";
    }

    if ($runVacant) {
        $vacantSearchSQL = '';
        if ($searchTerm !== '') {
            // Vacant graves have no interment row, so text search stays on grave-side fields only
            $like = '%' . $searchTerm . '%';
            $cols = ['g.grave_code', 'g.status', 'g.remarks', 'b.block_name', 'b.block_type'];
            $parts = [];
            foreach ($cols as $c) {
                $parts[] = "$c LIKE ?";
                $searchParams[] = $like;
            }
            $vacantSearchSQL = ' AND (' . implode(' OR ', $parts) . ')';
        }
        $subqueries[] = "($vacantSelect $vacantSearchSQL)";
    }

    if (empty($subqueries)) {
        Response::success('Eligible graves retrieved', [
            'pagination' => [
                'current_page'  => 1,
                'per_page'      => $limit,
                'total_records' => 0,
                'total_pages'   => 0,
            ],
            'items' => [],
        ]);
    }

    $unionSQL = implode(' UNION ALL ', $subqueries);

    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ($unionSQL) AS combined");
    $countStmt->execute($searchParams);
    $totalRecords = (int) $countStmt->fetchColumn();

    $totalPages = (int) ceil($totalRecords / $limit);
    $page       = min($page, max(1, $totalPages));
    $offset     = ($page - 1) * $limit;

    // Vacant first, then expired, then expiring, and oldest lease first inside each group
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
    if ($role === ROLE_GROUNDS) {
        $items = array_map($redactForGrounds, $items);
    }

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

    Response::success('Eligible graves retrieved', $payload);
}

if ($method === 'POST') {

    if ($resourceId && is_numeric($resourceId)) {
        $rawData['grave_id'] = (int) $resourceId;
    }

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
    foreach ($required as $field) {
        if (empty($rawData[$field])) {
            Response::error("Field '$field' is required.", 400);
        }
    }

    if (!in_array($rawData['assistance_type'], ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
        Response::error("Invalid assistance_type.", 400);
    }
    if (
        !empty($rawData['deceased_sex'])
        && !in_array($rawData['deceased_sex'], ['Male', 'Female', 'Unknown'], true)
    ) {
        Response::error("Invalid deceased_sex.", 400);
    }

    $oldIntermentId = !empty($rawData['old_interment_id']) && is_numeric($rawData['old_interment_id'])
        ? (int) $rawData['old_interment_id'] : null;

    $graveId = !empty($rawData['grave_id']) && is_numeric($rawData['grave_id'])
        ? (int) $rawData['grave_id'] : null;

    // Accept grave_code as an alternative to grave_id for convenience
    if (!$graveId && !empty($rawData['grave_code'])) {
        $g = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL");
        $g->execute([trim((string) $rawData['grave_code'])]);
        $gid = $g->fetchColumn();
        if ($gid === false) {
            Response::error("Grave code '{$rawData['grave_code']}' not found.", 400);
        }
        $graveId = (int) $gid;
    }

    if (!$graveId && !$oldIntermentId) {
        Response::error(
            "You must provide either 'grave_id' (or 'grave_code') for a vacant grave, "
                . "or 'old_interment_id' for a replacement.",
            400
        );
    }

    $oldNewGraveId        = null;
    $oldNewStatus         = null;
    $oldNewAssistanceType = null;
    $oldNewRemarks        = null;
    $oldEditedFieldsJson  = null;

    if ($oldIntermentId) {
        if (empty($rawData['old_new_status'])) {
            Response::error("'old_new_status' is required when replacing an occupant.", 400);
        }
        $oldNewStatus = (string) $rawData['old_new_status'];
        if (!in_array($oldNewStatus, ['Active', 'Inactive'], true)) {
            Response::error("Invalid old_new_status. Must be 'Active' or 'Inactive'.", 400);
        }

        if (!empty($rawData['old_new_grave_id']) && is_numeric($rawData['old_new_grave_id'])) {
            $oldNewGraveId = (int) $rawData['old_new_grave_id'];
        } elseif (!empty($rawData['old_new_grave_code'])) {
            $g = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_code = ? AND deleted_at IS NULL");
            $g->execute([trim((string) $rawData['old_new_grave_code'])]);
            $gid = $g->fetchColumn();
            if ($gid === false) {
                Response::error("Old occupant's destination grave code not found.", 400);
            }
            $oldNewGraveId = (int) $gid;
        }

        if ($oldNewStatus === 'Inactive') {
            $oldNewGraveId = null;
        }

        if (!empty($rawData['old_new_assistance_type'])) {
            $oldNewAssistanceType = (string) $rawData['old_new_assistance_type'];
            if (!in_array($oldNewAssistanceType, ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
                Response::error("Invalid old_new_assistance_type.", 400);
            }
        }

        $oldNewRemarks = isset($rawData['old_new_remarks']) && $rawData['old_new_remarks'] !== ''
            ? (string) $rawData['old_new_remarks'] : null;

        // Only fields actually present in the payload get staged, a missing key means keep O's current value
        // That keeps the JSON a real DIFF so a partial edit can't accidentally wipe fields
        // assistance_type is not in the allow-list because it has its own column on reservations
        $oldEditInput = $rawData['old_edited_fields'] ?? null;
        if (is_string($oldEditInput)) {
            $decoded = json_decode($oldEditInput, true);
            if (is_array($decoded)) {
                $oldEditInput = $decoded;
            }
        }

        if (is_array($oldEditInput) && !empty($oldEditInput)) {
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
            $allowedEnum = [
                'deceased_sex' => ['Male', 'Female', 'Unknown'],
            ];

            $staged = [];

            foreach ($allowedString as $f) {
                if (!array_key_exists($f, $oldEditInput)) continue;
                $v = $oldEditInput[$f];
                $staged[$f] = ($v === null || $v === '') ? null : (string) $v;
            }
            foreach ($allowedDate as $f) {
                if (!array_key_exists($f, $oldEditInput)) continue;
                $v = $oldEditInput[$f];
                if ($v === null || $v === '') {
                    $staged[$f] = null;
                    continue;
                }
                if (!strtotime($v)) {
                    Response::error("Invalid date format for 'old_edited_fields.$f'.", 400);
                }
                $staged[$f] = (string) $v;
            }
            foreach ($allowedEnum as $f => $allowed) {
                if (!array_key_exists($f, $oldEditInput)) continue;
                $v = $oldEditInput[$f];
                if ($v === null || $v === '') {
                    $staged[$f] = null;
                    continue;
                }
                if (!in_array($v, $allowed, true)) {
                    Response::error("Invalid value for 'old_edited_fields.$f'.", 400);
                }
                $staged[$f] = (string) $v;
            }

            if (!empty($staged)) {
                $oldEditedFieldsJson = json_encode($staged, JSON_UNESCAPED_UNICODE);
            }
        }
    }

    $exhumationPermitNumber = isset($rawData['exhumation_permit_number']) && $rawData['exhumation_permit_number'] !== ''
        ? (string) $rawData['exhumation_permit_number'] : null;
    $transferPermitNumber = isset($rawData['transfer_permit_number']) && $rawData['transfer_permit_number'] !== ''
        ? (string) $rawData['transfer_permit_number'] : null;
    $reservationNotes = isset($rawData['reservation_notes']) && $rawData['reservation_notes'] !== ''
        ? (string) $rawData['reservation_notes'] : null;

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
    foreach ($dateFields as $field) {
        if (!empty($rawData[$field]) && !strtotime($rawData[$field])) {
            Response::error("Invalid date format for '$field'.", 400);
        }
    }

    $userId = $userData['user_id'];

    $pdo->beginTransaction();
    try {
        // Resolve the target grave and lock it, replacement mode uses O's current grave
        if ($oldIntermentId) {
            $oldStmt = $pdo->prepare("
                SELECT * FROM interments
                WHERE interment_id = ? AND status = 'Active' AND deleted_at IS NULL
                FOR UPDATE
            ");
            $oldStmt->execute([$oldIntermentId]);
            $old = $oldStmt->fetch(PDO::FETCH_ASSOC);
            if (!$old) {
                throw new Exception("Old occupant not found or not Active.");
            }
            if ($old['current_grave_id'] === null) {
                throw new Exception("Old occupant has no current grave to replace.");
            }

            $targetGraveId = (int) $old['current_grave_id'];

            if ($graveId !== null && $graveId !== $targetGraveId) {
                throw new Exception("Provided grave_id does not match the old occupant's current grave.");
            }

            $gravesToLock = [$targetGraveId];
            if ($oldNewGraveId) {
                $gravesToLock[] = $oldNewGraveId;
            }
            lockGraveRows($pdo, $gravesToLock);

            $occupantCount = $pdo->prepare("
                SELECT COUNT(*) FROM interments
                WHERE current_grave_id = ? AND status = 'Active' AND deleted_at IS NULL
            ");
            $occupantCount->execute([$targetGraveId]);
            if ((int) $occupantCount->fetchColumn() !== 1) {
                throw new Exception("Target grave must have exactly one occupant for a replacement.");
            }

            if ($oldNewGraveId) {
                if ($oldNewGraveId === $targetGraveId) {
                    throw new Exception("Old occupant's destination cannot be the target grave.");
                }
                $destGrave = $pdo->prepare("
                    SELECT g.grave_id FROM graves g
                    WHERE g.grave_id = ? AND g.deleted_at IS NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM interments i
                          WHERE i.current_grave_id = g.grave_id
                            AND i.status = 'Active'
                            AND i.deleted_at IS NULL
                      )
                ");
                $destGrave->execute([$oldNewGraveId]);
                if (!$destGrave->fetch()) {
                    throw new Exception("Old occupant's destination grave is not vacant or does not exist.");
                }
            }
        } else {
            $targetGraveId = $graveId;
            lockGraveRows($pdo, [$targetGraveId]);

            $vacantCheck = $pdo->prepare("
                SELECT g.grave_id FROM graves g
                WHERE g.grave_id = ? AND g.deleted_at IS NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM interments i
                      WHERE i.current_grave_id = g.grave_id
                        AND i.status = 'Active'
                        AND i.deleted_at IS NULL
                  )
            ");
            $vacantCheck->execute([$targetGraveId]);
            if (!$vacantCheck->fetch()) {
                throw new Exception("The specified grave is not vacant or does not exist.");
            }
        }

        // No Active reservation may already hold the target, O's destination, or O itself
        $r1 = $pdo->prepare("
            SELECT reservation_id FROM reservations
            WHERE reservation_state = 'Active'
              AND (target_grave_id = ? OR old_new_grave_id = ?)
            LIMIT 1
        ");
        $r1->execute([$targetGraveId, $targetGraveId]);
        if ($r1->fetch()) {
            throw new Exception("This grave is already referenced by an Active reservation.");
        }

        if ($oldNewGraveId) {
            $r2 = $pdo->prepare("
                SELECT reservation_id FROM reservations
                WHERE reservation_state = 'Active'
                  AND (target_grave_id = ? OR old_new_grave_id = ?)
                LIMIT 1
            ");
            $r2->execute([$oldNewGraveId, $oldNewGraveId]);
            if ($r2->fetch()) {
                throw new Exception("Old occupant's destination grave is already referenced by an Active reservation.");
            }
        }

        if ($oldIntermentId) {
            $r3 = $pdo->prepare("
                SELECT reservation_id FROM reservations
                WHERE reservation_state = 'Active' AND old_interment_id = ?
                LIMIT 1
            ");
            $r3->execute([$oldIntermentId]);
            if ($r3->fetch()) {
                throw new Exception("Old occupant already has an Active reservation.");
            }
        }

        // N is created Pending with no grave, the move only happens on Confirm
        $insertFields = [
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
            'created_by',
            'updated_by',
        ];

        $placeholders = [];
        $values = [];
        foreach ($insertFields as $field) {
            if ($field === 'current_grave_id') {
                $val = null;
            } elseif ($field === 'status') {
                $val = 'Pending';
            } elseif ($field === 'created_by' || $field === 'updated_by') {
                $val = $userId;
            } else {
                $val = isset($rawData[$field]) && $rawData[$field] !== '' ? $rawData[$field] : null;
            }
            $placeholders[] = '?';
            $values[] = $val;
        }

        $sql = "INSERT INTO interments (" . implode(', ', $insertFields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newIntermentId = (int) $pdo->lastInsertId();

        // The reservation is frozen here, only monitor.php can Confirm or Cancel it
        $resStmt = $pdo->prepare("
            INSERT INTO reservations (
                pending_interment_id,
                target_grave_id,
                old_interment_id,
                old_new_grave_id,
                old_new_status,
                old_new_assistance_type,
                old_new_remarks,
                exhumation_permit_number,
                transfer_permit_number,
                old_edited_fields,
                reservation_notes,
                reservation_state,
                created_by,
                updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)
        ");
        $resStmt->execute([
            $newIntermentId,
            $targetGraveId,
            $oldIntermentId,
            $oldNewGraveId,
            $oldNewStatus,
            $oldNewAssistanceType,
            $oldNewRemarks,
            $exhumationPermitNumber,
            $transferPermitNumber,
            $oldEditedFieldsJson,
            $reservationNotes,
            $userId,
            $userId,
        ]);
        $reservationId = (int) $pdo->lastInsertId();

        $pdo->commit();

        systemLog(
            "Reservation created: reservation $reservationId, pending interment $newIntermentId -> target grave $targetGraveId"
                . ($oldIntermentId ? ", replacing old interment $oldIntermentId" : "")
                . ($oldNewGraveId ? ", old occupant -> grave $oldNewGraveId" : "")
                . ($oldEditedFieldsJson ? ", O biography edits staged" : ""),
            $userId
        );

        Response::success("Reservation created successfully.", [
            'reservation_id'       => $reservationId,
            'pending_interment_id' => $newIntermentId,
            'target_grave_id'      => $targetGraveId,
            'old_interment_id'     => $oldIntermentId,
            'old_new_grave_id'     => $oldNewGraveId,
            'old_new_status'       => $oldNewStatus,
            'old_edits_staged'     => $oldEditedFieldsJson !== null,
        ], 201);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        $sqlState = (string) $e->getCode();
        $msg      = $e->getMessage();

        if ($sqlState === '23000') {
            if (strpos($msg, 'uk_active_control_number') !== false) {
                Response::error("Conflict: Control number already exists.", 409);
            }
            if (strpos($msg, 'uk_active_target_grave') !== false) {
                Response::error("Conflict: This grave already has an Active reservation.", 409);
            }
            if (strpos($msg, 'uk_active_old_interment') !== false) {
                Response::error("Conflict: This old occupant already has an Active reservation.", 409);
            }
            if (strpos($msg, 'uk_active_pending_interment') !== false) {
                Response::error("Conflict: This incoming person already has an Active reservation.", 409);
            }
            systemLog("Reservation creation integrity violation: " . $msg, 'System');
            Response::error("Conflict: Reservation could not be created.", 409);
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
            systemLog("Reservation creation CHECK violation: " . $msg, 'System');
            Response::error("Conflict: Reservation could not be created.", 409);
        }
        if ($sqlState === '22007') {
            Response::error("The Date Formats are invalid, please check again!", 409);
        }

        systemLog("Reservation creation DB error: " . $msg, 'System');
        Response::error("Database error while creating the reservation.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        systemLog("Reservation creation error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 400);
    }
}

Response::error("Method Not Allowed", 405);
