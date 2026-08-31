<?php

/**
 * Monitor.php – View pending interments and execute them (activate)
 * 
 * GET    /monitor.php      : List all pending interments (paginated).
 * GET    /monitor.php/{id} : Get details of a specific pending interment.
 * POST   /monitor.php/{id} : Execute a pending interment (activate it).
 * DELETE /monitor.php/{id} : Cancel a pending interment.
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
    // New occupant (Pending)
    $newOccupant = [
        'interment_id'           => (int) $row['interment_id'],
        'control_number'         => $row['control_number'],
        'deceased_name'          => $row['deceased_name'],
        'last_known_address'     => $row['last_known_address'],
        'death_certificate'      => $row['death_certificate'],
        'deceased_date_of_birth' => $row['deceased_date_of_birth'],
        'deceased_date_of_death' => $row['deceased_date_of_death'],
        'current_grave_id'       => $row['current_grave_id'] ? (int) $row['current_grave_id'] : null,
        'transfer_to_grave'      => $row['transfer_to_grave'] ? (int) $row['transfer_to_grave'] : null,
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
        'contact_person_address'   => $row['contact_person_address']
    ];

    // Old occupant (if any, matching the target grave)
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
            'transfer_to_grave'      => $row['old_transfer_to_grave'] ? (int) $row['old_transfer_to_grave'] : null,
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
            'contact_person_address'   => $row['old_contact_person_address']
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
        'type'         => $oldOccupant ? 'replacement' : 'vacant',  // indicate case
        'new_occupant' => $newOccupant,
        'old_occupant' => $oldOccupant,
        'target_grave' => $grave,
    ];
};

// -----------------------------------------------------------------------------
// GET – List all pending interments (or fetch a specific one)
// -----------------------------------------------------------------------------
if ($method === 'GET') {
    // Base SQL
    // We join graves based on the new occupant's transfer_to_grave.
    // We join the old occupant based on who is currently 'Active' in that transfer_to_grave.
    $baseSql = "
        SELECT 
            p.*,
            o.interment_id AS old_interment_id, o.control_number AS old_control_number, o.deceased_name AS old_deceased_name,
            o.last_known_address AS old_last_known_address, o.death_certificate AS old_death_certificate,
            o.deceased_date_of_birth AS old_deceased_date_of_birth, o.deceased_date_of_death AS old_deceased_date_of_death,
            o.current_grave_id AS old_current_grave_id, o.transfer_to_grave AS old_transfer_to_grave, 
            o.contact_person_name AS old_contact_person_name, o.contact_person_phone_number AS old_contact_person_phone_number, 
            o.contact_person_email AS old_contact_person_email, o.assistance_type AS old_assistance_type, 
            o.burial_permit_number AS old_burial_permit_number, o.burial_permit_date AS old_burial_permit_date, 
            o.transfer_permit_number AS old_transfer_permit_number, o.transfer_permit_issued_by AS old_transfer_permit_issued_by, 
            o.transfer_permit_date AS old_transfer_permit_date, o.exhumation_permit_number AS old_exhumation_permit_number, 
            o.exhumation_permit_date AS old_exhumation_permit_date, o.date_buried AS old_date_buried, 
            o.date_exhumed AS old_date_exhumed, o.burial_clearance_date AS old_burial_clearance_date,
            o.lease_expiration_date AS old_lease_expiration_date, o.status AS old_status, o.remarks AS old_remarks,
            o.contact_person_address AS old_contact_person_address, o.deceased_sex AS old_deceased_sex,
            g.grave_id AS target_grave_id, g.grave_code, g.row_num, g.col_num, g.status AS grave_status, g.remarks AS grave_remarks,
            b.block_name, b.block_id, b.block_type
        FROM interments p
        LEFT JOIN interments o ON o.current_grave_id = p.transfer_to_grave AND o.status = 'Active' AND o.interment_id != p.interment_id
        LEFT JOIN graves g ON p.transfer_to_grave = g.grave_id
        LEFT JOIN blocks b ON g.block_id = b.block_id
        WHERE p.status = 'Pending'
    ";

    // Scenario A: Requesting a SPECIFIC resource /monitor.php/{id}
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
    // Scenario B: Requesting the COLLECTION /monitor.php
    else {
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
        $limit = max(1, min($limit, 500));
        $page  = isset($_GET['page']) ? (int) $_GET['page'] : 1;
        $page  = max(1, $page);

        // Count total
        $countSql = "SELECT COUNT(*) FROM interments WHERE status = 'Pending'";
        $totalRecords = (int) $pdo->query($countSql)->fetchColumn();
        $totalPages = ceil($totalRecords / $limit);
        $page = min($page, $totalPages ?: 1);
        $offset = ($page - 1) * $limit;

        $paginatedSql = $baseSql . " ORDER BY p.interment_id DESC LIMIT $limit OFFSET $offset";
        $stmt = $pdo->prepare($paginatedSql);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $pendingTransfers = array_map($formatTransfer, $rows);

        $pagination = [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ];

        Response::success('Pending transfers retrieved', ['pagination' => $pagination, 'transfers' => $pendingTransfers]);
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

    // Fetch pending interment
    $pendingStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ? AND status = 'Pending'");
    $pendingStmt->execute([$pendingId]);
    $pending = $pendingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$pending) {
        Response::error("Pending interment not found or not in Pending status.", 404);
    }

    $targetGraveId = $pending['transfer_to_grave'];

    // Check if there is an active old occupant in the target grave
    $oldStmt = $pdo->prepare("
        SELECT * FROM interments 
        WHERE current_grave_id = ? AND status = 'Active' AND interment_id != ?
    ");
    $oldStmt->execute([$targetGraveId, $pendingId]);
    $old = $oldStmt->fetch(PDO::FETCH_ASSOC);

    $pdo->beginTransaction();
    try {
        // --- CASE: Handle Old Occupant first if they exist ---
        if ($old) {
            // Frontend can optionally override the old occupant's fate during execution
            $oldUpdate = $rawData['old_occupant_update'] ?? [];

            // Determine their new status (Default: if they had a transfer target planned, stay Active. Else Inactive).
            $oldNewStatus = $oldUpdate['status'] ?? ($old['transfer_to_grave'] ? 'Active' : 'Inactive');
            // Determine their target grave (Default: what was planned in Reserve.php)
            $oldNewGraveId = $oldUpdate['new_current_grave_id'] ?? $old['transfer_to_grave'];
            $oldRemarks = trim($oldUpdate['remarks'] ?? '');

            if ($oldNewStatus === 'Active') {
                if ($oldNewGraveId) {
                    if ($oldNewGraveId == $targetGraveId) {
                        throw new Exception("Old occupant cannot stay in the same grave being reserved.");
                    }
                    // Validate new grave is vacant
                    $checkNew = $pdo->prepare("
                        SELECT status FROM graves WHERE grave_id = ? AND status = 'Vacant'
                          AND NOT EXISTS (SELECT 1 FROM interments WHERE current_grave_id = ? AND status = 'Active')
                    ");
                    $checkNew->execute([$oldNewGraveId, $oldNewGraveId]);
                    if (!$checkNew->fetch()) {
                        throw new Exception("The destination grave for the old occupant is not vacant or does not exist.");
                    }

                    // Move old occupant to their new physical grave
                    $updateOld = $pdo->prepare("
                        UPDATE interments 
                        SET current_grave_id = ?, transfer_to_grave = NULL, status = 'Active', remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)
                        WHERE interment_id = ?
                    ");
                    $updateOld->execute([$oldNewGraveId, $oldRemarks, $old['interment_id']]);

                    // Mark their new grave as Occupied
                    $markNew = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
                    $markNew->execute([$oldNewGraveId]);
                } else {
                    // COMMON BONE CHAMBER CASE: Active status, but no physical grave_id (NULL). Mentioned in remarks.
                    $updateOld = $pdo->prepare("
                        UPDATE interments 
                        SET current_grave_id = NULL, transfer_to_grave = NULL, status = 'Active', remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)
                        WHERE interment_id = ?
                    ");
                    $updateOld->execute([$oldRemarks, $old['interment_id']]);
                }
            } else {
                // Status is Inactive (Removed from cemetery completely)
                $updateOld = $pdo->prepare("
                    UPDATE interments 
                    SET current_grave_id = NULL, transfer_to_grave = NULL, status = 'Inactive', remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)
                    WHERE interment_id = ?
                ");
                $updateOld->execute([$oldRemarks, $old['interment_id']]);
            }
        }

        // --- Execute the Pending Interment (The New Occupant) ---
        // They take over the current_grave_id, and their transfer target is cleared.
        $updatePending = $pdo->prepare("
            UPDATE interments 
            SET status = 'Active', current_grave_id = ?, transfer_to_grave = NULL 
            WHERE interment_id = ?
        ");
        $updatePending->execute([$targetGraveId, $pendingId]);

        // Ensure their target grave is marked as Occupied
        if ($targetGraveId) {
            $markTarget = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");
            $markTarget->execute([$targetGraveId]);
        }

        $pdo->commit();
        systemLog("Transfer executed: pending $pendingId activated to grave $targetGraveId." . ($old ? " Old occupant {$old['interment_id']} updated." : ""), $userData['user_id']);

        Response::success("Transfer executed successfully.", [
            'pending_interment_id' => $pendingId,
            'target_grave_id'      => $targetGraveId,
            'old_interment_id'     => $old ? $old['interment_id'] : null,
            'type'                 => $old ? 'replacement' : 'vacant'
        ]);
    } catch (Exception $e) {
        $pdo->rollBack();
        systemLog("Monitor execution error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 400); // Send the specific validation error message back
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Monitor Database error: " . $e->getMessage(), 'System');
        Response::error("Database error while executing transfer.", 500);
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

    // Fetch the pending interment
    $pendingStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ? AND status = 'Pending'");
    $pendingStmt->execute([$pendingId]);
    $pending = $pendingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$pending) {
        Response::error("Pending interment not found or already processed.", 404);
    }

    $targetGraveId = $pending['transfer_to_grave'];
    $hasActive = false; // Flag to check if target grave is still occupied

    $pdo->beginTransaction();
    try {
        // 1. Mark pending interment as Inactive and clear its transfer target
        $cancelRemark = "Cancelled on " . date('Y-m-d H:i:s');
        $update = $pdo->prepare("
            UPDATE interments 
            SET status = 'Inactive', transfer_to_grave = NULL, remarks = CONCAT(COALESCE(remarks, ''), ' ', ?)
            WHERE interment_id = ?
        ");
        $update->execute([$cancelRemark, $pendingId]);

        // 2. Check the fate of the Target Grave
        if ($targetGraveId) {
            $checkActive = $pdo->prepare("
                SELECT interment_id FROM interments 
                WHERE current_grave_id = ? AND status = 'Active'
            ");
            $checkActive->execute([$targetGraveId]);
            $activeOccupant = $checkActive->fetch(PDO::FETCH_ASSOC);

            if (!$activeOccupant) {
                // If nobody is actively occupying it, we safely set it back to Vacant
                $freeGrave = $pdo->prepare("UPDATE graves SET status = 'Vacant' WHERE grave_id = ?");
                $freeGrave->execute([$targetGraveId]);
            } else {
                $hasActive = true;
                // If there IS an old occupant, their `transfer_to_grave` was probably set anticipating this move.
                // We clear their transfer target since the replacement is canceled.
                $clearOld = $pdo->prepare("
                    UPDATE interments 
                    SET transfer_to_grave = NULL, remarks = CONCAT(COALESCE(remarks, ''), ' [Replacement cancelled]') 
                    WHERE interment_id = ?
                ");
                $clearOld->execute([$activeOccupant['interment_id']]);
            }
        }

        $pdo->commit();
        systemLog("Cancelled pending interment $pendingId", $userData['user_id']);
        Response::success("Pending interment cancelled.", [
            'pending_interment_id' => $pendingId,
            'target_grave_id'      => $targetGraveId,
            'grave_freed'          => ($targetGraveId && !$hasActive) // True if grave went back to Vacant
        ]);
    } catch (PDOException $e) {
        $pdo->rollBack();
        systemLog("Monitor cancellation error: " . $e->getMessage(), 'System');
        Response::error("Database error while cancelling.", 500);
    }
}

// If method not allowed
Response::error("Method Not Allowed", 405);
