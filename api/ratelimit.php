<?php
require_once 'notallowed.php';

require_once 'jwt/JWTExceptionWithPayloadInterface.php';
require_once 'jwt/BeforeValidException.php';
require_once 'jwt/ExpiredException.php';
require_once 'jwt/SignatureInvalidException.php';
require_once 'jwt/Key.php';
require_once 'jwt/JWT.php';

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

function getRateLimitUser()
{
    $token = null;
    $authHeader = '';

    if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $authHeader = trim($_SERVER['HTTP_AUTHORIZATION']);
    } elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authHeader = trim($_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
    }

    if (preg_match('/Bearer\s(\S+)/', $authHeader, $matches)) {
        $token = $matches[1];
    } elseif (isset($_COOKIE['auth_token'])) {
        $token = $_COOKIE['auth_token'];
    }

    if (!$token) {
        return null;
    }

    try {
        $decoded = JWT::decode($token, new Key(JWT_SECRET, JWT_ALGO));
        $userData = (array) ($decoded->data ?? []);

        if (!isset($userData['user_id'], $userData['username'])) {
            return null;
        }

        return $userData;
    } catch (Throwable $exception) {
        return null;
    }
}

function handleRateLimit($limit, $period, $bucket = 'default')
{
    $userIp = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN';
    $route = $_SERVER['SCRIPT_NAME'] ?? 'unknown';
    $bucketKey = hash('sha256', $userIp . '|' . $method . '|' . $route . '|' . $bucket);
    $cacheDir = __DIR__ . '/cache';

    if (!is_dir($cacheDir) && !mkdir($cacheDir, 0700, true) && !is_dir($cacheDir)) {
        Response::error('Rate limiter is unavailable.', 503);
    }

    $file = $cacheDir . '/rate_' . $bucketKey . '.json';
    $handle = fopen($file, 'c+');

    if ($handle === false || !flock($handle, LOCK_EX)) {
        if (is_resource($handle)) {
            fclose($handle);
        }
        Response::error('Rate limiter is unavailable.', 503);
    }

    $contents = stream_get_contents($handle);
    $data = json_decode($contents ?: '', true);
    $now = time();

    if (!is_array($data) || !isset($data['requests']) || !is_array($data['requests'])) {
        $data = ['requests' => []];
    }

    $data['requests'] = array_values(array_filter(
        $data['requests'],
        static fn($timestamp) => is_int($timestamp) && $timestamp > ($now - $period)
    ));
    $currentUsage = count($data['requests']);
    $resetAt = $currentUsage > 0 ? min($data['requests']) + $period : $now + $period;

    header('X-RateLimit-Limit: ' . $limit);
    header('X-RateLimit-Remaining: ' . max(0, $limit - $currentUsage - 1));
    header('X-RateLimit-Reset: ' . $resetAt);

    if ($currentUsage >= $limit) {
        flock($handle, LOCK_UN);
        fclose($handle);

        $retryAfter = max(1, $resetAt - $now);
        $rateLimitUser = getRateLimitUser();
        $userId = $rateLimitUser['user_id'] ?? 'Unauthenticated';
        $username = $rateLimitUser['username'] ?? 'Unauthenticated';

        systemLog(
            "Rate limit exceeded for IP: $userIp and username: $username. " .
                "$limit requests in $period seconds. Retry in $retryAfter seconds.",
            $userId
        );

        header('Retry-After: ' . $retryAfter);
        Response::error("Too many requests. Please try again in $retryAfter seconds.", 429);
    }

    $data['requests'][] = $now;
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($data, JSON_THROW_ON_ERROR));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
}

function applyDefaultRateLimit()
{
    $method = $_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN';

    if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
        handleRateLimit(30, 60, 'write');
    } else {
        handleRateLimit(120, 60, 'read');
    }
}

applyDefaultRateLimit();
