<?php

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';

use Firebase\JWT\JWT;

$userData = checkuser(false);

$method = $_SERVER['REQUEST_METHOD'] ?? null;

if ($method === 'DELETE') {
    if ($userData) {
        $clearStmt = $pdo->prepare("UPDATE users SET session_token = NULL WHERE user_id = :id");
        $clearStmt->execute([':id' => $userData['user_id']]);

        systemLog($userData['name'] . " (" . $userData['username'] . ") logged out", $userData['user_id']);
        setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');
        Response::success("Logged out successfully");
    }
    Response::error("Not logged in", 401);
}

if ($method === 'GET') {
    if (!$userData) Response::error("Not logged in", 401);

    // Return only safe fields – exclude session_token
    $safeUserData = [
        'user_id'      => $userData['user_id'],
        'username'     => $userData['username'],
        'role'         => $userData['role'],
        'status'       => $userData['status'],
        'name'         => $userData['name'],
        'email'        => $userData['email'],
        'phone_number' => $userData['phone_number']
    ];

    Response::success("Logged in", $safeUserData);
}

if ($method !== 'POST') {
    Response::error("Method not allowed", 405);
}

if ($userData) {
    setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');
    Response::error("Already logged in as " . $userData['username'] . ". Try again, I logged you out", 400);
}

// --- HYBRID INPUT PARSER ---
$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

if (empty($rawData['username']) || empty($rawData['password'])) {
    Response::error("Username and password are required", 400);
}

$username = trim($rawData['username']);
$password = $rawData['password'];

try {
    $sql = "SELECT * FROM users WHERE username = :username AND deleted_at IS NULL LIMIT 1";
    $stmt = $pdo->prepare($sql);
    $stmt->bindParam(':username', $username, PDO::PARAM_STR);
    $stmt->execute();
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($user && password_verify($password, $user['password_hash'])) {
        $currentPasswordHash = $user['password_hash'];
        unset($user['password_hash']);

        if ($user['status'] !== STATUS_VERIFIED) {
            Response::error("Your account is not verified yet. Please wait for admin verification.", 403);
        }

        // --- Generate a unique session token ---
        $sessionTokenId = bin2hex(random_bytes(16));

        // --- Gather device metadata ---
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? 'Unknown IP';
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? 'Unknown Device';
        $loginTime = date('M d, Y h:i A');

        // --- Bundle into JSON ---
        $sessionData = json_encode([
            'token' => $sessionTokenId,
            'ip' => $ipAddress,
            'user_agent' => $userAgent,
            'time' => $loginTime
        ]);

        // --- Store in database ---
        $updateStmt = $pdo->prepare("UPDATE users SET session_token = :data WHERE user_id = :id");
        $updateStmt->execute([':data' => $sessionData, ':id' => $user['user_id']]);

        $JWT_SECRET = JWT_SECRET;
        $JWT_ALGO = JWT_ALGO;
        $JWT_EXPIRATION = intval(JWT_EXPIRATION);

        $payload = [
            "iss" => APP_URL,
            "iat" => time(),
            "exp" => time() + $JWT_EXPIRATION,
            "data" => [
                "user_id" => $user['user_id'],
                "username" => $user['username'],
                "role" => $user['role'],
                "status" => $user['status'],
                "name" => $user['name'],
                "email" => $user['email'],
                "phone_number" => $user['phone_number'],
                "session_token" => $sessionTokenId
            ]
        ];

        $jwt = JWT::encode($payload, $JWT_SECRET . $currentPasswordHash, $JWT_ALGO);

        setcookie('auth_token', $jwt, [
            'expires' => time() + $JWT_EXPIRATION,
            'path' => '/',
            'secure' => false,
            'httponly' => true,
            'samesite' => 'Strict'
        ]);

        systemLog($user['name'] . " (" . $user['username'] . ") logged in", $user['user_id']);

        // Return safe user data (exclude session_token)
        $safeUserData = [
            'user_id'      => $user['user_id'],
            'username'     => $user['username'],
            'role'         => $user['role'],
            'status'       => $user['status'],
            'name'         => $user['name'],
            'email'        => $user['email'],
            'phone_number' => $user['phone_number']
        ];

        Response::success("Login successful", $safeUserData);
    } else {
        systemLog("Failed login attempt with username: " . $username, null);
        Response::error("Invalid username and password", 401);
    }
} catch (PDOException $e) {
    error_log($e->getMessage());
    systemLog("Database error during login attempt for username: " . $username . " " . $e->getMessage(), null);
    Response::error("An error occurred while logging in " . $e->getMessage(), 500);
}
