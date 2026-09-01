<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';

// ==========================================
// --- DASHBOARD VIEW LOGS ENDPOINT ---
// ==========================================

$method = $_SERVER['REQUEST_METHOD'] ?? null;

if ($method !== 'GET') {
    Response::error("Method not allowed", 405);
}

$userData = checkuser();
$userRole = $userData['role'];

// Validate against allowed roles explicitly for Tier 1
$allowedRoles = [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS];
if (!in_array($userRole, $allowedRoles)) {
    Response::error("Unauthorized access", 403);
}

// Initialize the response array
$dashboardData = [];

// ==========================================
// TIER 1: EVERYONE SEES THIS (Admin, Office, Grounds)
// ==========================================

// --- Grave Status Distribution ---
// Categorises each grave based on interments:
//   - Expired   : active interment with lease_expiration_date <= CURDATE()
//   - Expiring  : active interment with expiry between 1–30 days from today
//   - Occupied  : active interment with expiry > 30 days from today
//   - Reserved  : pending interment (no active)
//   - Vacant    : no active/pending interment and grave.status = 'Vacant'
//   - Other     : fallback (should not happen)
$stmt = $pdo->query("
    SELECT 
        CASE 
            WHEN min_exp_date <= CURDATE() THEN 'Expired'
            WHEN min_exp_date BETWEEN DATE_ADD(CURDATE(), INTERVAL 1 DAY) 
                                  AND DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'Expiring'
            WHEN min_exp_date IS NOT NULL THEN 'Occupied'
            WHEN has_pending = 1 THEN 'Reserved'
            WHEN grave_status = 'Vacant' THEN 'Vacant'
            ELSE 'Other'
        END AS category,
        COUNT(*) AS count
    FROM (
        SELECT 
            g.grave_id,
            g.status AS grave_status,
            MIN(i.lease_expiration_date) AS min_exp_date,
            EXISTS (
                SELECT 1 FROM interments p 
                WHERE p.current_grave_id = g.grave_id AND p.status = 'Pending'
            ) AS has_pending
        FROM graves g
        LEFT JOIN interments i 
            ON g.grave_id = i.current_grave_id AND i.status = 'Active'
        GROUP BY g.grave_id
    ) AS grave_categories
    GROUP BY category
");

$graveDistribution = [
    'Vacant'   => 0,
    'Expired'  => 0,
    'Occupied' => 0,
    'Expiring' => 0,
    'Reserved' => 0
];

while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
    $cat = $row['category'];
    if (array_key_exists($cat, $graveDistribution)) {
        $graveDistribution[$cat] = (int)$row['count'];
    }
}
$dashboardData['grave_status_distribution'] = $graveDistribution;
$dashboardData['available_graves'] = $graveDistribution['Vacant'];

// --- Expiring Leases Count (active interments expiring within 30 days) ---
$stmt = $pdo->query("
    SELECT COUNT(*) FROM interments 
    WHERE status = 'Active' 
      AND lease_expiration_date BETWEEN DATE_ADD(CURDATE(), INTERVAL 1 DAY) 
                                   AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
");
$dashboardData['expiring_leases_count'] = (int)$stmt->fetchColumn();

// --- Monthly Lease Expiration (grouped by month for the current year) ---
$stmt = $pdo->query("
    SELECT DATE_FORMAT(lease_expiration_date, '%Y-%m') AS exp_month, 
           COUNT(*) AS count 
    FROM interments 
    WHERE status = 'Active' 
      AND YEAR(lease_expiration_date) = YEAR(CURDATE())
    GROUP BY exp_month 
    ORDER BY exp_month ASC
");
$rawData = $stmt->fetchAll(PDO::FETCH_KEY_PAIR) ?: [];

$monthlyExpiration = [];
$currentYear = date('Y');
for ($m = 1; $m <= 12; $m++) {
    $monthKey = $currentYear . '-' . str_pad($m, 2, "0", STR_PAD_LEFT);
    $monthlyExpiration[$monthKey] = (int)($rawData[$monthKey] ?? 0);
}
$dashboardData['monthly_lease_expiration'] = $monthlyExpiration;

// --- Payment Summary ---
// Grounds staff see only payments already confirmed by office.
// $paymentWhere = "1=1";  // no deleted_at column
// $paymentParams = [];
// if ($userRole === ROLE_GROUNDS) {
//     $paymentWhere .= " AND confirmed_office_staff IS NOT NULL";
// }

// $stmt = $pdo->prepare("
//     SELECT
//         COUNT(*) AS total_count,
//         SUM(CASE WHEN confirmed_office_staff IS NULL THEN 1 ELSE 0 END) AS pending_office,
//         SUM(CASE WHEN confirmed_office_staff IS NOT NULL AND confirmed_ground_staff IS NULL THEN 1 ELSE 0 END) AS pending_grounds,
//         SUM(CASE WHEN confirmed_office_staff IS NOT NULL AND confirmed_ground_staff IS NOT NULL THEN 1 ELSE 0 END) AS completed
//     FROM payments
//     WHERE $paymentWhere
// ");
// $stmt->execute($paymentParams);
// $paymentSummary = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

// $dashboardData['payments'] = [
//     'total_count'      => (int)($paymentSummary['total_count'] ?? 0),
//     'pending_office'   => (int)($paymentSummary['pending_office'] ?? 0),
//     'pending_grounds'  => (int)($paymentSummary['pending_grounds'] ?? 0),
//     'completed'        => (int)($paymentSummary['completed'] ?? 0)
// ];

// ==========================================
// TIER 2: OFFICE STAFF & ADMIN ONLY
// ==========================================
if (in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE])) {

    // Total Interment Records (all interments, regardless of status)
    $stmt = $pdo->query("SELECT COUNT(*) FROM interments");
    $dashboardData['total_interment_records'] = (int)$stmt->fetchColumn();

    // Expired Leases List (active interments with expired lease)
    // $stmt = $pdo->query("
    //     SELECT 
    //         i.deceased_name,
    //         g.grave_code,
    //         i.lease_expiration_date,
    //         i.contact_person_name AS contact_name,
    //         i.contact_person_phone_number AS phone_number,
    //         i.remarks
    //     FROM interments i
    //     JOIN graves g ON i.current_grave_id = g.grave_id
    //     WHERE i.status = 'Active'
    //       AND i.lease_expiration_date <= CURDATE()
    //     ORDER BY i.lease_expiration_date ASC
    //     LIMIT 5
    // ");
    // $dashboardData['expired_leases'] = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Expiring Leases List (active interments expiring within 30 days)
    // $stmt = $pdo->query("
    //     SELECT 
    //         i.deceased_name,
    //         g.grave_code,
    //         i.lease_expiration_date,
    //         i.contact_person_name AS contact_name,
    //         i.contact_person_phone_number AS phone_number,
    //         i.remarks
    //     FROM interments i
    //     JOIN graves g ON i.current_grave_id = g.grave_id
    //     WHERE i.status = 'Active'
    //       AND i.lease_expiration_date BETWEEN DATE_ADD(CURDATE(), INTERVAL 1 DAY) 
    //                                      AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
    //     ORDER BY i.lease_expiration_date ASC
    //     LIMIT 5
    // ");
    // $dashboardData['expiring_leases_list'] = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

// ==========================================
// TIER 3: ADMINISTRATOR ONLY
// ==========================================
if ($userRole === ROLE_ADMIN) {
    // Unverified Accounts (users with status != 'Verified')
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM users WHERE status != :status");
    $stmt->execute(['status' => 'Verified']);
    $dashboardData['unverified_accounts'] = (int)$stmt->fetchColumn();
}

// Finally, output the perfectly tailored JSON payload
Response::success($userRole . " Dashboard data retrieved successfully", $dashboardData);
