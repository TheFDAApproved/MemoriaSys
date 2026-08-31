<?php

/**
 * Reserve.php – Discover graves and initiate a reservation (REST API)
 *
 * GET  /reserve.php      : List all graves that can be reserved (paginated)
 * GET  /reserve.php/{id} : Check availability of a specific grave by ID
 * POST /reserve.php      : Create a reservation (provide `grave_id` or `old_interment_id` in body)
 * POST /reserve.php/{id} : Create a reservation specifically for grave {id}
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'textbee.php';     // if used for SMS, keep
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
        'transfer_to_grave'        => $row['transfer_to_grave'] ? (int) $row['transfer_to_grave'] : null,
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
        'contact_person_address'   => $row['contact_person_address']
    ];
};

// -----------------------------------------------------------------------------
// 1. GET – List available graves OR fetch a specific grave's availability
// -----------------------------------------------------------------------------
if ($method === 'GET') {

    // Base SQL for expiring interments
    $expiringSQL = "
        SELECT 'expiring' AS type, i.interment_id, i.control_number, i.deceased_name, i.last_known_address, 
               i.death_certificate, i.deceased_date_of_birth, i.deceased_date_of_death, i.current_grave_id, 
               i.transfer_to_grave, i.contact_person_name, i.contact_person_phone_number, i.contact_person_email, 
               i.assistance_type, i.burial_permit_number, i.burial_permit_date, i.transfer_permit_number, 
               i.transfer_permit_issued_by, i.transfer_permit_date, i.exhumation_permit_number, 
               i.exhumation_permit_date, i.date_buried, i.date_exhumed, i.burial_clearance_date, 
               i.lease_expiration_date, i.status AS interment_status, i.remarks AS interment_remarks,
               i.deceased_sex, i.contact_person_address, 
               g.grave_id, g.grave_code, g.row_num, g.col_num, g.status AS grave_status, g.remarks AS grave_remarks, 
               b.block_name, b.block_id, b.block_type
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id
        LEFT JOIN blocks b ON g.block_id = b.block_id
        WHERE i.status = 'Active'
          AND i.lease_expiration_date IS NOT NULL
          AND i.lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
    ";

    // Base SQL for vacant graves
    $vacantSQL = "
        SELECT 'vacant' AS type, NULL AS interment_id, NULL AS control_number, NULL AS deceased_name, 
               NULL AS last_known_address, NULL AS death_certificate, NULL AS deceased_date_of_birth, 
               NULL AS deceased_date_of_death, NULL AS current_grave_id, NULL AS transfer_to_grave, 
               NULL AS contact_person_name, NULL AS contact_person_phone_number, NULL AS contact_person_email, 
               NULL AS assistance_type, NULL AS burial_permit_number, NULL AS burial_permit_date, 
               NULL AS transfer_permit_number, NULL AS transfer_permit_issued_by, NULL AS transfer_permit_date, 
               NULL AS exhumation_permit_number, NULL AS exhumation_permit_date, NULL AS date_buried, 
               NULL AS date_exhumed, NULL AS burial_clearance_date, NULL AS lease_expiration_date, 
               NULL AS interment_status, NULL AS interment_remarks, g.grave_id, g.grave_code, g.row_num, 
               NULL AS deceased_sex, NULL AS contact_person_address,
               g.col_num, g.status AS grave_status, g.remarks AS grave_remarks, b.block_name, b.block_id, b.block_type
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id
        WHERE g.status = 'Vacant'
          AND NOT EXISTS (
              SELECT 1 FROM interments i
              WHERE i.current_grave_id = g.grave_id
                AND i.status = 'Active'
          )
    ";

    // Scenario A: Requesting a SPECIFIC resource /reserve.php/{id}
    if ($resourceId) {
        $expiringSQL .= " AND g.grave_id = :id1";
        $vacantSQL   .= " AND g.grave_id = :id2";

        $combinedSQL = "($expiringSQL) UNION ($vacantSQL)";

        $stmt = $pdo->prepare($combinedSQL);
        $stmt->execute(['id1' => $resourceId, 'id2' => $resourceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            Response::success('Available grave retrieved', ['item' => $formatItem($row)]);
        } else {
            Response::error('Grave not found or not available for reservation', 404);
        }
    }
    // Scenario B: Requesting the COLLECTION /reserve.php
    else {
        // Pagination parameters
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
        $limit = max(1, min($limit, 500));
        $page  = isset($_GET['page']) ? (int) $_GET['page'] : 1;
        $page  = max(1, $page);

        // Combine both result sets with a UNION
        $combinedSQL = "($expiringSQL) UNION ($vacantSQL) ORDER BY type DESC, lease_expiration_date ASC, block_name, grave_code";

        // Count total
        $countSQL = "SELECT COUNT(*) FROM ($combinedSQL) AS combined";
        $totalRecords = (int) $pdo->query($countSQL)->fetchColumn();
        $totalPages = ceil($totalRecords / $limit);
        $page = min($page, $totalPages ?: 1);
        $offset = ($page - 1) * $limit;

        // Add pagination
        $paginatedSQL = $combinedSQL . " LIMIT $limit OFFSET $offset";
        $stmt = $pdo->prepare($paginatedSQL);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map($formatItem, $rows);

        $pagination = [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ];

        Response::success('Available graves retrieved', ['pagination' => $pagination, 'items' => $items]);
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

    $graveId = null;
    $oldIntermentId = null;
    $oldTransferToGrave = null; // New field for where the old occupant is going

    if (!empty($rawData['grave_id']) && is_numeric($rawData['grave_id'])) {
        // Case 1: Direct reservation on a vacant grave
        $graveId = (int) $rawData['grave_id'];

        $check = $pdo->prepare("
            SELECT g.grave_id, g.status 
            FROM graves g
            WHERE g.grave_id = ? AND g.status = 'Vacant'
              AND NOT EXISTS (
                  SELECT 1 FROM interments i
                  WHERE i.current_grave_id = g.grave_id AND i.status = 'Active'
              )
        ");
        $check->execute([$graveId]);
        if (!$check->fetch()) {
            Response::error("The specified grave is not vacant or does not exist.", 400);
        }
    } elseif (!empty($rawData['old_interment_id']) && is_numeric($rawData['old_interment_id'])) {
        // Case 2: Replace an existing occupant
        $oldIntermentId = (int) $rawData['old_interment_id'];

        $oldStmt = $pdo->prepare("SELECT current_grave_id, deceased_name FROM interments WHERE interment_id = ? AND status = 'Active'");
        $oldStmt->execute([$oldIntermentId]);
        $old = $oldStmt->fetch(PDO::FETCH_ASSOC);

        if (!$old) {
            Response::error("Old occupant not found or not active.", 404);
        }
        if (is_null($old['current_grave_id'])) {
            Response::error("Old occupant does not have a valid current_grave_id assignment.", 400);
        }

        $graveId = $old['current_grave_id'];

        // Ensure grave is occupied
        $checkGrave = $pdo->prepare("SELECT status FROM graves WHERE grave_id = ?");
        $checkGrave->execute([$graveId]);
        if ($checkGrave->fetchColumn() !== 'Occupied') {
            Response::error("The grave is not currently occupied. Cannot replace.", 400);
        }

        // Where is the old occupant going? (Can be null if moved out of cemetery completely)
        $oldTransferToGrave = !empty($rawData['old_transfer_to_grave']) ? (int)$rawData['old_transfer_to_grave'] : null;

        // Prepare remarks update for old occupant
        $newDeceased = trim($rawData['deceased_name']);
        $newControl  = trim($rawData['control_number']);
        $transferRemarks = trim($rawData['remarks_old_occupant'] ?? '');
        $defaultRemarks = "To be replaced by $newDeceased (control: $newControl).";
        $oldRemarks = $transferRemarks ?: $defaultRemarks;
    } else {
        Response::error("You must provide either 'grave_id' (for vacant grave) or 'old_interment_id' (for replacement).", 400);
    }

    // Prepare fields for NEW occupant. 
    // They are not in a grave yet, so current_grave_id is NULL, transfer_to_grave is the target.
    $insertFields = [
        'control_number',
        'deceased_name',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'current_grave_id',
        'transfer_to_grave',
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
        'contact_person_address'
    ];

    $placeholders = [];
    $values = [];

    foreach ($insertFields as $field) {
        if ($field === 'current_grave_id') {
            $val = null;
        } elseif ($field === 'transfer_to_grave') {
            $val = $graveId;
        } elseif ($field === 'status') {
            $val = 'Pending';
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
        // 1. Insert new pending interment
        $sql = "INSERT INTO interments (" . implode(', ', $insertFields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newIntermentId = $pdo->lastInsertId();

        // 2. If replacing an old occupant, update their target grave and remarks
        if ($oldIntermentId) {
            $updateOld = $pdo->prepare("
                UPDATE interments 
                SET transfer_to_grave = ?, remarks = CONCAT(COALESCE(remarks, ''), ' ', ?) 
                WHERE interment_id = ?
            ");
            $fullRemarks = $oldRemarks . " (new interment ID: $newIntermentId)";
            $updateOld->execute([$oldTransferToGrave, $fullRemarks, $oldIntermentId]);
        }

        $pdo->commit();
        systemLog("Reservation created: pending interment $newIntermentId targets grave $graveId" . ($oldIntermentId ? ", replacing old occupant $oldIntermentId" : ""), $userData['user_id']);

        Response::success("Reservation created successfully.", [
            'new_interment_id' => $newIntermentId,
            'target_grave_id'  => $graveId,
            'old_interment_id' => $oldIntermentId,
            'old_transfer_to'  => $oldTransferToGrave
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

// If method not allowed
Response::error("Method Not Allowed", 405);
