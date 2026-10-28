<?php
//api/reports — RESTish
//GET /api/reports                    populate_filters
//GET /api/reports/populate_filters   filter options (no pagination)
//GET /api/reports/cemetery_capacity  capacity summary (no pagination)
//GET /api/reports/lease_expirations  paginated, date-range filterable
//GET /api/reports/interments         paginated, date-range filterable
//GET /api/reports/graves             paginated, comma-separated status filter
//GET /api/reports/payments           paginated
//Pagination:
//?page=1..100000 (default 1)
//?limit=1..500   (default 500, max 500)
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

if ($method !== 'GET') {
    Response::error("Method not allowed", 405);
}

$userRole = $userData['role'] ?? null;
if (!in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Unauthorized access", 403);
}

function rr_str(string $key): ?string
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '' || is_array($raw)) {
        return null;
    }
    $v = trim((string)$raw);
    if ($v === '' || strcasecmp($v, 'all') === 0) {
        return null;
    }
    return $v;
}

function rr_int(string $key, ?int $default = null, ?int $min = null, ?int $max = null): ?int
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '') {
        return $default;
    }
    if (is_array($raw) || filter_var($raw, FILTER_VALIDATE_INT) === false) {
        Response::error("Invalid '$key' parameter — must be an integer.", 400);
    }
    $v = (int)$raw;
    if ($min !== null && $v < $min) {
        Response::error("Invalid '$key' parameter — must be at least $min.", 400);
    }
    if ($max !== null && $v > $max) {
        Response::error("Invalid '$key' parameter — must be at most $max.", 400);
    }
    return $v;
}

function rr_float(string $key): ?float
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '') {
        return null;
    }
    if (is_array($raw) || !is_numeric($raw)) {
        Response::error("Invalid '$key' parameter — must be a number.", 400);
    }
    return (float)$raw;
}

function rr_enum(string $key, array $allowed): ?string
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '' || is_array($raw)) {
        return null;
    }
    $v = trim((string)$raw);
    if ($v === '' || strcasecmp($v, 'all') === 0) {
        return null;
    }
    foreach ($allowed as $candidate) {
        if (strcasecmp($v, $candidate) === 0) {
            return $candidate;
        }
    }
    Response::error(
        "Invalid '$key' parameter. Allowed: " . implode(', ', $allowed),
        400
    );
    return null;
}

function rr_csv_list(string $key): ?array
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '' || is_array($raw)) {
        return null;
    }
    $parts = [];
    foreach (explode(',', (string)$raw) as $p) {
        $v = trim($p);
        if ($v !== '') $parts[] = $v;
    }
    if (empty($parts)) return null;
    return array_values(array_unique($parts));
}

function rr_enum_list(string $key, array $allowed): ?array
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '' || is_array($raw)) {
        return null;
    }
    $parts = array_map('trim', explode(',', (string)$raw));
    $out = [];
    foreach ($parts as $p) {
        if ($p === '') continue;
        $match = null;
        foreach ($allowed as $candidate) {
            if (strcasecmp($p, $candidate) === 0) {
                $match = $candidate;
                break;
            }
        }
        if ($match === null) {
            Response::error(
                "Invalid value '$p' for '$key'. Allowed: " . implode(', ', $allowed),
                400
            );
        }
        $out[] = $match;
    }
    if (empty($out)) return null;
    return array_values(array_unique($out));
}

// Parses boolean param. Returns $default if absent/empty.
function rr_bool(string $key, bool $default): bool
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '') {
        return $default;
    }
    if (is_array($raw)) {
        Response::error("Invalid '$key' parameter.", 400);
    }
    $v = strtolower(trim((string)$raw));
    if (in_array($v, ['1', 'true', 'yes'], true))  return true;
    if (in_array($v, ['0', 'false', 'no'], true)) return false;
    Response::error("Invalid '$key' parameter — must be true/false.", 400);
    return $default;
}

function rr_iso_date(string $key): ?string
{
    $raw = $_GET[$key] ?? null;
    if ($raw === null || $raw === '' || is_array($raw)) {
        return null;
    }
    $v = trim((string)$raw);
    $d = DateTime::createFromFormat('Y-m-d', $v);
    if (!$d || $d->format('Y-m-d') !== $v) {
        Response::error("Invalid '$key' parameter — must be YYYY-MM-DD.", 400);
    }
    return $v;
}

// Parses ?page= and ?limit=. Returns [page, perPage, offset]
function rr_pagination(): array
{
    $page    = rr_int('page', 1, 1, 100000) ?? 1;
    $perPage = rr_int('limit', 500, 1, 500) ?? 500;
    $offset  = ($page - 1) * $perPage;
    return [$page, $perPage, $offset];
}

// Builds the pagination meta block
function rr_pagination_meta(int $page, int $perPage, int $total): array
{
    return [
        'current_page'  => $page,
        'per_page'      => $perPage,
        'total_records' => $total,
        'total_pages'   => $total > 0 ? (int)ceil($total / $perPage) : 0,
    ];
}

// Per-grave category based on current date. Used by cemetery_capacity and graves
function rr_categorized_graves_sql(): string
{
    return "
            SELECT
                gc.block_id,
                gc.grave_id,
                CASE
                    WHEN gc.min_exp_date IS NOT NULL
                         AND gc.min_exp_date <= CURDATE() THEN 'Expired'
                    WHEN gc.min_exp_date IS NOT NULL
                         AND gc.min_exp_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'Expiring'
                    WHEN gc.min_exp_date IS NOT NULL THEN 'Occupied'
                    WHEN gc.has_active_reservation = 1 THEN 'Reserved'
                    WHEN gc.grave_status = 'Vacant' THEN 'Vacant'
                    ELSE 'Other'
                END AS category,
                gc.min_exp_date,
                gc.has_active_reservation,
                gc.active_interments_count
            FROM (
                SELECT
                    g.block_id,
                    g.grave_id,
                    g.status AS grave_status,
                    MIN(i.lease_expiration_date) AS min_exp_date,
                    COUNT(DISTINCT i.interment_id) AS active_interments_count,
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
            ) AS gc
        ";
}

// Empty distribution map, for the zero-fill pie chart data
function rr_empty_category_distribution(): array
{
    return [
        'Vacant'   => 0,
        'Occupied' => 0,
        'Expiring' => 0,
        'Expired'  => 0,
        'Reserved' => 0,
        'Other'    => 0,
    ];
}

function handle_cemetery_capacity(PDO $pdo): void
{
    $summaryStmt = $pdo->query("
            SELECT
                COUNT(*) AS total_graves,
                COALESCE(SUM(CASE WHEN category = 'Occupied' THEN 1 ELSE 0 END), 0) AS occupied,
                COALESCE(SUM(CASE WHEN category = 'Vacant'   THEN 1 ELSE 0 END), 0) AS vacant,
                COALESCE(SUM(CASE WHEN category = 'Expiring' THEN 1 ELSE 0 END), 0) AS expiring,
                COALESCE(SUM(CASE WHEN category = 'Expired'  THEN 1 ELSE 0 END), 0) AS expired,
                COALESCE(SUM(CASE WHEN category = 'Reserved' THEN 1 ELSE 0 END), 0) AS reserved,
                COALESCE(SUM(CASE WHEN category = 'Other'    THEN 1 ELSE 0 END), 0) AS other
            FROM (" . rr_categorized_graves_sql() . ") AS cg
        ");
    $summaryRow = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $distribution = rr_empty_category_distribution();
    $distStmt = $pdo->query("
            SELECT category, COUNT(*) AS count
            FROM (" . rr_categorized_graves_sql() . ") AS cg
            GROUP BY category
        ");
    while ($row = $distStmt->fetch(PDO::FETCH_ASSOC)) {
        $cat = (string)($row['category'] ?? '');
        if (array_key_exists($cat, $distribution)) {
            $distribution[$cat] = (int)($row['count'] ?? 0);
        }
    }

    $leaseStmt = $pdo->query("
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
    $leaseRow = $leaseStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $leaseStatus = [
        'Expired'  => (int)($leaseRow['expired']  ?? 0),
        'Expiring' => (int)($leaseRow['expiring'] ?? 0),
        'Occupied' => (int)($leaseRow['occupied'] ?? 0),
        'Unknown'  => (int)($leaseRow['unknown']  ?? 0),
        'Total'    => (int)($leaseRow['total']    ?? 0),
    ];

    $monthlyStmt = $pdo->query("
            SELECT DATE_FORMAT(lease_expiration_date, '%Y-%m') AS exp_month,
                   COUNT(*) AS count
            FROM interments
            WHERE status = 'Active'
              AND deleted_at IS NULL
              AND YEAR(lease_expiration_date) = YEAR(CURDATE())
            GROUP BY exp_month
            ORDER BY exp_month ASC
        ");
    $rawMonthly = $monthlyStmt->fetchAll(PDO::FETCH_KEY_PAIR) ?: [];

    $monthlyExpiration = [];
    $currentYear = date('Y');
    for ($m = 1; $m <= 12; $m++) {
        $key = $currentYear . '-' . str_pad((string)$m, 2, '0', STR_PAD_LEFT);
        $monthlyExpiration[$key] = (int)($rawMonthly[$key] ?? 0);
    }

    $coStmt = $pdo->query("
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
    $coIntermentCount = (int)$coStmt->fetchColumn();

    $resvStmt = $pdo->query("
            SELECT COUNT(*) FROM reservations WHERE reservation_state = 'Active'
        ");
    $activeReservationsCount = (int)$resvStmt->fetchColumn();

    $blockStmt = $pdo->query("
            SELECT
                b.block_id,
                b.block_name,
                b.block_type,
                COALESCE(agg.total_graves, 0) AS total_graves,
                COALESCE(agg.occupied, 0)     AS occupied,
                COALESCE(agg.vacant, 0)       AS vacant,
                COALESCE(agg.expiring, 0)     AS expiring,
                COALESCE(agg.expired, 0)      AS expired,
                COALESCE(agg.reserved, 0)     AS reserved,
                COALESCE(agg.other, 0)        AS other
            FROM blocks b
            LEFT JOIN (
                SELECT
                    cg.block_id,
                    COUNT(*) AS total_graves,
                    SUM(CASE WHEN cg.category = 'Occupied' THEN 1 ELSE 0 END) AS occupied,
                    SUM(CASE WHEN cg.category = 'Vacant'   THEN 1 ELSE 0 END) AS vacant,
                    SUM(CASE WHEN cg.category = 'Expiring' THEN 1 ELSE 0 END) AS expiring,
                    SUM(CASE WHEN cg.category = 'Expired'  THEN 1 ELSE 0 END) AS expired,
                    SUM(CASE WHEN cg.category = 'Reserved' THEN 1 ELSE 0 END) AS reserved,
                    SUM(CASE WHEN cg.category = 'Other'    THEN 1 ELSE 0 END) AS other
                FROM (" . rr_categorized_graves_sql() . ") AS cg
                GROUP BY cg.block_id
            ) AS agg ON agg.block_id = b.block_id
            WHERE b.deleted_at IS NULL
            ORDER BY b.block_name ASC
        ");

    $byBlock = array_map(static function (array $row): array {
        return [
            'block_id'     => (int)($row['block_id'] ?? 0),
            'block_name'   => $row['block_name'] ?? 'N/A',
            'block_type'   => $row['block_type'] ?? 'N/A',
            'total_graves' => (int)($row['total_graves'] ?? 0),
            'occupied'     => (int)($row['occupied'] ?? 0),
            'vacant'       => (int)($row['vacant'] ?? 0),
            'expiring'     => (int)($row['expiring'] ?? 0),
            'expired'      => (int)($row['expired'] ?? 0),
            'reserved'     => (int)($row['reserved'] ?? 0),
            'other'        => (int)($row['other'] ?? 0),
        ];
    }, $blockStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

    Response::success("Cemetery capacity summary retrieved", [
        'summary' => [
            'total_graves' => (int)($summaryRow['total_graves'] ?? 0),
            'occupied'     => (int)($summaryRow['occupied'] ?? 0),
            'vacant'       => (int)($summaryRow['vacant'] ?? 0),
            'expiring'     => (int)($summaryRow['expiring'] ?? 0),
            'expired'      => (int)($summaryRow['expired'] ?? 0),
            'reserved'     => (int)($summaryRow['reserved'] ?? 0),
            'other'        => (int)($summaryRow['other'] ?? 0),
        ],
        'grave_status_distribution' => $distribution,
        'lease_status_by_interment' => $leaseStatus,
        'monthly_lease_expiration'  => $monthlyExpiration,
        'co_interment_graves_count' => $coIntermentCount,
        'active_reservations_count' => $activeReservationsCount,
        'by_block'                  => $byBlock,
        'total_records'             => count($byBlock),
    ]);
}

function handle_lease_expirations(PDO $pdo): void
{
    $startDate = rr_iso_date('start_date');
    $endDate   = rr_iso_date('end_date');

    // Bucket flags. either expired or expiring, the missing one defaults to false
    // both default to true
    $anyBucketParam = (
        (isset($_GET['expired'])  && $_GET['expired']  !== '') ||
        (isset($_GET['expiring']) && $_GET['expiring'] !== '')
    );
    if ($anyBucketParam) {
        $includeExpired  = rr_bool('expired',  false);
        $includeExpiring = rr_bool('expiring', false);
    } else {
        $includeExpired  = true;
        $includeExpiring = true;
    }

    // N-days window for the expiring bucket only. 0 means today only
    // 1 means today + tomorrow, N means today through today + N
    // Default 30. Applies only when no date range is set
    $days = rr_int('days', 30, 0, 365) ?? 30;

    [$page, $perPage, $offset] = rr_pagination();

    if ($startDate !== null && $endDate !== null && $startDate > $endDate) {
        Response::error("start_date must be before or equal to end_date.", 400);
    }
    if (!$includeExpired && !$includeExpiring) {
        Response::error("At least one of expired/expiring must be true.", 400);
    }

    $hasRange = ($startDate !== null || $endDate !== null);

    // Base filters (soft-delete + status + non-null expiration)
    // A date range narrows both buckets to that window
    $baseWhere = "i.status = 'Active' AND i.deleted_at IS NULL AND i.lease_expiration_date IS NOT NULL";
    $params = [];

    if ($startDate !== null) {
        $baseWhere .= " AND i.lease_expiration_date >= :start_date";
        $params[':start_date'] = $startDate;
    }
    if ($endDate !== null) {
        $baseWhere .= " AND i.lease_expiration_date <= :end_date";
        $params[':end_date'] = $endDate;
    }

    $expiredClause = "i.lease_expiration_date < CURDATE()";

    // Expiring
    $expiringClause = $hasRange
        ? "i.lease_expiration_date >= CURDATE()"
        : "i.lease_expiration_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL {$days} DAY)";

    $bucketClauses = [];
    if ($includeExpired)  $bucketClauses[] = $expiredClause;
    if ($includeExpiring) $bucketClauses[] = $expiringClause;
    $bucketSql = "(" . implode(" OR ", $bucketClauses) . ")";

    $where = "WHERE " . $baseWhere . " AND " . $bucketSql;

    // Total count for pagination meta
    $countStmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM interments i
        LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
        {$where}
    ");
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    // Paginated rows
    $sql = "
        SELECT
            i.interment_id,
            g.grave_code,
            i.deceased_name,
            i.lease_expiration_date,
            i.contact_person_name,
            i.contact_person_phone_number,
            i.remarks,
            i.status
        FROM interments i
        LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
        {$where}
        ORDER BY i.lease_expiration_date ASC
        LIMIT {$perPage} OFFSET {$offset}
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $todayTs = strtotime('today');
    $mapped = array_map(static function (array $row) use ($todayTs): array {
        $exp   = $row['lease_expiration_date'] ?? null;
        $expTs = $exp ? strtotime((string)$exp) : false;
        $isExpired = ($expTs !== false && $expTs < $todayTs);
        return [
            'interment_id'                => (int)($row['interment_id'] ?? 0),
            'grave_code'                  => $row['grave_code'] ?? null,
            'deceased_name'               => $row['deceased_name'] ?? 'Unknown',
            'lease_expiration_date'       => $exp,
            'contact_person_name'         => $row['contact_person_name'] ?? null,
            'contact_person_phone_number' => $row['contact_person_phone_number'] ?? null,
            'remarks'                     => $row['remarks'] ?? null,
            'status'                      => $row['status'] ?? 'Unknown',
            'is_expired'                  => $isExpired,
            'bucket'                      => $isExpired ? 'expired' : 'expiring',
        ];
    }, $rows);

    Response::success("Lease expirations retrieved", [
        'filtered_by' => [
            'start_date' => $startDate,
            'end_date'   => $endDate,
            'expired'    => $includeExpired,
            'expiring'   => $includeExpiring,
            'days'       => $hasRange ? null : $days,
        ],
        'rows'             => $mapped,
        'total_records'    => $total,
        'returned_records' => count($mapped),
        'pagination'       => rr_pagination_meta($page, $perPage, $total),
    ]);
}

function handle_interments(PDO $pdo): void
{
    $address   = rr_str('address');
    $genders   = rr_enum_list('gender', ['Male', 'Female', 'Unknown']);
    $barangays = rr_csv_list('barangay');
    $contact   = rr_enum('contact', ['has_contact', 'no_contact']);
    $startDate = rr_iso_date('start_date');
    $endDate   = rr_iso_date('end_date');
    [$page, $perPage, $offset] = rr_pagination();

    if ($startDate !== null && $endDate !== null && $startDate > $endDate) {
        Response::error("start_date must be before or equal to end_date.", 400);
    }

    $params       = [];
    $whereClauses = ["i.deleted_at IS NULL"];

    if ($address !== null) {
        $whereClauses[] = "(
            i.last_known_address LIKE :addr1
            OR i.contact_person_address LIKE :addr2
            OR i.contact_person_address_barangay LIKE :addr3
        )";
        $like = '%' . $address . '%';
        $params[':addr1'] = $like;
        $params[':addr2'] = $like;
        $params[':addr3'] = $like;
    }

    if (!empty($genders)) {
        $phs = [];
        foreach ($genders as $i => $g) {
            $ph = ":gender_" . $i;
            $phs[] = $ph;
            $params[$ph] = $g;
        }
        $whereClauses[] = "i.deceased_sex IN (" . implode(", ", $phs) . ")";
    }

    if (!empty($barangays)) {
        $phrases = [];
        foreach ($barangays as $i => $b) {
            $ph = ":barangay_" . $i;
            $params[$ph] = '%' . $b . '%';
            $phrases[] = "i.contact_person_address_barangay LIKE {$ph}";
        }
        $whereClauses[] = "(" . implode(" OR ", $phrases) . ")";
    }

    if ($contact === 'has_contact') {
        $whereClauses[] = "(i.contact_person_name IS NOT NULL AND i.contact_person_name <> '')";
    } elseif ($contact === 'no_contact') {
        $whereClauses[] = "(i.contact_person_name IS NULL OR i.contact_person_name = '')";
    }

    if ($startDate !== null) {
        $whereClauses[] = "COALESCE(i.date_buried, i.deceased_date_of_death) >= :start_date";
        $params[':start_date'] = $startDate;
    }
    if ($endDate !== null) {
        $whereClauses[] = "COALESCE(i.date_buried, i.deceased_date_of_death) <= :end_date";
        $params[':end_date'] = $endDate;
    }

    $whereSql = "WHERE " . implode(" AND ", $whereClauses);

    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM interments i {$whereSql}");
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $sql = "
        SELECT
            i.interment_id,
            i.control_number,
            i.deceased_name,
            i.deceased_date_of_birth,
            i.deceased_date_of_death,
            i.deceased_sex,
            i.date_buried,
            i.last_known_address,
            i.lease_expiration_date,
            i.status,
            i.remarks AS interment_remarks,
            i.contact_person_name,
            i.contact_person_phone_number,
            i.contact_person_email,
            i.contact_person_address_barangay,
            i.contact_person_address,
            g.grave_code,
            b.block_name,
            b.block_type
        FROM interments i
        LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON b.block_id = g.block_id AND b.deleted_at IS NULL
        {$whereSql}
        ORDER BY i.date_buried DESC, i.interment_id DESC
        LIMIT {$perPage} OFFSET {$offset}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $mapped = array_map(static function (array $row): array {
        $contactName = trim((string)($row['contact_person_name'] ?? ''));
        $hasContact  = ($contactName !== '');

        $burialSource = $row['date_buried'] ?: ($row['deceased_date_of_death'] ?? null);
        $burialYear   = null;
        if (!empty($burialSource)) {
            $ts = strtotime((string)$burialSource);
            if ($ts !== false) {
                $burialYear = (int)date('Y', $ts);
            }
        }

        $blockName = trim((string)($row['block_name'] ?? ''));
        $graveCode = $row['grave_code'] ?? null;
        $location  = $graveCode ?? '—';
        if ($blockName !== '') {
            $location = $blockName . ' — ' . ($graveCode ?? '—');
        }

        return [
            'interment_id'            => (int)($row['interment_id'] ?? 0),
            'control_number'          => $row['control_number'] ?? null,
            'deceased_name'           => $row['deceased_name'] ?? 'Unknown',
            'date_of_birth'           => $row['deceased_date_of_birth'] ?? null,
            'date_of_death'           => $row['deceased_date_of_death'] ?? null,
            'date_buried'             => $row['date_buried'] ?? null,
            'burial_year'             => $burialYear,
            'gender'                  => $row['deceased_sex'] ?? 'Unknown',
            'grave_code'              => $graveCode,
            'block_name'              => $row['block_name'] ?? null,
            'block_type'              => $row['block_type'] ?? null,
            'location'                => $location,
            'deceased_address'        => $row['last_known_address'] ?? null,
            'contact_person_name'     => $hasContact ? $contactName : null,
            'contact_person_phone'    => $row['contact_person_phone_number'] ?? null,
            'contact_person_email'    => $row['contact_person_email'] ?? null,
            'contact_person_barangay' => $row['contact_person_address_barangay'] ?? null,
            'contact_person_address'  => $row['contact_person_address'] ?? null,
            'has_contact_person'      => $hasContact,
            'lease_expiration_date'   => $row['lease_expiration_date'] ?? null,
            'status'                  => $row['status'] ?? 'Unknown',
            'remarks'                 => $row['interment_remarks'] ?? null,
        ];
    }, $rows);

    Response::success("Interment directory retrieved", [
        'filtered_by' => [
            'start_date' => $startDate,
            'end_date'   => $endDate,
            'genders'    => $genders,
            'barangays'  => $barangays,
        ],
        'rows'             => $mapped,
        'total_records'    => $total,
        'returned_records' => count($mapped),
        'pagination'       => rr_pagination_meta($page, $perPage, $total),
    ]);
}

function handle_graves(PDO $pdo): void
{
    $statuses = rr_enum_list(
        'status',
        ['Vacant', 'Occupied', 'Expiring', 'Expired', 'Reserved', 'Other']
    );
    [$page, $perPage, $offset] = rr_pagination();

    $params       = [];
    $whereClauses = [];

    if (!empty($statuses)) {
        $placeholders = [];
        foreach ($statuses as $i => $s) {
            $ph = ":status_" . $i;
            $placeholders[] = $ph;
            $params[$ph] = $s;
        }
        $whereClauses[] = "cg.category IN (" . implode(", ", $placeholders) . ")";
    }

    $whereSql = $whereClauses ? ('WHERE ' . implode(' AND ', $whereClauses)) : '';

    $countStmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM (" . rr_categorized_graves_sql() . ") AS cg
        {$whereSql}
    ");
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $sql = "
        SELECT
            cg.grave_id,
            cg.category,
            cg.min_exp_date,
            cg.has_active_reservation,
            cg.active_interments_count,
            g.grave_code,
            g.status AS raw_status,
            g.remarks,
            g.row_num,
            g.col_num,
            b.block_name,
            b.block_type,
            DATEDIFF(cg.min_exp_date, CURDATE()) AS days_until_expiration
        FROM (" . rr_categorized_graves_sql() . ") AS cg
        INNER JOIN graves g ON g.grave_id = cg.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON b.block_id = g.block_id AND b.deleted_at IS NULL
        {$whereSql}
        ORDER BY b.block_name ASC, g.grave_code ASC
        LIMIT {$perPage} OFFSET {$offset}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $mapped = array_map(static function (array $row): array {
        $days = $row['days_until_expiration'];
        return [
            'grave_id'                => (int)($row['grave_id'] ?? 0),
            'grave_code'              => $row['grave_code'] ?? 'N/A',
            'status'                  => $row['raw_status'] ?? 'Unknown',
            'category'                => $row['category'] ?? 'Other',
            'remarks'                 => $row['remarks'] ?? '',
            'row_num'                 => isset($row['row_num']) ? (int)$row['row_num'] : null,
            'col_num'                 => isset($row['col_num']) ? (int)$row['col_num'] : null,
            'block_name'              => $row['block_name'] ?? 'N/A',
            'block_type'              => $row['block_type'] ?? 'N/A',
            'min_lease_expiration'    => $row['min_exp_date'] ?? null,
            'days_until_expiration'   => ($days === null) ? null : (int)$days,
            'has_active_reservation'  => (bool)(int)($row['has_active_reservation'] ?? 0),
            'active_interments_count' => (int)($row['active_interments_count'] ?? 0),
        ];
    }, $rows);

    Response::success("Graves registry retrieved", [
        'filtered_by' => [
            'status' => $statuses,
        ],
        'rows'             => $mapped,
        'total_records'    => $total,
        'returned_records' => count($mapped),
        'pagination'       => rr_pagination_meta($page, $perPage, $total),
    ]);
}

function handle_payments(PDO $pdo): void
{
    $purpose   = rr_str('purpose');
    $channel   = rr_str('channel');
    $status    = rr_enum('status', ['pending', 'partial', 'confirmed']);
    $minamount = rr_float('minamount');
    $maxamount = rr_float('maxamount');
    $startDate = rr_iso_date('start_date');
    $endDate   = rr_iso_date('end_date');

    if ($minamount !== null && $maxamount !== null && $minamount > $maxamount) {
        Response::error("minamount cannot be greater than maxamount.", 400);
    }
    if ($startDate !== null && $endDate !== null && $startDate > $endDate) {
        Response::error("start_date must be before or equal to end_date.", 400);
    }

    $search    = rr_str('search');
    [$page, $perPage, $offset] = rr_pagination();

    $params       = [];
    $whereClauses = ["p.deleted_at IS NULL"];

    if ($purpose !== null) {
        $whereClauses[]     = "p.purpose = :purpose";
        $params[':purpose'] = $purpose;
    }
    if ($channel !== null) {
        $whereClauses[]     = "p.payment_channel = :channel";
        $params[':channel'] = $channel;
    }
    if ($status === 'pending') {
        $whereClauses[] = "p.confirmed_office_staff IS NULL AND p.confirmed_ground_staff IS NULL";
    } elseif ($status === 'partial') {
        $whereClauses[] = "(
            (p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NULL)
            OR (p.confirmed_office_staff IS NULL AND p.confirmed_ground_staff IS NOT NULL)
        )";
    } elseif ($status === 'confirmed') {
        $whereClauses[] = "p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NOT NULL";
    }

    if ($minamount !== null) {
        $whereClauses[]       = "p.amount >= :minamount";
        $params[':minamount'] = $minamount;
    }
    if ($maxamount !== null) {
        $whereClauses[]       = "p.amount <= :maxamount";
        $params[':maxamount'] = $maxamount;
    }

    // Date range on when the payment was recorded.
    // created_at is a DATETIME, so endDate must be extended to include
    // the full end day (00:00:00 through 23:59:59).
    if ($startDate !== null) {
        $whereClauses[]        = "p.created_at >= :start_date";
        $params[':start_date'] = $startDate . ' 00:00:00';
    }
    if ($endDate !== null) {
        $whereClauses[]                = "p.created_at < DATE_ADD(:end_date, INTERVAL 1 DAY)";
        $params[':end_date']           = $endDate;
    }

    if ($search !== null) {
        $whereClauses[] = "(
            p.reference_number LIKE :srch1
            OR p.payers_name LIKE :srch2
            OR p.deceased_name LIKE :srch3
            OR p.payers_email LIKE :srch4
            OR p.payers_phone_number LIKE :srch5
        )";
        $like = '%' . $search . '%';
        $params[':srch1'] = $like;
        $params[':srch2'] = $like;
        $params[':srch3'] = $like;
        $params[':srch4'] = $like;
        $params[':srch5'] = $like;
    }

    $whereSql = "WHERE " . implode(" AND ", $whereClauses);

    $summaryStmt = $pdo->prepare("
        SELECT
            COUNT(*) AS total_payments,
            COALESCE(SUM(p.amount), 0) AS total_amount,
            SUM(CASE WHEN p.confirmed_office_staff IS NULL AND p.confirmed_ground_staff IS NULL
                THEN 1 ELSE 0 END) AS pending_count,
            SUM(CASE
                WHEN (p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NULL)
                  OR (p.confirmed_office_staff IS NULL AND p.confirmed_ground_staff IS NOT NULL)
                THEN 1 ELSE 0 END) AS partial_count,
            SUM(CASE WHEN p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NOT NULL
                THEN 1 ELSE 0 END) AS confirmed_count
        FROM payments p
        {$whereSql}
    ");
    $summaryStmt->execute($params);
    $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $sql = "
        SELECT
            p.payment_id,
            p.reference_number,
            p.payment_channel,
            p.amount,
            p.purpose,
            p.deceased_name,
            p.payers_name,
            p.payers_phone_number,
            p.payers_email,
            p.remarks_payer,
            p.remarks_office,
            p.remarks_grounds,
            p.image_link,
            p.created_at,
            p.confirmed_office_staff,
            p.confirmed_ground_staff,
            uo.name AS office_confirmer_name,
            ug.name AS grounds_confirmer_name
        FROM payments p
        LEFT JOIN users uo ON uo.user_id = p.confirmed_office_staff
        LEFT JOIN users ug ON ug.user_id = p.confirmed_ground_staff
        {$whereSql}
        ORDER BY p.created_at DESC, p.payment_id DESC
        LIMIT {$perPage} OFFSET {$offset}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $mapped = array_map(static function (array $row): array {
        $officeId  = $row['confirmed_office_staff'] ?? null;
        $groundsId = $row['confirmed_ground_staff'] ?? null;

        if ($officeId !== null && $groundsId !== null) {
            $status = 'Confirmed';
        } elseif ($officeId !== null || $groundsId !== null) {
            $status = 'Partial';
        } else {
            $status = 'Pending';
        }

        return [
            'payment_id'             => (int)($row['payment_id'] ?? 0),
            'reference_number'       => $row['reference_number'] ?? null,
            'payment_channel'        => $row['payment_channel'] ?? null,
            'amount'                 => (float)($row['amount'] ?? 0),
            'purpose'                => $row['purpose'] ?? null,
            'deceased_name'          => $row['deceased_name'] ?? null,
            'payers_name'            => $row['payers_name'] ?? null,
            'payers_phone_number'    => $row['payers_phone_number'] ?? null,
            'payers_email'           => $row['payers_email'] ?? null,
            'status'                 => $status,
            'office_confirmer_name'  => $row['office_confirmer_name'] ?? null,
            'grounds_confirmer_name' => $row['grounds_confirmer_name'] ?? null,
            'remarks_payer'          => $row['remarks_payer'] ?? null,
            'remarks_office'         => $row['remarks_office'] ?? null,
            'remarks_grounds'        => $row['remarks_grounds'] ?? null,
            'has_image'              => !empty($row['image_link']),
            'created_at'             => $row['created_at'] ?? null,
        ];
    }, $rows);

    $total = (int)($summary['total_payments'] ?? 0);

    Response::success("Payment ledger retrieved", [
        'filtered_by' => [
            'start_date' => $startDate,
            'end_date'   => $endDate,
        ],
        'summary' => [
            'total_payments'  => $total,
            'total_amount'    => (float)($summary['total_amount'] ?? 0),
            'pending_count'   => (int)($summary['pending_count'] ?? 0),
            'partial_count'   => (int)($summary['partial_count'] ?? 0),
            'confirmed_count' => (int)($summary['confirmed_count'] ?? 0),
        ],
        'rows'             => $mapped,
        'total_records'    => $total,
        'returned_records' => count($mapped),
        'pagination'       => rr_pagination_meta($page, $perPage, $total),
    ]);
}

function handle_populate_filters(PDO $pdo): void
{
    $purposesStmt = $pdo->query("
        SELECT DISTINCT purpose
        FROM payments
        WHERE deleted_at IS NULL AND purpose IS NOT NULL AND purpose <> ''
        ORDER BY purpose ASC
    ");
    $purposes = [];
    foreach ($purposesStmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $p = trim((string)($r['purpose'] ?? ''));
        if ($p !== '') $purposes[] = $p;
    }

    $channelsStmt = $pdo->query("
        SELECT DISTINCT payment_channel
        FROM payments
        WHERE deleted_at IS NULL AND payment_channel IS NOT NULL AND payment_channel <> ''
        ORDER BY payment_channel ASC
    ");
    $channels = [];
    foreach ($channelsStmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $c = trim((string)($r['payment_channel'] ?? ''));
        if ($c !== '') $channels[] = $c;
    }

    $rangeStmt = $pdo->query("
        SELECT COALESCE(MIN(amount), 0) AS min_amt, COALESCE(MAX(amount), 0) AS max_amt
        FROM payments
        WHERE deleted_at IS NULL
    ");
    $rangeRow = $rangeStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $amountRange = [
        'min' => (float)($rangeRow['min_amt'] ?? 0),
        'max' => (float)($rangeRow['max_amt'] ?? 0),
    ];

    $yearsStmt = $pdo->query("
        SELECT DISTINCT YEAR(COALESCE(date_buried, deceased_date_of_death)) AS y
        FROM interments
        WHERE deleted_at IS NULL
          AND COALESCE(date_buried, deceased_date_of_death) IS NOT NULL
        ORDER BY y DESC
    ");
    $burialYears = [];
    foreach ($yearsStmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $y = (int)($r['y'] ?? 0);
        if ($y > 0) $burialYears[] = $y;
    }

    $currentYear = (int)date('Y');
    $leaseYearSet = $burialYears;
    for ($i = 0; $i <= 10; $i++) {
        $leaseYearSet[] = $currentYear + $i;
    }
    $leaseYearSet = array_values(array_unique($leaseYearSet));
    rsort($leaseYearSet);

    Response::success("Filter options retrieved", [
        'payments' => [
            'purposes' => $purposes,
            'channels' => $channels,
            'statuses' => [
                ['pending', 'partial', 'confirmed']
            ],
            'amount_range' => $amountRange,
        ],
        'interments' => [
            'years'    => $burialYears,
            'genders'  => ['Male', 'Female', 'Unknown'],
            'contacts' => ['no_contact', 'has_contact'],
        ],
        'graves' => [
            'categories' => ['Vacant', 'Occupied', 'Expiring', 'Expired', 'Reserved', 'Other'],
        ],
        'lease_expirations' => [
            'years' => $leaseYearSet,
        ],
    ]);
}

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim((string)$pathInfo, '/')));
$resourceId = array_shift($pathParts);
$resourceId = strtolower(trim((string)$resourceId));

if ($resourceId === '') {
    $resourceId = 'populate_filters';
}

$validResources = [
    'cemetery_capacity',
    'lease_expirations',
    'interments',
    'graves',
    'payments',
    'populate_filters',
];

if (!in_array($resourceId, $validResources, true)) {
    Response::error(
        "Unknown resource '$resourceId'. Allowed: " . implode(', ', $validResources),
        404
    );
}

try {
    switch ($resourceId) {
        case 'cemetery_capacity':
            handle_cemetery_capacity($pdo);
            break;
        case 'lease_expirations':
            handle_lease_expirations($pdo);
            break;
        case 'interments':
            handle_interments($pdo);
            break;
        case 'graves':
            handle_graves($pdo);
            break;
        case 'payments':
            handle_payments($pdo);
            break;
        case 'populate_filters':
            handle_populate_filters($pdo);
            break;
    }
} catch (Throwable $e) {
    systemlog("Report error ({$resourceId}): " . $e->getMessage());
    Response::error("Unable to generate report data. Please try again", 500);
}
