<?php

/**
 * graves.php – Manage individual graves within a block
 *
 * GET : List graves (filter by block_id, status, search term) or get a
 *       specific grave with its occupants.
 *
 *       When filtering by status=vacant, graves that are referenced by an
 *       Active reservation (as target or as O's destination) are excluded —
 *       they are effectively reserved and not truly available.
 *
 * PUT : Update a grave's `status` or `remarks` ONLY.
 *
 *       `row_num` and `col_num` are intentionally NOT editable here.
 *       Those coordinates are part of the block's grid and are owned by
 *       blocks.php. Allowing them here would break `grave_code`,
 *       duplicate-position invariants, and the shrink/enlarge contract.
 *
 *       There is NO DELETE endpoint. A grave is either Vacant, Occupied,
 *       or Other. To retire a grave, set status = 'Other' with a remark.
 *       To remove graves entirely, shrink or delete the parent block.
 *
 * STATUS RULES:
 *   Vacant or Other -> reject if an Active interment currently lives here.
 *   Occupied        -> always allowed (manual occupation / maintenance).
 *   Any status change is also rejected while an Active reservation targets
 *   this grave, because the grave is locked by the reservation workflow.
 *   Remarks changes are ALWAYS allowed.
 *
 * CONCURRENCY:
 *   PUT opens a transaction, sets READ COMMITTED isolation, then locks
 *   the grave row with SELECT ... FOR UPDATE. Concurrent PUTs on the
 *   same grave (or a blocks.php shrink/delete that would touch it) are
 *   serialized: the second request waits, then sees the first request's
 *   committed state. Lock wait / deadlock exceptions are mapped to 409
 *   with a retry-friendly message.
 *
 * ERROR HANDLING:
 *   Every write path catches PDOException and maps MySQL error codes to
 *   friendly HTTP responses via friendlyDbError(). The raw exception is
 *   always logged so the real cause is never lost.
 *
 * All operations exclude soft-deleted rows (deleted_at IS NULL).
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser(false);
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role          = $userData['role'] ?? null;
$isStaff       = in_array($role, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]);
$isAdminOffice = in_array($role, [ROLE_ADMIN, ROLE_OFFICE]);

// Parse path info: /graves.php/{id}
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

/**
 * Returns the interment_id of the Active interment on this grave, or null.
 * "Active" means physically present in the cemetery.
 */
function findActiveInterment(PDO $pdo, int $graveId): ?int
{
    $stmt = $pdo->prepare("
        SELECT interment_id FROM interments
        WHERE current_grave_id = ?
          AND status = 'Active'
          AND deleted_at IS NULL
        LIMIT 1
    ");
    $stmt->execute([$graveId]);
    $id = $stmt->fetchColumn();
    return $id !== false ? (int) $id : null;
}

/**
 * Returns the reservation_id of an Active reservation targeting this grave,
 * or null.  An Active reservation locks the grave while it awaits
 * Confirm/Cancel.  A grave is "targeted" if it's the incoming occupant's
 * target OR the old occupant's destination.
 */
function findActivePlanOnGrave(PDO $pdo, int $graveId): ?int
{
    $stmt = $pdo->prepare("
        SELECT reservation_id FROM reservations
        WHERE reservation_state = 'Active'
          AND (target_grave_id = ? OR old_new_grave_id = ?)
        LIMIT 1
    ");
    $stmt->execute([$graveId, $graveId]);
    $id = $stmt->fetchColumn();
    return $id !== false ? (int) $id : null;
}

/**
 * Map a PDOException to (user_message, http_status).
 * Every MySQL error we can meaningfully handle gets a friendly message.
 */
function friendlyDbError(PDOException $e, string $context = 'operation'): array
{
    $mysqlCode = $e->errorInfo[1] ?? null;
    $detail    = (string) ($e->errorInfo[2] ?? $e->getMessage());

    switch ($mysqlCode) {
        case 1062: // Duplicate entry for a unique index
            if (stripos($detail, 'uk_active_grave_code') !== false) {
                return ["A grave with this code already exists.", 409];
            }
            return ["A record with the same unique value already exists.", 409];

        case 1205: // Lock wait timeout exceeded
        case 1213: // Deadlock found when trying to get lock
            return [
                "This grave is currently being edited by another user. "
                    . "Please try again in a moment.",
                409
            ];

        case 1451: // Cannot delete/update parent row: FK constraint fails
            return ["Cannot complete: other records still reference this grave.", 409];

        case 1452: // Cannot add/update child row: FK constraint fails
            return ["Cannot complete: a referenced record does not exist.", 409];

        case 1406: // Data too long for column
            return ["One of the provided values is too long for its column.", 400];

        case 1048: // Column cannot be null
            return ["A required field was missing or empty.", 400];

        case 1264: // Out of range value for column
            return ["A numeric value is out of range.", 400];

        default:
            return ["Database error while processing $context.", 500];
    }
}

/**
 * Log the raw error, then send the friendly one. Never returns.
 */
function failWithDbError(PDOException $e, string $context): void
{
    [$msg, $code] = friendlyDbError($e, $context);
    systemLog("$context error: " . $e->getMessage(), 'System');
    Response::error($msg, $code);
}

// -----------------------------------------------------------------------------
// GET – List graves or a single grave
// -----------------------------------------------------------------------------
if ($method === 'GET') {

    // ---- Single grave (with occupants for staff) --------------------------
    if (is_numeric($resourceId)) {
        $graveId = (int) $resourceId;

        if ($isStaff) {
            $sql = "
                SELECT
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status, g.remarks,
                    b.block_id, b.block_name, b.block_type,
                    i.interment_id,
                    i.control_number,
                    i.deceased_name,
                    i.last_known_address,
                    i.date_buried,
                    i.lease_expiration_date,
                    i.contact_person_name,
                    i.contact_person_phone_number,
                    i.contact_person_email,
                    i.contact_person_address
                FROM graves g
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                LEFT JOIN interments i
                    ON g.grave_id = i.current_grave_id
                    AND i.status = 'Active'
                    AND i.deleted_at IS NULL
                WHERE g.grave_id = ? AND g.deleted_at IS NULL
                ORDER BY i.interment_id
            ";
        } else {
            // Public: no interments, no remarks
            $sql = "
                SELECT
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status,
                    b.block_id, b.block_name
                FROM graves g
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                WHERE g.grave_id = ? AND g.deleted_at IS NULL
            ";
        }

        $stmt = $pdo->prepare($sql);
        $stmt->execute([$graveId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (empty($rows)) {
            Response::error("Grave not found.", 404);
        }

        if ($isStaff) {
            $grave     = null;
            $occupants = [];
            foreach ($rows as $row) {
                if (!$grave) {
                    $grave = [
                        'grave_id'   => $row['grave_id'],
                        'grave_code' => $row['grave_code'],
                        'row_num'    => $row['row_num'],
                        'col_num'    => $row['col_num'],
                        'status'     => $row['status'],
                        'remarks'    => $row['remarks'],
                        'block_id'   => $row['block_id'],
                        'block_name' => $row['block_name'],
                        'block_type' => $row['block_type'],
                    ];
                }
                if ($row['interment_id']) {
                    $occupants[] = [
                        'interment_id'                => (int) $row['interment_id'],
                        'control_number'              => $row['control_number'],
                        'deceased_name'               => $row['deceased_name'],
                        'last_known_address'          => $row['last_known_address'],
                        'date_buried'                 => $row['date_buried'],
                        'lease_expiration_date'       => $row['lease_expiration_date'],
                        'contact_person_name'         => $row['contact_person_name'],
                        'contact_person_phone_number' => $row['contact_person_phone_number'],
                        'contact_person_email'        => $row['contact_person_email'],
                        'contact_person_address'      => $row['contact_person_address'],
                    ];
                }
            }
            $grave['occupants'] = $occupants;

            // Backward-compat: mirror first occupant's fields onto the grave.
            if (!empty($occupants)) {
                $first = $occupants[0];
                $grave['occupant_interment_id']       = $first['interment_id'];
                $grave['occupant_control_number']     = $first['control_number'];
                $grave['occupant_deceased_name']      = $first['deceased_name'];
                $grave['occupant_last_known_address'] = $first['last_known_address'];
                $grave['occupant_date_buried']        = $first['date_buried'];
                $grave['occupant_lease_expiration']   = $first['lease_expiration_date'];
                $grave['occupant_contact_name']       = $first['contact_person_name'];
                $grave['occupant_contact_phone']      = $first['contact_person_phone_number'];
                $grave['occupant_contact_email']      = $first['contact_person_email'];
                $grave['occupant_contact_address']    = $first['contact_person_address'];
            } else {
                $grave['occupant_interment_id']       = null;
                $grave['occupant_control_number']     = null;
                $grave['occupant_deceased_name']      = null;
                $grave['occupant_last_known_address'] = null;
                $grave['occupant_date_buried']        = null;
                $grave['occupant_lease_expiration']   = null;
                $grave['occupant_contact_name']       = null;
                $grave['occupant_contact_phone']      = null;
                $grave['occupant_contact_email']      = null;
                $grave['occupant_contact_address']    = null;
            }

            Response::success("Grave retrieved.", ['grave' => $grave]);
        } else {
            Response::success("Grave retrieved.", ['grave' => $rows[0]]);
        }
    }

    // ---- List graves ------------------------------------------------------
    $blockId    = isset($_GET['block_id']) ? (int) $_GET['block_id'] : null;
    $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
    if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
        Response::error("Search term must be at least 3 characters long", 400);
    }

    $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
    $page  = max(1, (int) ($_GET['page'] ?? 1));

    // ---- Status filter (vacant | occupied | other, comma-separated) ------
    $statusRaw = $_GET['status'] ?? '';
    if (is_array($statusRaw)) {
        $statusRaw = implode(',', $statusRaw);
    }
    $statusFilter    = strtolower(trim((string) $statusRaw));
    $allowedStatuses = ['vacant', 'occupied', 'other'];
    $wantedStatuses  = [];

    if ($statusFilter !== '') {
        foreach (explode(',', $statusFilter) as $s) {
            $s = trim($s);
            if (!in_array($s, $allowedStatuses, true)) {
                Response::error("Invalid status '$s'. Allowed: vacant, occupied, other.", 400);
            }
            if (!in_array($s, $wantedStatuses, true)) {
                $wantedStatuses[] = $s;
            }
        }
    }

    // ---- Build WHERE + params --------------------------------------------
    $where  = "g.deleted_at IS NULL";
    $params = [];

    if ($blockId) {
        $where   .= " AND g.block_id = ?";
        $params[] = $blockId;
    }

    if (!empty($wantedStatuses)) {
        // DB enum values are capitalised ('Vacant', 'Occupied', 'Other')
        $dbStatuses = array_map(fn($s) => ucfirst($s), $wantedStatuses);
        $ph = implode(',', array_fill(0, count($dbStatuses), '?'));
        $where .= " AND g.status IN ($ph)";
        foreach ($dbStatuses as $s) {
            $params[] = $s;
        }

        // When the client asks for 'vacant', exclude graves that are
        // effectively reserved: an Active reservation already references
        // them, either as the incoming occupant's target or as the old
        // occupant's destination.  A "vacant" grave that is about to be
        // occupied is not truly available.
        if (in_array('vacant', $wantedStatuses, true)) {
            $where .= "
                AND NOT EXISTS (
                    SELECT 1 FROM reservations r
                    WHERE r.reservation_state = 'Active'
                      AND (r.target_grave_id = g.grave_id
                           OR r.old_new_grave_id = g.grave_id)
                )
            ";
        }
    }

    if ($searchTerm !== '') {
        $like = '%' . $searchTerm . '%';

        $parts = [
            'g.grave_code LIKE ?',
            'b.block_name LIKE ?',
            'b.block_type LIKE ?',
        ];
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;

        if ($isStaff) {
            $parts[] = 'g.remarks LIKE ?';
            $params[] = $like;

            $parts[] = "EXISTS (
                SELECT 1 FROM interments i2
                WHERE i2.current_grave_id = g.grave_id
                  AND i2.status = 'Active'
                  AND i2.deleted_at IS NULL
                  AND (
                      i2.control_number              LIKE ? OR
                      i2.deceased_name               LIKE ? OR
                      i2.contact_person_name         LIKE ? OR
                      i2.contact_person_phone_number LIKE ? OR
                      i2.contact_person_email        LIKE ?
                  )
            )";
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
        }

        $where .= ' AND (' . implode(' OR ', $parts) . ')';
    }

    // ---- COUNT matching graves -------------------------------------------
    $countSql = "
        SELECT COUNT(*)
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE $where
    ";
    $countStmt = $pdo->prepare($countSql);
    $countStmt->execute($params);
    $totalRecords = (int) $countStmt->fetchColumn();

    $totalPages = (int) ceil($totalRecords / $limit);
    $page       = min($page, max(1, $totalPages));
    $offset     = ($page - 1) * $limit;

    // ---- Step 1: paged grave IDs (stable order) --------------------------
    $idsSql = "
        SELECT g.grave_id
        FROM graves g
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE $where
        ORDER BY g.block_id, g.row_num, g.col_num
        LIMIT $limit OFFSET $offset
    ";
    $idsStmt = $pdo->prepare($idsSql);
    $idsStmt->execute($params);
    $graveIds = $idsStmt->fetchAll(PDO::FETCH_COLUMN);

    // ---- Step 2: fetch full data for those IDs ---------------------------
    $graves = [];
    if (!empty($graveIds)) {
        $placeholders = implode(',', array_fill(0, count($graveIds), '?'));

        if ($isStaff) {
            $sql = "
                SELECT
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status, g.remarks,
                    b.block_id, b.block_name, b.block_type,
                    i.interment_id,
                    i.control_number,
                    i.deceased_name,
                    i.last_known_address,
                    i.date_buried,
                    i.lease_expiration_date,
                    i.contact_person_name,
                    i.contact_person_phone_number,
                    i.contact_person_email,
                    i.contact_person_address
                FROM graves g
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                LEFT JOIN interments i
                    ON g.grave_id = i.current_grave_id
                    AND i.status = 'Active'
                    AND i.deleted_at IS NULL
                WHERE g.grave_id IN ($placeholders)
                ORDER BY g.block_id, g.row_num, g.col_num, i.interment_id
            ";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($graveIds);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $gravesMap = [];
            foreach ($rows as $row) {
                $gid = $row['grave_id'];
                if (!isset($gravesMap[$gid])) {
                    $gravesMap[$gid] = [
                        'grave_id'   => $row['grave_id'],
                        'grave_code' => $row['grave_code'],
                        'row_num'    => $row['row_num'],
                        'col_num'    => $row['col_num'],
                        'status'     => $row['status'],
                        'remarks'    => $row['remarks'],
                        'block_id'   => $row['block_id'],
                        'block_name' => $row['block_name'],
                        'block_type' => $row['block_type'],
                        'occupants'  => [],
                    ];
                }
                if ($row['interment_id']) {
                    $gravesMap[$gid]['occupants'][] = [
                        'interment_id'                => (int) $row['interment_id'],
                        'control_number'              => $row['control_number'],
                        'deceased_name'               => $row['deceased_name'],
                        'last_known_address'          => $row['last_known_address'],
                        'date_buried'                 => $row['date_buried'],
                        'lease_expiration_date'       => $row['lease_expiration_date'],
                        'contact_person_name'         => $row['contact_person_name'],
                        'contact_person_phone_number' => $row['contact_person_phone_number'],
                        'contact_person_email'        => $row['contact_person_email'],
                        'contact_person_address'      => $row['contact_person_address'],
                    ];
                }
            }

            foreach ($graveIds as $gid) {
                if (isset($gravesMap[$gid])) {
                    $graves[] = $gravesMap[$gid];
                }
            }
        } else {
            // Public: no interments, no remarks
            $sql = "
                SELECT
                    g.grave_id, g.grave_code, g.row_num, g.col_num, g.status,
                    b.block_id, b.block_name
                FROM graves g
                LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
                WHERE g.grave_id IN ($placeholders)
                ORDER BY g.block_id, g.row_num, g.col_num
            ";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($graveIds);
            $graves = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
    }

    $payload = [
        'pagination' => [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ],
        'graves' => $graves,
    ];
    if ($searchTerm !== '') {
        $payload['search_term'] = $searchTerm;
    }
    if (!empty($wantedStatuses)) {
        $payload['status'] = implode(',', $wantedStatuses);
    }

    Response::success("Graves retrieved.", $payload);
}

// -----------------------------------------------------------------------------
// Everything below requires Admin or Office
// -----------------------------------------------------------------------------
if (!$isAdminOffice) {
    Response::error("Forbidden. Only Admin and Office can update graves.", 403);
}

// -----------------------------------------------------------------------------
// PUT – Update a single grave's status or remarks
//
// Editable fields:  status, remarks
// NOT editable:     row_num, col_num (owned by blocks.php)
//
// Status rules:
//   Vacant or Other -> blocked if an Active interment is on this grave.
//   Occupied        -> always allowed.
//   Any status change is blocked while an Active reservation targets
//   the grave.  Remarks changes are ALWAYS allowed.
// -----------------------------------------------------------------------------
if ($method === 'PUT') {

    if (!is_numeric($resourceId)) {
        Response::error("Grave ID required.", 400);
    }
    $graveId = (int) $resourceId;

    // ---- Reject edits to fields we don't allow (no DB needed) ------------
    $forbiddenFields = ['row_num', 'col_num', 'grave_code', 'block_id'];
    foreach ($forbiddenFields as $f) {
        if (array_key_exists($f, $rawData)) {
            Response::error(
                "Field '$f' is not editable from graves.php. "
                    . "Coordinates are managed by blocks.php.",
                400
            );
        }
    }

    $statusProvided  = array_key_exists('status', $rawData);
    $remarksProvided = array_key_exists('remarks', $rawData);

    if (!$statusProvided && !$remarksProvided) {
        Response::error("Only 'status' and 'remarks' are editable.", 400);
    }

    $newStatus  = $statusProvided ? trim((string) $rawData['status']) : null;
    $newRemarks = $remarksProvided ? (string) $rawData['remarks'] : null;

    $validStatuses = ['Vacant', 'Occupied', 'Other'];
    if ($statusProvided && !in_array($newStatus, $validStatuses, true)) {
        Response::error(
            "Invalid status. Allowed: " . implode(', ', $validStatuses),
            400
        );
    }

    // ---- Locked transaction ----------------------------------------------
    $pdo->exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    $pdo->beginTransaction();

    try {
        // Lock the grave row. This is the single serialization point:
        //   * concurrent PUTs on the same grave block here;
        //   * blocks.php shrink/delete also locks grave rows with FOR UPDATE,
        //     so a shrink cannot race against a status edit on a grave
        //     that's about to be removed.
        $lockStmt = $pdo->prepare("
            SELECT * FROM graves
            WHERE grave_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $lockStmt->execute([$graveId]);
        $current = $lockStmt->fetch(PDO::FETCH_ASSOC);
        if (!$current) {
            $pdo->rollBack();
            Response::error("Grave not found.", 404);
        }

        $currentStatus  = (string) $current['status'];
        $currentRemarks = $current['remarks'];
        $finalStatus    = $statusProvided ? $newStatus : $currentStatus;
        $finalRemarks   = $remarksProvided ? $newRemarks : $currentRemarks;

        $statusChanged = $statusProvided && $finalStatus !== $currentStatus;

        // ---- Status transition guards ------------------------------------
        if ($statusChanged) {
            // 1) Active reservation locks the grave while it awaits
            //    Confirm/Cancel.
            $activePlanId = findActivePlanOnGrave($pdo, $graveId);
            if ($activePlanId !== null) {
                $pdo->rollBack();
                Response::error(
                    "Cannot change status: an Active reservation (#$activePlanId) is "
                        . "targeting this grave. Confirm or cancel the reservation first.",
                    409
                );
            }

            // 2) Moving to Vacant or Other requires no Active interment.
            if ($finalStatus === 'Vacant' || $finalStatus === 'Other') {
                $activeIntermentId = findActiveInterment($pdo, $graveId);
                if ($activeIntermentId !== null) {
                    $pdo->rollBack();
                    Response::error(
                        "Cannot set status to '$finalStatus': an Active interment "
                            . "(#$activeIntermentId) currently occupies this grave.",
                        409
                    );
                }
            }

            // 'Occupied' is always allowed. Manual occupation is intentional
            // (maintenance, reserved, physical marker, etc.) — use remarks.
        }

        // ---- Build and execute the update --------------------------------
        $updates = [];
        $params  = [];

        if ($statusProvided) {
            $updates[] = "status = ?";
            $params[]  = $finalStatus;
        }
        if ($remarksProvided) {
            $updates[] = "remarks = ?";
            $params[]  = $finalRemarks;
        }

        $updates[] = "updated_by = ?";
        $params[]  = $userData['user_id'];
        $params[]  = $graveId;

        $sql = "UPDATE graves SET " . implode(', ', $updates)
            . " WHERE grave_id = ? AND deleted_at IS NULL";
        $pdo->prepare($sql)->execute($params);

        $pdo->commit();

        $logParts = [];
        if ($statusProvided)  $logParts[] = "status={$finalStatus}";
        if ($remarksProvided) $logParts[] = "remarks updated";
        systemLog(
            "Updated grave ID $graveId (" . implode(', ', $logParts) . ")",
            $userData['user_id']
        );

        Response::success("Grave updated.");
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        failWithDbError($e, 'grave update');
    }
}

// -----------------------------------------------------------------------------
// Method not allowed
// -----------------------------------------------------------------------------
Response::error("Method Not Allowed", 405);
