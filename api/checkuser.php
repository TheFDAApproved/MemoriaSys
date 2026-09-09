<?php
require_once 'database.php';

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

function checkuser($force_exit = true)
{
    global $pdo;
    $jwt = null;

    // 1. Check Authorization Header
    $authHeader = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $authHeader = trim($_SERVER['HTTP_AUTHORIZATION']);
    } elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authHeader = trim($_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
    }

    if (preg_match('/Bearer\s(\S+)/', $authHeader, $matches)) {
        $jwt = $matches[1];
    }
    // 2. Fallback to HttpOnly Cookie
    else if (isset($_COOKIE['auth_token'])) {
        $jwt = $_COOKIE['auth_token'];
    }

    if (!$jwt) {
        if ($force_exit) {
            Response::error("Not logged in", 401);
        }
        return false;
    }

    try {
        $jwtParts = explode('.', $jwt);
        if (count($jwtParts) !== 3) {
            throw new Exception("Malformed token");
        }

        $payloadRaw = json_decode(base64_decode(str_replace(['-', '_'], ['+', '/'], $jwtParts[1])));
        $userId = $payloadRaw->data->user_id ?? null;
        $sessionTokenFromJWT = $payloadRaw->data->session_token ?? null;

        if (!$userId) {
            throw new Exception("Invalid token structure");
        }

        // Fetch user
        $stmt = $pdo->prepare("
            SELECT status, role, password_hash, session_token 
            FROM users 
            WHERE user_id = :id AND deleted_at IS NULL 
            LIMIT 1
        ");
        $stmt->execute([':id' => $userId]);
        $dbUser = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$dbUser || $dbUser['status'] !== STATUS_VERIFIED) {
            setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');
            if ($force_exit) {
                Response::error("Account is unverified or restricted.", 401);
            }
            return false;
        }

        // --- SINGLE SESSION CHECK with robust handling ---
        $storedToken = null;
        $storedSessionData = null;
        $sessionValid = false;

        if (!empty($dbUser['session_token'])) {
            $storedSessionData = json_decode($dbUser['session_token'], true);
            if (is_array($storedSessionData) && isset($storedSessionData['token'])) {
                $storedToken = $storedSessionData['token'];
                $sessionValid = ($sessionTokenFromJWT === $storedToken);
            }
        }

        // If session_token is NULL or invalid JSON, treat as no active session → reject
        if (!$sessionValid) {
            setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');

            if ($force_exit) {
                // If we have stored session data, use it to tell the user where the new login is
                if ($storedSessionData && is_array($storedSessionData)) {
                    $newIp = $storedSessionData['ip'] ?? 'Unknown IP';
                    $newTime = $storedSessionData['time'] ?? 'Unknown Time';
                    $rawUa = $storedSessionData['user_agent'] ?? 'Unknown Device';
                    $shortUa = strlen($rawUa) > 40 ? substr($rawUa, 0, 40) . '...' : $rawUa;
                    $errorMessage = "Session expired. Your account was accessed on a new device (IP: $newIp, Device: $shortUa) at $newTime.";
                } else {
                    $errorMessage = "Invalid session. Please log in again.";
                }
                Response::error($errorMessage, 401);
            }
            return false;
        }

        $JWT_SECRET = JWT_SECRET;
        $JWT_ALGO = JWT_ALGO;

        // Verify JWT signature
        $decoded = JWT::decode($jwt, new Key($JWT_SECRET . $dbUser['password_hash'], $JWT_ALGO));
        $userData = (array) $decoded->data;

        // Inject fresh role and status
        $userData['status'] = $dbUser['status'];
        $userData['role'] = $dbUser['role'];

        return $userData;
    } catch (Exception $e) {
        setcookie('auth_token', '', time() - JWT_EXPIRATION, '/');
        if ($force_exit) {
            Response::error("Invalid or expired session. Please log in again.", 401);
        }
        return false;
    }
}
