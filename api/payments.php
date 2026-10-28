<?php

// Payment management endpoint
// GET lists payments or fetches one, POST creates a new payment (public), PUT edits/confirms, DELETE soft-deletes (admin only)
// Admin still follows office-then-grounds order even though it can do both
// Office only touches office side, grounds only touches grounds side, payer remarks are read-only here
// Confirms and deletes are single atomic UPDATEs; the WHERE clause is the precondition, rowCount()==0 means the race was lost
// The post-mortem SELECT after rowCount()==0 is only for a nicer error message, never for correctness

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';
require_once 'imagemanager.php';
require_once 'reusable_functions.php';

$userData = checkuser(false); // false = allow public clients (returns null)
$role     = $userData['role'] ?? null;

$isAdmin   = ($role === ROLE_ADMIN);
$isOffice  = ($role === ROLE_OFFICE);
$isGrounds = ($role === ROLE_GROUNDS);
$isStaff   = in_array($role, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]);

$method = $_SERVER['REQUEST_METHOD'] ?? null;

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$input = array_merge(
    json_decode(file_get_contents('php://input'), true) ?: [],
    $_POST ?? []
);

$imageManager = new ImageManager();

// Stop the request with 403 unless the role is in the allowed list
function requireRole($allowedRoles, $userRole)
{
    if (!is_array($allowedRoles)) {
        $allowedRoles = [$allowedRoles];
    }
    if (!in_array($userRole, $allowedRoles, true)) {
        Response::error('Forbidden. Insufficient privileges.', 403);
    }
}

// Return the shared SELECT used by the list and single-payment queries
function getPaymentSelectSQL()
{
    return "
        SELECT 
            p.payment_id,
            p.reference_number,
            p.payment_channel,
            p.amount,
            p.purpose,
            p.deceased_name,
            p.payers_phone_number,
            p.payers_email,
            p.payers_name,
            p.image_link,
            p.remarks_payer,
            p.remarks_office,
            p.remarks_grounds,
            p.confirmed_office_staff,
            u1.name AS office_staff_name,
            p.confirmed_ground_staff,
            u2.name AS ground_staff_name,
            p.created_at,
            p.updated_at
        FROM payments p
        LEFT JOIN users u1 ON p.confirmed_office_staff = u1.user_id
        LEFT JOIN users u2 ON p.confirmed_ground_staff = u2.user_id
    ";
}

// Shape a DB row into the JSON structure the client expects
function formatPayment($row)
{
    $status = 'Pending Office';
    if ($row['confirmed_office_staff'] && !$row['confirmed_ground_staff']) {
        $status = 'Pending Grounds';
    } elseif ($row['confirmed_office_staff'] && $row['confirmed_ground_staff']) {
        $status = 'Completed';
    }

    return [
        'payment_id'            => (int) $row['payment_id'],
        'reference_number'      => $row['reference_number'],
        'payment_channel'       => $row['payment_channel'],
        'amount'                => (float) $row['amount'],
        'purpose'               => $row['purpose'],
        'deceased_name'         => $row['deceased_name'],
        'payers_phone_number'   => $row['payers_phone_number'],
        'payers_email'          => $row['payers_email'],
        'payers_name'           => $row['payers_name'],
        'image_link'            => $row['image_link'],
        'remarks_payer'         => $row['remarks_payer'],
        'remarks_office'        => $row['remarks_office'],
        'remarks_grounds'       => $row['remarks_grounds'],
        'overall_status'        => $status,
        'office_confirmed'      => (bool) $row['confirmed_office_staff'],
        'office_staff_id'       => $row['confirmed_office_staff'],
        'office_staff_name'     => $row['office_staff_name'],
        'grounds_confirmed'     => (bool) $row['confirmed_ground_staff'],
        'grounds_staff_id'      => $row['confirmed_ground_staff'],
        'grounds_staff_name'    => $row['ground_staff_name'],
        'created_at'            => $row['created_at'],
        'updated_at'            => $row['updated_at']
    ];
}

// Return the current confirm flags for a payment, or false if missing/deleted
// Only used to build error messages after a failed UPDATE, never to decide what's allowed
function getPaymentConfirmationState($pdo, $paymentId)
{
    $stmt = $pdo->prepare("
        SELECT confirmed_office_staff, confirmed_ground_staff
        FROM payments
        WHERE payment_id = ? AND deleted_at IS NULL
    ");
    $stmt->execute([$paymentId]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

try {
    switch ($method) {

        case 'GET':
            if (!$isStaff) {
                Response::error('Forbidden. You do not have access to view payment records.', 403);
            }

            if (is_numeric($resourceId)) {
                $sql = getPaymentSelectSQL() . ' WHERE p.payment_id = ? AND p.deleted_at IS NULL LIMIT 1';
                $stmt = $pdo->prepare($sql);
                $stmt->execute([$resourceId]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    Response::error('Payment not found', 404);
                }
                Response::success('Payment retrieved', formatPayment($row));
            }

            $searchTerm = isset($_GET['search_term']) ? trim((string) $_GET['search_term']) : '';
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
            $allowedStatuses = ['pending_office', 'pending_grounds', 'verified'];
            $wantedStatuses  = [];

            if ($statusFilter !== '') {
                foreach (explode(',', $statusFilter) as $s) {
                    $s = trim($s);
                    if (!in_array($s, $allowedStatuses, true)) {
                        Response::error("Invalid status '$s'. Allowed: pending_office, pending_grounds, verified.", 400);
                    }
                    if (!in_array($s, $wantedStatuses, true)) {
                        $wantedStatuses[] = $s;
                    }
                }
            }

            $where  = 'p.deleted_at IS NULL';
            $params = [];

            if (!empty($wantedStatuses)) {
                $statusParts = [];
                foreach ($wantedStatuses as $s) {
                    if ($s === 'pending_office') {
                        $statusParts[] = '(p.confirmed_office_staff IS NULL)';
                    } elseif ($s === 'pending_grounds') {
                        $statusParts[] = '(p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NULL)';
                    } elseif ($s === 'verified') {
                        $statusParts[] = '(p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NOT NULL)';
                    }
                }
                $where .= ' AND (' . implode(' OR ', $statusParts) . ')';
            }

            if ($searchTerm !== '') {
                $like = '%' . $searchTerm . '%';
                $searchCols = [
                    'p.reference_number',
                    'p.payment_channel',
                    'p.purpose',
                    'p.deceased_name',
                    'p.payers_phone_number',
                    'p.payers_email',
                    'p.payers_name',
                    'p.remarks_payer',
                    'p.remarks_office',
                    'p.remarks_grounds',
                    'u1.name',
                    'u2.name',
                ];
                $parts = [];
                foreach ($searchCols as $c) {
                    $parts[] = "$c LIKE ?";
                    $params[] = $like;
                }

                // Also match date-shaped search terms against created_at
                // convert_dates() only returns criteria when the term actually looks like a date, so plain text costs nothing extra
                // DATE()/MONTH()/DAY()/YEAR() skip indexes, but LIKE '%...%' already forced a scan, so it doesn't matter here
                $dateCriteria = convert_dates($searchTerm);

                foreach ($dateCriteria['exact_dates'] as $d) {
                    $parts[]  = '(DATE(p.created_at) = ? OR DATE(p.updated_at) = ?)';
                    $params[] = $d;
                    $params[] = $d;
                }
                foreach ($dateCriteria['month_days'] as $md) {
                    $parts[]  = '((MONTH(p.created_at) = ? AND DAY(p.created_at) = ?) OR (MONTH(p.updated_at) = ? AND DAY(p.updated_at) = ?))';
                    $params[] = $md['m'];
                    $params[] = $md['d'];
                    $params[] = $md['m'];
                    $params[] = $md['d'];
                }
                foreach ($dateCriteria['year_months'] as $ym) {
                    $parts[]  = '((YEAR(p.created_at) = ? AND MONTH(p.created_at) = ?) OR (YEAR(p.updated_at) = ? AND MONTH(p.updated_at) = ?))';
                    $params[] = $ym['y'];
                    $params[] = $ym['m'];
                    $params[] = $ym['y'];
                    $params[] = $ym['m'];
                }
                foreach ($dateCriteria['years'] as $y) {
                    $parts[]  = '(YEAR(p.created_at) = ? OR YEAR(p.updated_at) = ?)';
                    $params[] = $y;
                    $params[] = $y;
                }

                $where .= ' AND (' . implode(' OR ', $parts) . ')';
            }

            $countSql = "
                SELECT COUNT(*)
                FROM payments p
                LEFT JOIN users u1 ON p.confirmed_office_staff = u1.user_id
                LEFT JOIN users u2 ON p.confirmed_ground_staff = u2.user_id
                WHERE $where
            ";
            $countStmt = $pdo->prepare($countSql);
            $countStmt->execute($params);
            $totalRecords = (int) $countStmt->fetchColumn();

            $totalPages = (int) ceil($totalRecords / $limit);
            $page       = min($page, max(1, $totalPages));
            $offset     = ($page - 1) * $limit;

            // Pending items float to the top so staff see work that needs action first
            $orderSql = "
                ORDER BY
                    CASE
                        WHEN p.confirmed_office_staff IS NULL THEN 0
                        WHEN p.confirmed_ground_staff IS NULL THEN 1
                        ELSE 2
                    END ASC,
                    p.payment_id DESC
            ";

            $sql = getPaymentSelectSQL() . " WHERE $where $orderSql LIMIT $limit OFFSET $offset";
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $payments = array_map('formatPayment', $rows);

            $pagination = [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ];

            $payload = [
                'pagination' => $pagination,
                'payments'   => $payments,
            ];
            if ($searchTerm !== '') {
                $payload['search_term'] = $searchTerm;
            }
            if (!empty($wantedStatuses)) {
                $payload['status'] = implode(',', $wantedStatuses);
            }

            Response::success('Payments retrieved', $payload);
            break;

        case 'POST':
            $required = [
                'reference_number',
                'payment_channel',
                'amount',
                'purpose',
                'deceased_name',
                'payers_phone_number',
                'payers_email',
                'payers_name'
            ];
            foreach ($required as $field) {
                if (empty($input[$field])) {
                    Response::error("Field '$field' is required.", 400);
                }
            }

            $refNum     = trim($input['reference_number']);
            $channel    = trim($input['payment_channel']);
            $amount     = (float) $input['amount'];
            $purpose    = trim($input['purpose']);
            $deceased   = trim($input['deceased_name']);
            $payersName = trim($input['payers_name']);
            $email      = trim($input['payers_email']);
            $phone      = validatePhone(trim($input['payers_phone_number']));
            $remarks    = trim($input['remarks_payer'] ?? '');

            if ($amount <= 0) {
                Response::error('Amount must be greater than zero.', 400);
            }

            if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) {
                Response::error('No valid image file included.', 400);
            }

            $requestedName = $refNum . '_imagepayments_' . trim($_POST['filename'] ?? '');
            $uploadResult = $imageManager->uploadImage(
                $_FILES['image']['tmp_name'],
                $_FILES['image']['name'],
                $requestedName
            );
            if (!$uploadResult['success']) {
                Response::error($uploadResult['error'], $uploadResult['status_code'] ?? 400);
            }

            $imageLink = $uploadResult['url'];
            $filename  = $uploadResult['filename'];

            // Only the INSERT is wrapped, so a failing systemLog or Response won't delete the image after the row commits
            // ImageManager gives every upload a unique filename, so a losing POST cleans up only its own file
            $newId = null;
            try {
                $stmt = $pdo->prepare("
                    INSERT INTO payments 
                        (reference_number, payment_channel, amount, purpose,
                         deceased_name, payers_phone_number, payers_email, payers_name,
                         image_link, remarks_payer) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ");
                $stmt->execute([
                    $refNum,
                    $channel,
                    $amount,
                    $purpose,
                    $deceased,
                    $phone,
                    $email,
                    $payersName,
                    $imageLink,
                    $remarks
                ]);
                $newId = $pdo->lastInsertId();
            } catch (PDOException $e) {
                $cleanup = $imageManager->deleteImage($filename);
                if (empty($cleanup['success'])) {
                    // Request is already failing, so just log so we can sweep orphaned images later
                    systemLog(
                        "Orphaned image cleanup failed for $filename: "
                            . ($cleanup['error'] ?? 'unknown'),
                        'System'
                    );
                }
                if ($e->getCode() == 23000) {
                    Response::error('Conflict: Reference number already exists and is submitted. Please contact the office to verify your reference number', 409);
                }
                systemLog("Payment creation error: " . $e->getMessage(), 'System');
                Response::error('Database error while creating payment.', 500);
            }

            systemLog("Uploaded payment proof: $refNum", 'Public');
            Response::success('Payment proof submitted successfully. Pending office review.', ['payment_id' => $newId], 201);
            break;

        case 'PUT':
            if (!is_numeric($resourceId)) {
                Response::error('Payment ID required.', 400);
            }

            $action = $input['action'] ?? 'edit_details';
            $userId = $userData['user_id'];

            $existsStmt = $pdo->prepare("SELECT 1 FROM payments WHERE payment_id = ? AND deleted_at IS NULL");
            $existsStmt->execute([$resourceId]);
            if (!$existsStmt->fetch()) {
                Response::error('Payment not found or already deleted.', 404);
            }

            switch ($action) {

                case 'confirm_office':
                    requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);

                    // Atomic: the "confirmed_office_staff IS NULL" guard means only the first caller wins
                    // A second tap gets a 409 instead of silently rewriting and double-logging
                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET confirmed_office_staff = ?, 
                            remarks_office = COALESCE(?, remarks_office),
                            updated_by = ?
                        WHERE payment_id = ? 
                          AND deleted_at IS NULL
                          AND confirmed_office_staff IS NULL
                    ");
                    $stmt->execute([$userId, $input['remarks_office'] ?? null, $userId, $resourceId]);

                    if ($stmt->rowCount() === 0) {
                        // Post-mortem only, for a helpful error message
                        $state = getPaymentConfirmationState($pdo, $resourceId);
                        if (!$state) {
                            Response::error('Payment not found or already deleted.', 404);
                        }
                        if (!empty($state['confirmed_office_staff'])) {
                            Response::error('Payment is already confirmed by office.', 409);
                        }
                        Response::error('Could not confirm payment. Please retry.', 409);
                    }

                    systemLog($userData['name'] . " confirmed payment receipt for ID: $resourceId", $userId);
                    Response::success('Payment confirmed by Office.');
                    break;

                case 'unconfirm_office':
                    requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);

                    // Atomic: both guards are in the WHERE
                    // Grounds not yet done AND office currently set
                    // Even admin must unconfirm grounds first
                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET confirmed_office_staff = NULL,
                            updated_by = ?
                        WHERE payment_id = ? 
                          AND deleted_at IS NULL
                          AND confirmed_office_staff IS NOT NULL
                          AND confirmed_ground_staff IS NULL
                    ");
                    $stmt->execute([$userId, $resourceId]);

                    if ($stmt->rowCount() === 0) {
                        $state = getPaymentConfirmationState($pdo, $resourceId);
                        if (!$state) {
                            Response::error('Payment not found or already deleted.', 404);
                        }
                        if (!empty($state['confirmed_ground_staff'])) {
                            Response::error(
                                'Cannot unconfirm office: grounds staff has already completed work. Unconfirm grounds first.',
                                409
                            );
                        }
                        if (empty($state['confirmed_office_staff'])) {
                            Response::error('Payment is not currently confirmed by office.', 409);
                        }
                        Response::error('Could not revert payment confirmation. Please retry.', 409);
                    }

                    systemLog($userData['name'] . " unconfirmed payment receipt for ID: $resourceId", $userId);
                    Response::success('Payment confirmation reverted.');
                    break;

                case 'confirm_grounds':
                    requireRole([ROLE_ADMIN, ROLE_GROUNDS], $role);

                    // Atomic: the "office IS NOT NULL" guard enforces office-then-grounds even under simultaneous taps
                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET confirmed_ground_staff = ?, 
                            remarks_grounds = COALESCE(?, remarks_grounds),
                            updated_by = ?
                        WHERE payment_id = ? 
                          AND deleted_at IS NULL
                          AND confirmed_office_staff IS NOT NULL
                          AND confirmed_ground_staff IS NULL
                    ");
                    $stmt->execute([$userId, $input['remarks_grounds'] ?? null, $userId, $resourceId]);

                    if ($stmt->rowCount() === 0) {
                        $state = getPaymentConfirmationState($pdo, $resourceId);
                        if (!$state) {
                            Response::error('Payment not found or already deleted.', 404);
                        }
                        if (empty($state['confirmed_office_staff'])) {
                            Response::error(
                                'Cannot complete ground work: Payment not confirmed by office yet. Confirm office first.',
                                400
                            );
                        }
                        if (!empty($state['confirmed_ground_staff'])) {
                            Response::error('Ground work is already confirmed.', 409);
                        }
                        Response::error('Could not confirm ground work. Please retry.', 409);
                    }

                    systemLog($userData['name'] . " confirmed ground work for ID: $resourceId", $userId);
                    Response::success('Work completion confirmed by Grounds.');
                    break;

                case 'unconfirm_grounds':
                    requireRole([ROLE_ADMIN, ROLE_GROUNDS], $role);

                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET confirmed_ground_staff = NULL,
                            updated_by = ?
                        WHERE payment_id = ? 
                          AND deleted_at IS NULL
                          AND confirmed_ground_staff IS NOT NULL
                    ");
                    $stmt->execute([$userId, $resourceId]);

                    if ($stmt->rowCount() === 0) {
                        $state = getPaymentConfirmationState($pdo, $resourceId);
                        if (!$state) {
                            Response::error('Payment not found or already deleted.', 404);
                        }
                        if (empty($state['confirmed_ground_staff'])) {
                            Response::error('Ground work is not currently confirmed.', 409);
                        }
                        Response::error('Could not revert ground work confirmation. Please retry.', 409);
                    }

                    systemLog($userData['name'] . " unconfirmed ground work for ID: $resourceId", $userId);
                    Response::success('Ground work confirmation reverted.');
                    break;

                case 'edit_remark':
                    $remarkType = strtolower(trim((string) ($input['remark_type'] ?? '')));

                    $columnMap = [
                        'office'  => 'remarks_office',
                        'grounds' => 'remarks_grounds',
                        'admin'   => 'remarks_admin',
                    ];

                    if ($remarkType === 'payer') {
                        Response::error('Payer remarks are read-only.', 403);
                    }
                    if (!isset($columnMap[$remarkType])) {
                        Response::error('Invalid remark type.', 400);
                    }

                    if ($remarkType === 'office') {
                        requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);
                    } elseif ($remarkType === 'grounds') {
                        requireRole([ROLE_ADMIN, ROLE_GROUNDS], $role);
                    } elseif ($remarkType === 'admin') {
                        requireRole([ROLE_ADMIN], $role);
                    }

                    $value = trim((string) ($input['remark_value'] ?? ''));
                    if (mb_strlen($value) > 2000) {
                        Response::error('Remark is too long (max 2000 characters).', 400);
                    }

                    $dbValue = ($value === '') ? null : $value;
                    $column  = $columnMap[$remarkType];

                    $stmt = $pdo->prepare("
                        UPDATE payments
                        SET `$column` = ?, updated_by = ?
                        WHERE payment_id = ? AND deleted_at IS NULL
                    ");
                    $stmt->execute([$dbValue, $userId, $resourceId]);

                    systemLog(
                        $userData['name'] . " updated {$remarkType} remark for payment ID: $resourceId",
                        $userId
                    );

                    Response::success(
                        ucfirst($remarkType) . ' remark updated.',
                        [
                            'payment_id'   => (int) $resourceId,
                            'remark_type'  => $remarkType,
                            'remark_value' => $value,
                        ]
                    );
                    break;

                case 'edit_details':
                default:
                    requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);

                    $newRef      = $input['reference_number'] ?? null;
                    $newAmt      = $input['amount'] ?? null;
                    $newPurp     = $input['purpose'] ?? null;
                    $newDeceased = $input['deceased_name'] ?? null;
                    $newPhone    = isset($input['payers_phone_number'])
                        ? validatePhone($input['payers_phone_number'])
                        : null;
                    $newEmail    = $input['payers_email'] ?? null;
                    $newPayer    = $input['payers_name'] ?? null;
                    $newChannel  = $input['payment_channel'] ?? null;

                    // COALESCE(?, column) skips any field the client sent as null, so concurrent editors touching different fields don't clobber each other
                    // Remarks are not editable here, they go through edit_remark so the per-role rules still apply
                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET 
                            reference_number = COALESCE(?, reference_number),
                            payment_channel = COALESCE(?, payment_channel),
                            amount = COALESCE(?, amount),
                            purpose = COALESCE(?, purpose),
                            deceased_name = COALESCE(?, deceased_name),
                            payers_phone_number = COALESCE(?, payers_phone_number),
                            payers_email = COALESCE(?, payers_email),
                            payers_name = COALESCE(?, payers_name),
                            updated_by = ?
                        WHERE payment_id = ? AND deleted_at IS NULL
                    ");
                    $stmt->execute([
                        $newRef,
                        $newChannel,
                        $newAmt,
                        $newPurp,
                        $newDeceased,
                        $newPhone,
                        $newEmail,
                        $newPayer,
                        $userId,
                        $resourceId
                    ]);
                    systemLog($userData['name'] . " edited payment ID: $resourceId", $userId);
                    Response::success('Payment details updated.');
            }
            break;

        case 'DELETE':
            requireRole([ROLE_ADMIN], $role);

            if (!is_numeric($resourceId)) {
                Response::error('Payment ID required.', 400);
            }

            // Atomic: the deleted_at IS NULL guard means a second concurrent delete gets rowCount()==0 and a clean 404
            $stmt = $pdo->prepare("
                UPDATE payments 
                SET deleted_at = NOW(), updated_by = ? 
                WHERE payment_id = ? AND deleted_at IS NULL
            ");
            $stmt->execute([$userData['user_id'], $resourceId]);
            if ($stmt->rowCount() === 0) {
                Response::error('Payment not found or already deleted.', 404);
            }
            systemLog($userData['name'] . " soft‑deleted payment ID: $resourceId", $userData['user_id']);
            Response::success('Payment deleted successfully.');
            break;

        default:
            Response::error('Method not allowed', 405);
    }
} catch (PDOException $e) {
    systemLog('Database error in payments endpoint: ' . $e->getMessage(), 'System');
    Response::error('A database error occurred: ' . $e->getMessage(), 500);
} catch (Exception $e) {
    systemLog('Unexpected error: ' . $e->getMessage(), 'System');
    Response::error('An unexpected error occurred.', 500);
}
