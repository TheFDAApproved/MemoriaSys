<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';

$method = $_SERVER['REQUEST_METHOD'] ?? null;

if ($method !== 'GET') {
    Response::error("Method not allowed", 405);
}

$userData = checkuser();
$userRole = $userData['role'];

// Validate against allowed roles
$allowedRoles = [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS];
if (!in_array($userRole, $allowedRoles)) {
    Response::error("Unauthorized access", 403);
}

// Initialize the response array
$dashboardData = [];

// TIER 1: everyone sees (Admin, Office, Grounds)
$stmt = $pdo->query("
    SELECT 
        CASE 
            WHEN min_exp_date IS NOT NULL AND min_exp_date <= CURDATE() THEN 'Expired'
            WHEN min_exp_date IS NOT NULL 
                 AND min_exp_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'Expiring'
            WHEN min_exp_date IS NOT NULL THEN 'Occupied'
            WHEN has_active_reservation = 1 THEN 'Reserved'
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
                SELECT 1 FROM reservations r
                WHERE r.target_grave_id = g.grave_id
                  AND r.reservation_state = 'Active'
            ) AS has_active_reservation
        FROM graves g
        LEFT JOIN interments i 
            ON g.grave_id = i.current_grave_id 
            AND i.status = 'Active'
            AND i.deleted_at IS NULL
        WHERE g.deleted_at IS NULL
        GROUP BY g.grave_id
    ) AS grave_categories
    GROUP BY category
");

$graveDistribution = [
    'Vacant'   => 0,
    'Expired'  => 0,
    'Occupied' => 0,
    'Expiring' => 0,
    'Reserved' => 0,
    'Other'    => 0,
];

while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
    $cat = $row['category'];
    if (array_key_exists($cat, $graveDistribution)) {
        $graveDistribution[$cat] = (int)$row['count'];
    }
}
$dashboardData['grave_status_distribution'] = $graveDistribution;
$dashboardData['available_graves'] = $graveDistribution['Vacant'];

$stmt = $pdo->query("
    SELECT 
        SUM(lease_expiration_date <= CURDATE()) AS expired,
        SUM(lease_expiration_date > CURDATE()
            AND lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS expiring,
        SUM(lease_expiration_date > DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS occupied,
        SUM(lease_expiration_date IS NULL) AS unknown,
        COUNT(*) AS total
    FROM interments
    WHERE status = 'Active' AND deleted_at IS NULL
");
$row = $stmt->fetch(PDO::FETCH_ASSOC);
$dashboardData['lease_status_by_interment'] = [
    'Expired'  => (int)$row['expired'],
    'Expiring' => (int)$row['expiring'],
    'Occupied' => (int)$row['occupied'],
    'Unknown'  => (int)$row['unknown'],
    'Total'    => (int)$row['total'],
];

// Expiring Leases Count (active interments expiring within 30 days)
$stmt = $pdo->query("
    SELECT COUNT(*) FROM interments 
    WHERE status = 'Active' 
      AND deleted_at IS NULL
      AND lease_expiration_date BETWEEN DATE_ADD(CURDATE(), INTERVAL 1 DAY) 
                                   AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
");
$dashboardData['expiring_leases_count'] = (int)$stmt->fetchColumn();

// Expired Leases Count (active interments already past expiration)
$stmt = $pdo->query("
    SELECT COUNT(*) FROM interments 
    WHERE status = 'Active' 
      AND deleted_at IS NULL
      AND lease_expiration_date <= CURDATE()
");
$dashboardData['expired_leases_count'] = (int)$stmt->fetchColumn();

// Co-interment graves (graves with 2+ active interments)
$stmt = $pdo->query("
    SELECT COUNT(*) FROM (
        SELECT current_grave_id
        FROM interments
        WHERE status = 'Active'
          AND deleted_at IS NULL
          AND current_grave_id IS NOT NULL
        GROUP BY current_grave_id
        HAVING COUNT(*) > 1
    ) AS co
");
$dashboardData['co_interment_graves_count'] = (int)$stmt->fetchColumn();

// Active reservations (graves currently locked for an upcoming move)
$stmt = $pdo->query("
    SELECT COUNT(*) FROM reservations WHERE reservation_state = 'Active'
");
$dashboardData['active_reservations_count'] = (int)$stmt->fetchColumn();

// Payment confirmation queue
$stmt = $pdo->query("
    SELECT 
        COALESCE(SUM(confirmed_office_staff IS NULL), 0)  AS awaiting_office,
        COALESCE(SUM(confirmed_ground_staff IS NULL), 0)  AS awaiting_grounds
    FROM payments
    WHERE deleted_at IS NULL
");
$row = $stmt->fetch(PDO::FETCH_ASSOC);
$awaitingOffice   = (int)$row['awaiting_office'];
$awaitingGrounds  = (int)$row['awaiting_grounds'];

$dashboardData['payments_awaiting_my_confirmation'] =
    $userRole === ROLE_OFFICE  ? $awaitingOffice  : ($userRole === ROLE_GROUNDS ? $awaitingGrounds : 0);

// Monthly Lease Expiration (grouped by month for the current year)
$stmt = $pdo->query("
    SELECT DATE_FORMAT(lease_expiration_date, '%Y-%m') AS exp_month, 
           COUNT(*) AS count 
    FROM interments 
    WHERE status = 'Active' 
      AND deleted_at IS NULL
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

// TIER 2: office staff and admin 
if (in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE])) {

    // Total Interment Records (all interments, regardless of status, excluding soft-deleted)
    $stmt = $pdo->query("SELECT COUNT(*) FROM interments WHERE deleted_at IS NULL");
    $dashboardData['total_interment_records'] = (int)$stmt->fetchColumn();

    // Payment financial breakdown
    $stmt = $pdo->query("
        SELECT 
            COUNT(*) AS total_count,
            COALESCE(SUM(
                confirmed_office_staff IS NOT NULL 
                AND confirmed_ground_staff IS NOT NULL
            ), 0) AS fully_confirmed_count,
            COALESCE(SUM(confirmed_office_staff IS NULL), 0)  AS unconfirmed_by_office_count,
            COALESCE(SUM(confirmed_ground_staff IS NULL), 0)  AS unconfirmed_by_grounds_count,
            COALESCE(SUM(
                confirmed_office_staff IS NULL 
                AND confirmed_ground_staff IS NULL
            ), 0) AS unconfirmed_by_both_count,
            COALESCE(SUM(CASE 
                WHEN confirmed_office_staff IS NOT NULL 
                 AND confirmed_ground_staff IS NOT NULL 
                THEN amount ELSE 0 END), 0) AS confirmed_amount,
            COALESCE(SUM(CASE 
                WHEN confirmed_office_staff IS NULL 
                  OR confirmed_ground_staff IS NULL 
                THEN amount ELSE 0 END), 0) AS unconfirmed_amount
        FROM payments
        WHERE deleted_at IS NULL
    ");
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    $totalCount          = (int)$row['total_count'];
    $fullyConfirmedCount = (int)$row['fully_confirmed_count'];

    $dashboardData['payments'] = [
        'total_count'               => $totalCount,
        'fully_confirmed_count'     => $fullyConfirmedCount,
        'unconfirmed_count'         => $totalCount - $fullyConfirmedCount,
        'unconfirmed_by_office_count'  => (int)$row['unconfirmed_by_office_count'],
        'unconfirmed_by_grounds_count' => (int)$row['unconfirmed_by_grounds_count'],
        'unconfirmed_by_both_count'    => (int)$row['unconfirmed_by_both_count'],
        'confirmed_amount'          => (float)$row['confirmed_amount'],
        'unconfirmed_amount'        => (float)$row['unconfirmed_amount'],
        'total_amount'              => (float)$row['confirmed_amount'] + (float)$row['unconfirmed_amount'],
    ];
}

// TIER 3: Admin, just the user accounts
if ($userRole === ROLE_ADMIN) {
    // Unverified Accounts (users with status != 'Verified', excluding soft-deleted)
    $stmt = $pdo->prepare("
        SELECT COUNT(*) FROM users 
        WHERE status != :status 
          AND deleted_at IS NULL
    ");
    $stmt->execute(['status' => 'Verified']);
    $dashboardData['unverified_accounts'] = (int)$stmt->fetchColumn();
}

Response::success($userRole . " Dashboard data retrieved successfully", $dashboardData);
