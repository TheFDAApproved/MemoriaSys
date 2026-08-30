<?php 

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'textbee.php';
require_once 'logger.php';


$method = $_SERVER['REQUEST_METHOD'] ?? null;

// --- REST ROUTING: PARSE THE URI ---
// Check our custom .htaccess parameter first, then fallback to standard PATH_INFO
$pathInfo = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

// --- AUTHENTICATION GATEKEEPER ---
$isPublicEndpoint = ($method === 'POST' && ($resourceId === null || $resourceId === 'forgot-password'));
$userData = $isPublicEndpoint ? checkuser(false) : checkuser();

// ==========================================
// 1. GET: RETRIEVE RESOURCES
// ==========================================
if ($method === 'GET') {
   
    // SCENARIO A: GET /users.php/me (Get own profile)
    if ($resourceId === 'me' || (string)$resourceId === (string)$userData['user_id']) {
        $stmt = $pdo->prepare("SELECT user_id, username, email, role, status, phone_number, name FROM users WHERE user_id = :id LIMIT 1");
        $stmt->execute([':id' => $resourceId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        systemLog("{$userData['name']} ({$userData['username']}) retrieved their own profile", $userData['user_id']);
        Response::success("Your profile retrieved", $user);
    }

    // Admin authorization check for remaining GET routes
    if ($userData['role'] !== ROLE_ADMIN) {
        systemLog("{$userData['name']} ({$userData['username']}) attempted to access user records without permission", $userData['user_id']);
        Response::error("Forbidden", 403);
    }

    // SCENARIO B: GET Search
    if (isset($_GET['search']) && trim($_GET['search']) !== '') {
        $searchRaw = trim($_GET['search']);
        if (strlen($searchRaw) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }
        
        $searchTerm = '%' . $searchRaw . '%';
        $sql = "SELECT user_id, username, email, role, status, phone_number, name
                FROM users
                WHERE (
                    username LIKE :search_username 
                    OR email LIKE :search_email 
                    OR name LIKE :search_name 
                    OR phone_number LIKE :search_phone
                )
                ORDER BY user_id DESC LIMIT 11";  // limits to 11 results
                
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            ':search_username' => $searchTerm,
            ':search_email'    => $searchTerm,
            ':search_name'     => $searchTerm,
            ':search_phone'    => str_replace('%09', '%+639', $searchTerm)
        ]);
        
        systemLog("{$userData['name']} ({$userData['username']}) searched users with term: {$searchRaw}", $userData['user_id']);
        
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if ($users) {
            Response::success("Search results retrieved", ["users" => $users, "search_term" => $searchRaw]);
        }
        Response::error("No users found matching the search criteria (" . $searchRaw . ")", 404);
    }

    // SCENARIO C: GET /users.php/{id} (Get specific user)
    if (is_numeric($resourceId)) {
        $stmt = $pdo->prepare("SELECT user_id, username, email, role, status, phone_number, name FROM users WHERE user_id = :id LIMIT 1");
        $stmt->execute([':id' => $resourceId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($user) {
            systemLog("{$userData['name']} ({$userData['username']}) retrieved profile of user ID {$resourceId}", $userData['user_id']);
            Response::success("User retrieved successfully", $user);
        }
        Response::error("User not found", 404);
    }

    // SCENARIO D: GET /users.php (List all users)
    if ($resourceId === null) {
        $limit = 20; // limits to 20 users only per request or page
        
        $totalUsers = (int) $pdo->query("SELECT COUNT(*) FROM users")->fetchColumn();
        $totalPages = max(1, (int)ceil($totalUsers / $limit));
        
        $page = max(1, min((int)($_GET['page'] ?? 1), $totalPages));
        $offset = ($page - 1) * $limit;

        $stmt = $pdo->prepare("SELECT user_id, username, email, role, status, phone_number, name FROM users ORDER BY user_id DESC LIMIT :limit OFFSET :offset");
        $stmt->bindParam(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindParam(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        
        systemLog("{$userData['name']} ({$userData['username']}) retrieved user list (Page $page)", $userData['user_id']);
        
        Response::success("Users retrieved successfully", [
            "users" => $stmt->fetchAll(PDO::FETCH_ASSOC),
            "pagination" => ["current_page" => $page, "per_page" => $limit, "total_users" => $totalUsers, "total_pages" => $totalPages]
        ]);
    }
    
    Response::error("User not found", 404);
}

// --- HYBRID INPUT PARSER ---
$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

// ==========================================
// 2. POST: CREATE RESOURCES
// ==========================================
if ($method === 'POST') {

    if ($userData) {
        systemLog("{$userData['name']} ({$userData['username']}) attempted to access a public POST route while logged in", $userData['user_id']);
        Response::error("Forbidden: You are already logged in.", 403);
    }

    // Public POST routes are intentionally unauthenticated: register and forgot-password.
    // The one-time auth check above only prevents a verified logged-in user from hitting them.
    $email = trim($rawData['email'] ?? '');
    $username = trim($rawData['username'] ?? '');
    $name = trim($rawData['name'] ?? '');
    $phone_number = formatPhNumber(trim($rawData['phone_number'] ?? ''));
    $password = $rawData['password'] ?? '';
        
    // --- VALIDATION ---
    if (empty($username) || !preg_match('/^[a-zA-Z0-9_]{3,20}$/', $username)) {
        Response::error("Username must be 3-20 characters long and contain only letters, numbers, and underscores.", 400);
    }
    if (empty($email) || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        Response::error("Invalid email format.", 400);
    }
    if (empty($name) || !preg_match('/^[a-zA-Z\s.\'-]{2,100}$/', $name)) {
        Response::error("Full name contains invalid characters and must be between 2 and 100 characters long.", 400);
    }
    if (!$phone_number) {
        Response::error("Invalid Philippines phone number format.", 400);
    }
    if (empty($password) || !preg_match('/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{6,}$/', $password)) {
        Response::error("Password must be at least 6 characters and includes an uppercase, lowercase, and a number.", 400);
    }

    systemLog("Public POST request to " . ($resourceId ?? 'users.php') . " with email: $email and username: $username", null);
    $hashedPassword = password_hash($password, PASSWORD_DEFAULT);

    // SCENARIO A: POST /users.php/forgot-password
    if ($resourceId === 'forgot-password') {
        $stmt = $pdo->prepare("UPDATE users SET password_hash = :hash, status = :status, updated_at = NOW() WHERE email = :email AND username = :username AND name = :name AND phone_number = :phone_number AND role != :admin_role AND deleted_at is NULL");
        $stmt->execute([
            ':hash' => $hashedPassword, ':status' => STATUS_UNVERIFIED, ':email' => $email, 
            ':username' => $username, ':name' => $name, ':phone_number' => $phone_number, ':admin_role' => ROLE_ADMIN
        ]);

        if ($stmt->rowCount() > 0) {
            systemLog("Password reset successful for: $email $username $name", null);
            Response::success("Password changed successfully. Your account is now Unverified. Please wait for admin verification.", null);
        }
        systemLog("Failed password reset attempt for: $email $username", null);
        Response::error("Not Found: Could not reset password for those credentials. Make sure all details are correct.", 404);
    }
    
    // SCENARIO B: POST /users.php (Register New User)
    // Default Role: ROLE_GROUNDS Default Status: STATUS_UNVERIFIED
    elseif ($resourceId === null) {
        try {
            $stmt = $pdo->prepare("INSERT INTO users (username, email, name, phone_number, password_hash, role, status) VALUES (:username, :email, :name, :phone_number, :hash, :role, :status)");
            $stmt->execute([
                ':username' => $username, ':email' => $email, ':name' => $name, 
                ':phone_number' => $phone_number, ':hash' => $hashedPassword, 
                ':role' => ROLE_GROUNDS, ':status' => STATUS_UNVERIFIED
            ]);
            
            systemLog("New user registered: $username ($email)", null);
            Response::success("Registration successful! Your account is Unverified. Please wait for admin verification.", null, 201); 
        } catch (PDOException $e) {
            if ($e->getCode() == 23000) {
                systemLog("Registration failed due to duplicate entry: $username ($email) or phone number: $phone_number", null);
                Response::error("Conflict: The username, phone number, or email is already registered.", 409);
            }
            error_log($e->getMessage());
            Response::error("Database error: Could not create user. " . $e->getMessage(), 500);
        }
    } 
    
    Response::error("Endpoint not found", 404);
}

// ==========================================
// 3. DELETE: REMOVE RESOURCES
// ==========================================
if ($method === 'DELETE') {
    
    if ($userData['role'] !== ROLE_ADMIN) {
        Response::error("Forbidden: Only administrators can perform user deletions", 403);
    }
    if (!is_numeric($resourceId) || $resourceId <= 0) {
        Response::error("Bad Request: Invalid or missing user ID in URL path", 400);
    }
    if ($userData['user_id'] === (int)$resourceId) {
        Response::error("Forbidden: You cannot delete your own account. At least for now", 403);
    }

    try {
       $stmt = $pdo->prepare("
            DELETE FROM users WHERE user_id = :id;
        ");

        $stmt->execute([
            ':id' => (int)$resourceId, 
        ]);
        
        if ($stmt->rowCount() > 0) {
            systemLog("{$userData['name']} deleted user with ID $resourceId", $userData['user_id']);
            Response::success("User successfully deleted");
        }
        Response::error("Not Found: User does not exist", 404);
    } catch (PDOException $e) {
        error_log($e->getMessage());
        Response::error("Database error: Could not delete user. " . $e->getMessage(), 500);
    }
}

// ==========================================
// 4. PUT: UPDATE RESOURCES
// ==========================================
if ($method === 'PUT') {
    
    if (!is_numeric($resourceId) || $resourceId <= 0) {
        Response::error("Bad Request: Invalid or missing user ID in URL path", 400);
    }

    $stmt = $pdo->prepare("SELECT user_id, username, email, role, status, phone_number, name FROM users WHERE user_id = :id LIMIT 1");
    $stmt->execute([':id' => $resourceId]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        Response::error("User not found", 404);
    }

    $targetId = (int)$resourceId;
    $updateFields = [];
    $queryParams = [];
    $isVerifying = false;

    $isSelf = ($userData['user_id'] === $targetId);
    $isAdmin = ($userData['role'] === ROLE_ADMIN);

    // Ensure the requester has authorization to edit this account
    if (!$isSelf && !$isAdmin) {
        Response::error("Forbidden: You do not have permission to edit this user", 403);
    }

    // --- STRICT ROLE & STATUS GATEKEEPER ---
    if (isset($rawData['role']) || isset($rawData['status'])) {
        if (!$isAdmin) {
            Response::error("Forbidden: Only administrators can change roles and statuses", 403);
        }
        if ($isSelf) {
            Response::error("Forbidden: You cannot change your own role or status", 403);
        }
    }

    // --- STANDARD FIELD VALIDATIONS (Allowed for Self AND Admin) ---
    if (!empty($rawData['name'])) {
        if (!preg_match('/^[a-zA-Z\s.\'-]{2,100}$/', $rawData['name'])) Response::error("Invalid full name format.", 400);
        $updateFields[] = "name = :name"; $queryParams[':name'] = trim($rawData['name']);
    }
    if (!empty($rawData['username'])) {
        if (!preg_match('/^[a-zA-Z0-9_]{3,20}$/', $rawData['username'])) Response::error("Invalid username format.", 400);
        $updateFields[] = "username = :username"; $queryParams[':username'] = trim($rawData['username']);
    }
    if (!empty($rawData['phone_number'])) {
        $phone = formatPhNumber($rawData['phone_number']);
        if (!$phone) Response::error("Invalid Philippines phone number format.", 400);
        $updateFields[] = "phone_number = :phone"; $queryParams[':phone'] = $phone;
    }
    if (!empty($rawData['email'])) {
        if (!filter_var($rawData['email'], FILTER_VALIDATE_EMAIL)) Response::error("Invalid email format.", 400);
        $updateFields[] = "email = :email"; $queryParams[':email'] = trim($rawData['email']);
    }
    if (!empty($rawData['password'])) {
        if (!preg_match('/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{6,}$/', $rawData['password'])) Response::error("Password must be at least 6 characters and includes an uppercase, lowercase, and a number.", 400);
        $updateFields[] = "password_hash = :password_hash"; $queryParams[':password_hash'] = password_hash($rawData['password'], PASSWORD_DEFAULT);
    }

    // --- ADMIN-ONLY FIELD VALIDATIONS ---
    // At this point, we already know it's not a self-edit if role/status are set.
    if ($isAdmin) {
        if (!empty($rawData['role'])) {
            if (!in_array($rawData['role'], ALLOWED_ROLES, true)) Response::error("Invalid role value.", 400);
            $updateFields[] = "role = :role"; $queryParams[':role'] = $rawData['role'];
        }
        if (!empty($rawData['status'])) {
            if (!in_array($rawData['status'], ALLOWED_STATUSES, true)) Response::error("Invalid status value.", 400);
            $updateFields[] = "status = :status"; $queryParams[':status'] = $rawData['status'];

            if ($rawData['status'] === STATUS_VERIFIED) {
                $isVerifying = true;
            }
        }
    }

    if (empty($updateFields)) {
        Response::error("Bad Request: No valid fields provided to update", 400);
    }
    $queryParams[':id'] = $targetId;
    try {
        $stmt = $pdo->prepare("UPDATE users SET " . implode(", ", $updateFields) . " WHERE user_id = :id");
        $stmt->execute($queryParams);
        if($stmt->rowCount() === 0) Response::success("Looks like nothing has changed.");
        // Send Verification SMS if a user was newly verified
        if ($isVerifying) {
            $stmt = $pdo->prepare("SELECT phone_number, name FROM users WHERE user_id = :id LIMIT 1");
            $stmt->execute([':id' => $targetId]);
            $targetUser = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if ($targetUser && !empty($targetUser['phone_number'])) {
                $smsStatus = sendSmsViaTextBee($targetUser['phone_number'], "Hello {$targetUser['name']}, your Memoria account has been Verified by an Administrator. You can now log-in to the system.", true);
                if (!$smsStatus['success']) {
                    systemLog("Failed to send verification SMS to User ID {$targetId}. Error: {$smsStatus['error']}", $userData['user_id']);
                    echo json_encode(["success" => true, "sms_failed" => true, "message" => "Saved changes, but failed to send SMS: " . $smsStatus['error']]);
                    exit; 
                }
            }
        }
        
        systemLog("{$userData['name']} updated user with ID $targetId", $userData['user_id']);
        
        Response::success("User updated successfully");
        
    } catch (PDOException $e) {
        if ($e->getCode() == 23000) Response::error("Conflict: Email or Username is already in use", 409);
        error_log($e->getMessage());
        Response::error("Database error: Could not update user" . $e->getMessage(), 500);
    }
}

// --- FALLBACK ---
Response::error("Method Not Allowed", 405);
?>