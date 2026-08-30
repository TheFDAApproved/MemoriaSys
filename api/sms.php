<?php

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'textbee.php';
require_once 'logger.php';

header('Content-Type: application/json');

$userData = checkuser();

$method = $_SERVER['REQUEST_METHOD'] ?? null;


// --- HYBRID INPUT PARSER ---
$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$role = $userData['role'];
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE])) {
    Response::error("Forbidden. You do not have permission to perform this action.", 403);
}

if ($method === 'POST') {

    $phoneNumber = trim((string)($rawData['phone_number'] ?? ''));
    $message     = trim((string)($rawData['message'] ?? ''));

    if ($phoneNumber === '' || $message === '') {
        Response::error("phone_number and message are both required and cannot be empty.", 400);
    }

    // Guard the gateway: a runaway template should not turn into a 40-part SMS.
    if (mb_strlen($message) > 1000) {
        Response::error("Message is too long (" . mb_strlen($message) . " characters). Keep it under 1000.", 400);
    }

    // Default to true when the client omits the flag entirely.
    $includeCemeteryName = array_key_exists('include_cemetery_name', $rawData)
        ? filter_var($rawData['include_cemetery_name'], FILTER_VALIDATE_BOOLEAN)
        : true;

    // textbee.php appends "- From <cemetery_name>" itself when this is true,
    // so the message body must never carry the cemetery name already.
    $smsStatus = sendSmsViaTextBee($phoneNumber, $message, $includeCemeteryName);

    if (!$smsStatus['success']) {
        $reason = $smsStatus['error'] ?? 'Unknown gateway error';
        systemLog("Failed to send SMS to {$phoneNumber}. Error: {$reason}. Content: {$message}", $userData['user_id']);
        Response::error("Failed to send SMS: " . $reason . ". Recheck your API KEYS and DEVICE ID", 500);
    }

    systemLog("SMS sent to {$phoneNumber}. Content: {$message}", $userData['user_id']);
    Response::success("SMS sent successfully to " . $phoneNumber . ". Message content: " . $message, [
        "phone_number"          => $phoneNumber,
        "include_cemetery_name" => $includeCemeteryName,
        "message" => $message
    ]);
}

Response::error("Method Not Allowed", 405);
