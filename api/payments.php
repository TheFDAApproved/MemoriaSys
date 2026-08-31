<?php

/**
 * Payment Management Endpoint
 *
 * GET    : List all payments (paginated, role‑filtered) or fetch one by ID
 * POST   : Create a new payment (public, requires image upload)
 * PUT    : Confirm/unconfirm office/grounds, or edit details
 * DELETE : Permanently delete a payment (admin/office only)
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';
require_once 'imagemanager.php';
require_once 'reusable_functions.php';

// -----------------------------------------------------------------------------
// 1. Authentication & Role
// -----------------------------------------------------------------------------
$userData = checkuser(false); // false = allow public clients (returns null)
$role     = $userData['role'] ?? null;

$isAdmin   = ($role === ROLE_ADMIN);
$isOffice  = ($role === ROLE_OFFICE);
$isGrounds = ($role === ROLE_GROUNDS);
$isStaff   = in_array($role, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]);

// -----------------------------------------------------------------------------
// 2. HTTP Method & Routing
// -----------------------------------------------------------------------------
$method = $_SERVER['REQUEST_METHOD'] ?? null;

// Parse path: /payments/{id} or /payments
$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts); // numeric ID or empty

// Merge input sources (JSON + form)
$input = array_merge(
    json_decode(file_get_contents('php://input'), true) ?: [],
    $_POST ?? []
);

$imageManager = new ImageManager();

// -----------------------------------------------------------------------------
// 3. Helper Functions
// -----------------------------------------------------------------------------

/** Require a specific role, else respond with 403 */
function requireRole($allowedRoles, $userRole)
{
    if (!is_array($allowedRoles)) {
        $allowedRoles = [$allowedRoles];
    }
    if (!in_array($userRole, $allowedRoles, true)) {
        Response::error('Forbidden. Insufficient privileges.', 403);
    }
}

/** Format and validate Philippine phone number (assumes formatPhNumber exists) */
function validatePhone($phone)
{
    $formatted = formatPhNumber($phone);
    if (!$formatted) {
        Response::error('Invalid Philippines phone number format.', 400);
    }
    return $formatted;
}

/** Build the base SELECT query for payments, including staff names */
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
            u2.name AS ground_staff_name
        FROM payments p
        LEFT JOIN users u1 ON p.confirmed_office_staff = u1.user_id
        LEFT JOIN users u2 ON p.confirmed_ground_staff = u2.user_id
    ";
}

/** Format a single payment row into a flat structure */
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
    ];
}

// -----------------------------------------------------------------------------
// 4. Handle Each HTTP Method
// -----------------------------------------------------------------------------

try {
    switch ($method) {

        // ---------- GET ----------
        case 'GET':
            // Only staff can view payments
            if (!$isStaff) {
                Response::error('Forbidden. You do not have access to view payment records.', 403);
            }

            // If resourceId is numeric, fetch single record
            if (is_numeric($resourceId)) {
                $sql = getPaymentSelectSQL() . ' WHERE p.payment_id = ? LIMIT 1';
                $stmt = $pdo->prepare($sql);
                $stmt->execute([$resourceId]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    Response::error('Payment not found', 404);
                }
                Response::success('Payment retrieved',  formatPayment($row));
            }

            // ---- List all payments (paginated, role-filtered) ----
            $where = '1=1';
            if ($isGrounds) {
                $where .= ' AND p.confirmed_office_staff IS NOT NULL';
            }

            // Pagination
            $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 100;
            $limit = max(1, min($limit, 500));
            $page  = isset($_GET['page']) ? (int) $_GET['page'] : 1;
            $page  = max(1, $page);

            // Count total
            $countSql = "SELECT COUNT(*) FROM payments p WHERE $where";
            $totalRecords = (int) $pdo->query($countSql)->fetchColumn();
            $totalPages = ceil($totalRecords / $limit);
            $page = min($page, $totalPages ?: 1);
            $offset = ($page - 1) * $limit;

            // -------- FIX: Directly inject the integer values ----------
            // Cast to int for safety (already done, but explicit again)
            $limitInt  = (int) $limit;
            $offsetInt = (int) $offset;
            $sql = getPaymentSelectSQL() . " WHERE $where ORDER BY p.payment_id DESC LIMIT $limitInt OFFSET $offsetInt";
            $stmt = $pdo->prepare($sql);
            $stmt->execute(); // No placeholders to bind
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $payments = array_map('formatPayment', $rows);
            $pagination = [
                'current_page'  => $page,
                'per_page'      => $limit,
                'total_records' => $totalRecords,
                'total_pages'   => $totalPages,
            ];

            Response::success('Payments retrieved', ['pagination' => $pagination, 'payments' => $payments]);
            break;

        // ---------- POST ----------
        case 'POST':
            // Anyone can submit
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

                systemLog("Uploaded payment proof: $refNum", 'Public');
                Response::success('Payment proof submitted successfully. Pending office review.', ['payment_id' => $newId], 201);
            } catch (PDOException $e) {
                if (isset($filename)) {
                    $imageManager->deleteImage($filename);
                }
                if ($e->getCode() == 23000) {
                    Response::error('Conflict: Reference number already exists.', 409);
                }
                systemLog("Payment creation error: " . $e->getMessage(), 'System');
                Response::error('Database error while creating payment.', 500);
            }
            break;

        // ---------- PUT ----------
        case 'PUT':
            if (!is_numeric($resourceId)) {
                Response::error('Payment ID required.', 400);
            }

            $action = $input['action'] ?? 'edit_details';
            $userId = $userData['user_id'];

            switch ($action) {
                case 'confirm_office':
                    requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);
                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET confirmed_office_staff = ?, 
                            remarks_office = COALESCE(?, remarks_office) 
                        WHERE payment_id = ?
                    ");
                    $stmt->execute([$userId, $input['remarks_office'] ?? null, $resourceId]);
                    systemLog($userData['name'] . " confirmed payment receipt for ID: $resourceId", $userId);
                    Response::success('Payment confirmed by Office.');
                    break;

                case 'unconfirm_office':
                    requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);
                    $check = $pdo->prepare("SELECT confirmed_ground_staff FROM payments WHERE payment_id = ?");
                    $check->execute([$resourceId]);
                    if ($check->fetchColumn()) {
                        Response::error('Cannot unconfirm: Grounds staff has already completed work.', 409);
                    }
                    $stmt = $pdo->prepare("UPDATE payments SET confirmed_office_staff = NULL WHERE payment_id = ?");
                    $stmt->execute([$resourceId]);
                    systemLog($userData['name'] . " unconfirmed payment receipt for ID: $resourceId", $userId);
                    Response::success('Payment confirmation reverted.');
                    break;

                case 'confirm_grounds':
                    requireRole([ROLE_ADMIN, ROLE_GROUNDS], $role);
                    $check = $pdo->prepare("SELECT confirmed_office_staff FROM payments WHERE payment_id = ?");
                    $check->execute([$resourceId]);
                    if (!$check->fetchColumn()) {
                        Response::error('Cannot complete ground work: Payment not confirmed by office yet.', 400);
                    }
                    $stmt = $pdo->prepare("
                        UPDATE payments 
                        SET confirmed_ground_staff = ?, 
                            remarks_grounds = COALESCE(?, remarks_grounds) 
                        WHERE payment_id = ?
                    ");
                    $stmt->execute([$userId, $input['remarks_grounds'] ?? null, $resourceId]);
                    systemLog($userData['name'] . " confirmed ground work for ID: $resourceId", $userId);
                    Response::success('Work completion confirmed by Grounds.');
                    break;

                case 'unconfirm_grounds':
                    requireRole([ROLE_ADMIN, ROLE_GROUNDS], $role);
                    $stmt = $pdo->prepare("UPDATE payments SET confirmed_ground_staff = NULL WHERE payment_id = ?");
                    $stmt->execute([$resourceId]);
                    systemLog($userData['name'] . " unconfirmed ground work for ID: $resourceId", $userId);
                    Response::success('Ground work confirmation reverted.');
                    break;

                default: // edit_details
                    requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);
                    $newRef  = $input['reference_number'] ?? null;
                    $newAmt  = $input['amount'] ?? null;
                    $newPurp = $input['purpose'] ?? null;
                    $newDeceased = $input['deceased_name'] ?? null;
                    $newPhone = isset($input['payers_phone_number']) ? validatePhone($input['payers_phone_number']) : null;
                    $newEmail = $input['payers_email'] ?? null;
                    $newPayer = $input['payers_name'] ?? null;
                    $newChannel = $input['payment_channel'] ?? null;
                    $remOff  = $input['remarks_office'] ?? null;
                    $remGrn  = $input['remarks_grounds'] ?? null;

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
                            remarks_office = COALESCE(?, remarks_office),
                            remarks_grounds = COALESCE(?, remarks_grounds)
                        WHERE payment_id = ?
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
                        $remOff,
                        $remGrn,
                        $resourceId
                    ]);
                    systemLog($userData['name'] . " edited payment ID: $resourceId", $userId);
                    Response::success('Payment details updated.');
            }
            break;

        // ---------- DELETE ----------
        case 'DELETE':
            requireRole([ROLE_ADMIN, ROLE_OFFICE], $role);
            if (!is_numeric($resourceId)) {
                Response::error('Payment ID required.', 400);
            }
            $stmt = $pdo->prepare("DELETE FROM payments WHERE payment_id = ?");
            $stmt->execute([$resourceId]);
            if ($stmt->rowCount() === 0) {
                Response::error('Payment not found.', 404);
            }
            systemLog($userData['name'] . " deleted payment ID: $resourceId", $userData['user_id']);
            Response::success('Payment permanently deleted.');
            break;

        default:
            Response::error('Method not allowed', 405);
    }
} catch (PDOException $e) {
    systemLog('Database error in payments endpoint: ' . $e->getMessage(), 'System');
    // For debugging, you can also output the error message, but be careful in production
    Response::error('A database error occurred: ' . $e->getMessage(), 500);
} catch (Exception $e) {
    systemLog('Unexpected error: ' . $e->getMessage(), 'System');
    Response::error('An unexpected error occurred.', 500);
}
