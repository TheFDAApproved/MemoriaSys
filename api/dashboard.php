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
// Expired/Expiring counts are aligned with reserve.php's eligibility rules:
//   - grave still exists (graves.deleted_at IS NULL)
//   - exactly one Active occupant on that grave (co-interment graves excluded)
//   - no Active reservation already references the grave (target or destination)
//   - the occupant himself is not already an Active reservation's old_interment_id
// Graves/occupants that fail these checks still exist, but they cannot be
// reserved, so they fall into "Occupied" / "Reserved" / "Ineligible" instead
// of "Expired" / "Expiring". This is what closes the 220 vs 199 gap
$stmt = $pdo->query("
    SELECT 
        CASE 
            WHEN has_active_reservation = 1 THEN 'Reserved'
            WHEN active_occupant_count = 0 AND grave_status = 'Vacant' THEN 'Vacant'
            WHEN active_occupant_count = 1 
                 AND min_exp_date IS NOT NULL 
                 AND min_exp_date < CURDATE() THEN 'Expired'
            WHEN active_occupant_count = 1 
                 AND min_exp_date IS NOT NULL 
                 AND min_exp_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH) THEN 'Expiring'
            WHEN active_occupant_count = 1 THEN 'Occupied'
            WHEN active_occupant_count >= 2 THEN 'Occupied'
            ELSE 'Other'
        END AS category,
        COUNT(*) AS count
    FROM (
        SELECT 
            g.grave_id,
            g.status AS grave_status,
            MIN(i.lease_expiration_date) AS min_exp_date,
            COUNT(i.interment_id) AS active_occupant_count,
            EXISTS (
                SELECT 1 FROM reservations r
                WHERE r.reservation_state = 'Active'
                  AND (r.target_grave_id = g.grave_id 
                       OR r.old_new_grave_id = g.grave_id)
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

// Lease status by interment. Expired/Expiring use the same eligibility rules
// as reserve.php. Interments with an expired/expiring lease that fail those
// rules land in "Ineligible" so the five buckets still sum to Total
$stmt = $pdo->query("
    SELECT 
        SUM(CASE 
            WHEN lease_expiration_date < CURDATE() AND is_eligible = 1 
            THEN 1 ELSE 0 
        END) AS expired,
        SUM(CASE 
            WHEN lease_expiration_date >= CURDATE() 
             AND lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH) 
             AND is_eligible = 1 
            THEN 1 ELSE 0 
        END) AS expiring,
        SUM(CASE 
            WHEN lease_expiration_date > DATE_ADD(CURDATE(), INTERVAL 1 MONTH) 
            THEN 1 ELSE 0 
        END) AS occupied,
        SUM(CASE 
            WHEN lease_expiration_date IS NULL 
            THEN 1 ELSE 0 
        END) AS unknown,
        SUM(CASE 
            WHEN lease_expiration_date IS NOT NULL 
             AND lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH) 
             AND is_eligible = 0 
            THEN 1 ELSE 0 
        END) AS ineligible,
        COUNT(*) AS total
    FROM (
        SELECT 
            i.interment_id,
            i.lease_expiration_date,
            CASE 
                WHEN g.grave_id IS NULL THEN 0
                WHEN (SELECT COUNT(*) FROM interments i2 
                      WHERE i2.current_grave_id = g.grave_id 
                        AND i2.status = 'Active' 
                        AND i2.deleted_at IS NULL) <> 1 THEN 0
                WHEN EXISTS (SELECT 1 FROM reservations r 
                             WHERE r.reservation_state = 'Active' 
                               AND (r.target_grave_id = g.grave_id 
                                    OR r.old_new_grave_id = g.grave_id)) THEN 0
                WHEN EXISTS (SELECT 1 FROM reservations r 
                             WHERE r.reservation_state = 'Active' 
                               AND r.old_interment_id = i.interment_id) THEN 0
                ELSE 1
            END AS is_eligible
        FROM interments i
        LEFT JOIN graves g 
            ON i.current_grave_id = g.grave_id 
            AND g.deleted_at IS NULL
        WHERE i.status = 'Active' 
          AND i.deleted_at IS NULL
    ) AS sub
");
$row = $stmt->fetch(PDO::FETCH_ASSOC);
$dashboardData['lease_status_by_interment'] = [
    'Expired'    => (int)$row['expired'],
    'Expiring'   => (int)$row['expiring'],
    'Occupied'   => (int)$row['occupied'],
    'Unknown'    => (int)$row['unknown'],
    'Ineligible' => (int)$row['ineligible'],
    'Total'      => (int)$row['total'],
];

// Expiring Leases Count — eligible only (matches reserve.php's "expiring")
$stmt = $pdo->query("
    SELECT COUNT(*) FROM interments i
    INNER JOIN graves g 
        ON i.current_grave_id = g.grave_id 
        AND g.deleted_at IS NULL
    WHERE i.status = 'Active' 
      AND i.deleted_at IS NULL
      AND i.lease_expiration_date >= CURDATE()
      AND i.lease_expiration_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
      AND (SELECT COUNT(*) FROM interments i2
           WHERE i2.current_grave_id = g.grave_id
             AND i2.status = 'Active'
             AND i2.deleted_at IS NULL) = 1
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND (r.target_grave_id = g.grave_id 
                 OR r.old_new_grave_id = g.grave_id)
      )
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND r.old_interment_id = i.interment_id
      )
");
$dashboardData['expiring_leases_count'] = (int)$stmt->fetchColumn();

// Expired Leases Count — eligible only (matches reserve.php's "expired")
$stmt = $pdo->query("
    SELECT COUNT(*) FROM interments i
    INNER JOIN graves g 
        ON i.current_grave_id = g.grave_id 
        AND g.deleted_at IS NULL
    WHERE i.status = 'Active' 
      AND i.deleted_at IS NULL
      AND i.lease_expiration_date < CURDATE()
      AND (SELECT COUNT(*) FROM interments i2
           WHERE i2.current_grave_id = g.grave_id
             AND i2.status = 'Active'
             AND i2.deleted_at IS NULL) = 1
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND (r.target_grave_id = g.grave_id 
                 OR r.old_new_grave_id = g.grave_id)
      )
      AND NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.reservation_state = 'Active'
            AND r.old_interment_id = i.interment_id
      )
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
// This is intentionally raw — it's a calendar chart, not a "reservable" count.
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
