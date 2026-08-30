<?php
require_once 'database.php';

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

function checkuser($force_exit = true)
{
    global $pdo;
    $jwt = null;

    // 1. FIRST: Check for Authorization Header
    $authHeader = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $authHeader = trim($_SERVER['HTTP_AUTHORIZATION']);
    } elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authHeader = trim($_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
    }

    if (preg_match('/Bearer\s(\S+)/', $authHeader, $matches)) {
        $jwt = $matches[1];
    }
    // 2. SECOND: Fallback to checking the HttpOnly Cookie
    else if (isset($_COOKIE['auth_token'])) {
        $jwt = $_COOKIE['auth_token'];
    }

    // 3. Reject if no token
    if (!$jwt) {
        if ($force_exit) {
            Response::error("Not logged in", 401);
        }
        return false;
    }

    // 4. Verify and decode the JWT
    try {
        // --- NEW: Manually read the payload to get the user_id BEFORE verification ---
        $jwtParts = explode('.', $jwt);
        if (count($jwtParts) !== 3) {
            throw new Exception("Malformed token");
        }

        // Base64Url decode the payload (the middle part of the JWT)
        $payloadRaw = json_decode(base64_decode(str_replace(['-', '_'], ['+', '/'], $jwtParts[1])));
        $userId = $payloadRaw->data->user_id ?? null;

        if (!$userId) {
            throw new Exception("Invalid token structure");
        }

        // --- UPDATED: Fetch password_hash along with status and role ---
        $stmt = $pdo->prepare("SELECT status, role, password_hash FROM users WHERE user_id = :id LIMIT 1");
        $stmt->execute([':id' => $userId]);
        $dbUser = $stmt->fetch(PDO::FETCH_ASSOC);

        // If user was deleted or unverified by admin, kill the session
        if (!$dbUser || $dbUser['status'] !== STATUS_VERIFIED) {
            setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');
            if ($force_exit) {
                Response::error("Account is unverified or restricted.", 401);
            }
            return false;
        }

        $JWT_SECRET = JWT_SECRET;
        $JWT_ALGO = JWT_ALGO;

        // --- NEW: Verify the JWT using the secret appended with the DB password_hash ---
        // If the password changed in the DB, this decode step will throw a SignatureInvalidException!
        $decoded = JWT::decode($jwt, new Key($JWT_SECRET . $dbUser['password_hash'], $JWT_ALGO));
        $userData = (array) $decoded->data;

        // Keep the payload fresh by injecting the latest DB role and status
        $userData['status'] = $dbUser['status'];
        $userData['role'] = $dbUser['role'];

        return $userData;
    } catch (Exception $e) {
        setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');
        if ($force_exit) {
            // Optional: you can check if $e is a SignatureInvalidException to log "forced logout due to password change"
            Response::error("Invalid or expired session. Please log in again.", 401);
        }
        return false;
    }
}
