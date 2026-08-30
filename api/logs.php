<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logs.php';
 
// require_once 'responses.php';
require_once 'checkuser.php';
    
$userData = checkuser();
// ==========================================
// --- ADMIN VIEW LOGS ENDPOINT ---
// ==========================================

// Define the method and action specifically for this file
$method = $_SERVER['REQUEST_METHOD'] ?? null;

if ($method === 'GET' ) {
    // This will exit with an error if not logged in
    
    // Strict Gatekeeper: Only Verified Admins
    if ($userData['role'] !== ROLE_ADMIN) {
        Response::error("Forbidden: Only administrators can view system logs", 403);
    }
    
    // Read the logs using the function defined above
    $logs = readLogs();
    
    Response::success("Logs retrieved successfully", $logs);
}

Response::error("Method not allowed", 405); // Only GET is allowed here
?>