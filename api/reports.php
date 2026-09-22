<?php

declare(strict_types=1);

/**
 * reports.php — Cemetery report data provider.
 *
 * Supported reports:
 *   - capacity     : Overall cemetery occupancy summary + breakdown by block.
 *   - expirations  : Active interments with expired leases, and those expiring in N days.
 *   - graves       : All graves registry (filterable by status).
 *   - interments   : Interment directory (filterable by address, gender, year, contact).
 *   - years        : Distinct years present in interment data (for filter dropdowns).
 *
 * Stacked filters are passed as f[key]=value, e.g.:
 *   ?report=interments&f[address]=Tipolo&f[gender]=Male&f[year]=2025
 *
 * All reports exclude soft-deleted records (deleted_at IS NOT NULL).
 * Authentication required: only Admin and Office staff can access.
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method !== 'GET') {
    Response::error("Method not allowed", 405);
}

$userRole = $userData['role'] ?? null;
if (!in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Unauthorized access", 403);
}

/* -------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

if (!function_exists('report_normalize_enum')) {
    function report_normalize_enum(string $value, array $allowed): ?string
    {
        foreach ($allowed as $allowedValue) {
            if (strcasecmp($value, $allowedValue) === 0) {
                return $allowedValue;
            }
        }
        return null;
    }
}

if (!function_exists('report_int_get')) {
    function report_int_get(string $key, int $default, int $min, int $max): int
    {
        if (!isset($_GET[$key]) || $_GET[$key] === '') {
            return $default;
        }
        $value = filter_var($_GET[$key], FILTER_VALIDATE_INT);
        if ($value === false) {
            return $default;
        }
        return max($min, min($max, (int)$value));
    }
}

if (!function_exists('report_get_filters')) {
    /**
     * Reads $_GET['f'] (stacked filter array) and returns a clean
     * associative array containing only non-empty string values.
     * Values of '' and 'all' are dropped so the caller can treat
     * absence as "no filter for this dimension".
     */
    function report_get_filters(): array
    {
        $raw = $_GET['f'] ?? [];
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        foreach ($raw as $key => $value) {
            if (!is_string($key) || $key === '') {
                continue;
            }
            if (is_array($value)) {
                continue;
            }

            $clean = trim((string)$value);
            if ($clean === '' || strcasecmp($clean, 'all') === 0) {
                continue;
            }

            $out[$key] = $clean;
        }
        return $out;
    }
}

/* -------------------------------------------------------------------------
 * Request parsing
 * ------------------------------------------------------------------------- */

$report = strtolower(trim((string)($_GET['report'] ?? 'interments')));

$allowedReports = [
    'capacity',
    'expirations',
    'graves',
    'allgraves',
    'interment',
    'interments',
    'years',
    'payments',
    'payment_options',
];

if (!in_array($report, $allowedReports, true)) {
    Response::error("Invalid report type", 400);
}

// Legacy aliases — kept so old bookmarks don't break.
if ($report === 'allgraves') {
    $report = 'graves';
}
if ($report === 'interment') {
    $report = 'interments';
}

$filters        = report_get_filters();
$expirationDays = report_int_get('days', 30, 1, 365);
$offset         = report_int_get('offset', 0, 0, 1000000);

$limit = null;
if (isset($_GET['limit']) && $_GET['limit'] !== '') {
    $limit = report_int_get('limit', 100, 1, 1000);
}

$basePayload = [
    'report'       => $report,
    'generated_at' => date('c'),
    'filters'      => $filters,   // always an object — {} when no filters
];

/* -------------------------------------------------------------------------
 * Dispatch
 * ------------------------------------------------------------------------- */

try {
    switch ($report) {

        // =================================================================
        // 1. CAPACITY
        // =================================================================
        case 'capacity':
            $summaryStmt = $pdo->prepare("
                SELECT
                    COUNT(*) AS total_graves,
                    SUM(CASE WHEN status = 'Occupied' THEN 1 ELSE 0 END) AS occupied,
                    SUM(CASE WHEN status = 'Vacant' THEN 1 ELSE 0 END) AS vacant
                FROM graves
                WHERE deleted_at IS NULL
            ");
            $summaryStmt->execute();
            $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

            $blockStmt = $pdo->prepare("
                SELECT
                    b.block_id,
                    b.block_name,
                    b.block_type,
                    COUNT(g.grave_id) AS total_graves,
                    SUM(CASE WHEN g.status = 'Occupied' THEN 1 ELSE 0 END) AS occupied,
                    SUM(CASE WHEN g.status = 'Vacant' THEN 1 ELSE 0 END) AS vacant
                FROM blocks b
                LEFT JOIN graves g
                    ON g.block_id = b.block_id
                   AND g.deleted_at IS NULL
                WHERE b.deleted_at IS NULL
                GROUP BY b.block_id, b.block_name, b.block_type
                ORDER BY b.block_name ASC
            ");
            $blockStmt->execute();

            $byBlock = array_map(static function (array $row): array {
                return [
                    'block_id'     => (int)($row['block_id'] ?? 0),
                    'block_name'   => $row['block_name'] ?? 'N/A',
                    'block_type'   => $row['block_type'] ?? 'N/A',
                    'total_graves' => (int)($row['total_graves'] ?? 0),
                    'occupied'     => (int)($row['occupied'] ?? 0),
                    'vacant'       => (int)($row['vacant'] ?? 0),
                ];
            }, $blockStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

            $payload = $basePayload;
            $payload['summary'] = [
                'total_graves' => (int)($summary['total_graves'] ?? 0),
                'occupied'     => (int)($summary['occupied'] ?? 0),
                'vacant'       => (int)($summary['vacant'] ?? 0),
            ];
            $payload['by_block']      = $byBlock;
            $payload['total_records'] = count($byBlock);

            Response::success("Cemetery capacity summary retrieved", $payload);
            break;

        // =================================================================
        // 2. LEASE EXPIRATIONS
        // =================================================================
        case 'expirations':
            $basePayload['filters']['days'] = $expirationDays;

            $expiredStmt = $pdo->prepare("
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
                LEFT JOIN graves g
                    ON g.grave_id = i.current_grave_id
                   AND g.deleted_at IS NULL
                WHERE i.status = 'Active'
                  AND i.deleted_at IS NULL
                  AND i.lease_expiration_date IS NOT NULL
                  AND i.lease_expiration_date < CURDATE()
                ORDER BY i.lease_expiration_date ASC
            ");
            $expiredStmt->execute();

            // $expirationDays is a validated int (1–365), safe to interpolate.
            $expiringStmt = $pdo->prepare("
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
                LEFT JOIN graves g
                    ON g.grave_id = i.current_grave_id
                   AND g.deleted_at IS NULL
                WHERE i.status = 'Active'
                  AND i.deleted_at IS NULL
                  AND i.lease_expiration_date IS NOT NULL
                  AND i.lease_expiration_date BETWEEN CURDATE()
                      AND DATE_ADD(CURDATE(), INTERVAL {$expirationDays} DAY)
                ORDER BY i.lease_expiration_date ASC
            ");
            $expiringStmt->execute();

            $expired  = $expiredStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            $expiring = $expiringStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $payload = $basePayload;
            $payload['expired']       = $expired;
            $payload['expiring']      = $expiring;
            $payload['total_records'] = count($expired) + count($expiring);

            Response::success("Lease expiration report retrieved", $payload);
            break;

        // =================================================================
        // 3. DISTINCT YEARS
        // =================================================================
        case 'years':
            $yearsStmt = $pdo->prepare("
                SELECT DISTINCT
                    YEAR(COALESCE(date_buried, deceased_date_of_death)) AS y
                FROM interments
                WHERE deleted_at IS NULL
                  AND COALESCE(date_buried, deceased_date_of_death) IS NOT NULL
                ORDER BY y DESC
            ");
            $yearsStmt->execute();

            $years = array_values(array_filter(
                array_map(
                    static fn(array $r): int => (int)($r['y'] ?? 0),
                    $yearsStmt->fetchAll(PDO::FETCH_ASSOC) ?: []
                ),
                static fn(int $y): bool => $y > 0
            ));

            $payload = $basePayload;
            $payload['years']         = $years;
            $payload['total_records'] = count($years);

            Response::success("Available report years retrieved", $payload);
            break;

        // =================================================================
        // 4. ALL GRAVES REGISTRY
        // =================================================================
        case 'graves':
            $params       = [];
            $whereClauses = ["g.deleted_at IS NULL"];

            if (!empty($filters['status'])) {
                $status = report_normalize_enum($filters['status'], ['Vacant', 'Occupied']);
                if ($status === null) {
                    Response::error("Invalid status filter", 400);
                }
                $whereClauses[]    = "g.status = :status";
                $params[':status'] = $status;
            }

            $whereSql = "WHERE " . implode(" AND ", $whereClauses);

            $countStmt = $pdo->prepare("
                SELECT COUNT(*)
                FROM graves g
                {$whereSql}
            ");
            $countStmt->execute($params);
            $totalRecords = (int)$countStmt->fetchColumn();

            $sql = "
                SELECT
                    g.grave_id,
                    g.grave_code,
                    g.status,
                    g.remarks,
                    g.row_num,
                    g.col_num,
                    b.block_name,
                    b.block_type
                FROM graves g
                LEFT JOIN blocks b
                    ON b.block_id = g.block_id
                   AND b.deleted_at IS NULL
                {$whereSql}
                ORDER BY b.block_name ASC, g.grave_code ASC
            ";

            if ($limit !== null) {
                $sql .= " LIMIT {$limit} OFFSET {$offset}";
            }

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $payload = $basePayload;
            $payload['rows'] = array_map(static function (array $row): array {
                return [
                    'grave_id'   => (int)($row['grave_id'] ?? 0),
                    'grave_code' => $row['grave_code'] ?? 'N/A',
                    'status'     => $row['status'] ?? 'Unknown',
                    'remarks'    => $row['remarks'] ?? '',
                    'row_num'    => isset($row['row_num']) ? (int)$row['row_num'] : null,
                    'col_num'    => isset($row['col_num']) ? (int)$row['col_num'] : null,
                    'block_name' => $row['block_name'] ?? 'N/A',
                    'block_type' => $row['block_type'] ?? 'N/A',
                ];
            }, $rows);

            $payload['total_records']    = $totalRecords;
            $payload['returned_records'] = count($payload['rows']);

            if ($limit !== null) {
                $payload['pagination'] = [
                    'limit'    => $limit,
                    'offset'   => $offset,
                    'has_more' => ($offset + count($payload['rows'])) < $totalRecords,
                ];
            }

            Response::success("Graves registry retrieved", $payload);
            break;

        // =================================================================
        // 5. INTERMENT DIRECTORY
        // =================================================================
        case 'interments':
        default:
            $params       = [];
            $whereClauses = ["i.deleted_at IS NULL"];

            if (!empty($filters['address'])) {
                // PDO emulation is off — three distinct placeholders required.
                $whereClauses[] = "(
                    i.last_known_address LIKE :addr1
                    OR i.contact_person_address LIKE :addr2
                    OR i.contact_person_address_barangay LIKE :addr3
                )";
                $like = '%' . $filters['address'] . '%';
                $params[':addr1'] = $like;
                $params[':addr2'] = $like;
                $params[':addr3'] = $like;
            }

            if (!empty($filters['gender'])) {
                $gender = report_normalize_enum(
                    $filters['gender'],
                    ['Male', 'Female', 'Unknown']
                );
                if ($gender === null) {
                    Response::error("Invalid gender filter", 400);
                }
                $whereClauses[]    = "i.deceased_sex = :gender";
                $params[':gender'] = $gender;
            }

            if (!empty($filters['year'])) {
                if (!preg_match('/^\d{4}$/', (string)$filters['year'])) {
                    Response::error("Invalid year filter", 400);
                }
                $whereClauses[] = "
                    YEAR(COALESCE(i.date_buried, i.deceased_date_of_death)) = :year
                ";
                $params[':year'] = (int)$filters['year'];
            }

            if (!empty($filters['contact'])) {
                $c = strtolower($filters['contact']);
                if ($c === 'has') {
                    $whereClauses[] = "
                        (i.contact_person_name IS NOT NULL AND i.contact_person_name <> '')
                    ";
                } elseif ($c === 'none') {
                    $whereClauses[] = "
                        (i.contact_person_name IS NULL OR i.contact_person_name = '')
                    ";
                } else {
                    Response::error("Invalid contact filter", 400);
                }
            }

            $whereSql = "WHERE " . implode(" AND ", $whereClauses);

            $countStmt = $pdo->prepare("
                SELECT COUNT(*)
                FROM interments i
                {$whereSql}
            ");
            $countStmt->execute($params);
            $totalRecords = (int)$countStmt->fetchColumn();

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
                LEFT JOIN graves g
                    ON g.grave_id = i.current_grave_id
                   AND g.deleted_at IS NULL
                LEFT JOIN blocks b
                    ON b.block_id = g.block_id
                   AND b.deleted_at IS NULL
                {$whereSql}
                ORDER BY i.date_buried DESC, i.interment_id DESC
            ";

            if ($limit !== null) {
                $sql .= " LIMIT {$limit} OFFSET {$offset}";
            }

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $payload = $basePayload;
            $payload['rows'] = array_map(static function (array $row): array {
                $contactName = trim((string)($row['contact_person_name'] ?? ''));
                $hasContact  = ($contactName !== '');

                // Year-of-burial uses the same COALESCE as the year filter.
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

                $location = $graveCode ?? '—';
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

            $payload['total_records']    = $totalRecords;
            $payload['returned_records'] = count($payload['rows']);

            if ($limit !== null) {
                $payload['pagination'] = [
                    'limit'    => $limit,
                    'offset'   => $offset,
                    'has_more' => ($offset + count($payload['rows'])) < $totalRecords,
                ];
            }

            Response::success("Interment directory retrieved", $payload);
            break;

        // =================================================================
        // 6. PAYMENT LEDGER
        // =================================================================
        case 'payments':
            $params       = [];
            $whereClauses = ["p.deleted_at IS NULL"];

            // --- Purpose ---
            if (!empty($filters['purpose'])) {
                $whereClauses[]     = "p.purpose = :purpose";
                $params[':purpose'] = $filters['purpose'];
            }

            // --- Channel ---
            if (!empty($filters['channel'])) {
                $whereClauses[]     = "p.payment_channel = :channel";
                $params[':channel'] = $filters['channel'];
            }

            // --- Status (derived from the two confirmation columns) ---
            if (!empty($filters['status'])) {
                $status = strtolower($filters['status']);

                if ($status === 'pending') {
                    $whereClauses[] = "
                        p.confirmed_office_staff IS NULL
                        AND p.confirmed_ground_staff IS NULL
                    ";
                } elseif ($status === 'partial') {
                    $whereClauses[] = "(
                        (p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NULL)
                        OR (p.confirmed_office_staff IS NULL AND p.confirmed_ground_staff IS NOT NULL)
                    )";
                } elseif ($status === 'confirmed') {
                    $whereClauses[] = "
                        p.confirmed_office_staff IS NOT NULL
                        AND p.confirmed_ground_staff IS NOT NULL
                    ";
                } else {
                    Response::error("Invalid status filter", 400);
                }
            }

            // --- Amount range ---
            if (isset($filters['amount_min']) && $filters['amount_min'] !== '') {
                if (!is_numeric($filters['amount_min'])) {
                    Response::error("Invalid amount_min filter", 400);
                }
                $whereClauses[]        = "p.amount >= :amount_min";
                $params[':amount_min'] = (float)$filters['amount_min'];
            }
            if (isset($filters['amount_max']) && $filters['amount_max'] !== '') {
                if (!is_numeric($filters['amount_max'])) {
                    Response::error("Invalid amount_max filter", 400);
                }
                $whereClauses[]        = "p.amount <= :amount_max";
                $params[':amount_max'] = (float)$filters['amount_max'];
            }

            // --- Free search across payer / deceased / reference ---
            if (!empty($filters['search'])) {
                $whereClauses[] = "(
                    p.reference_number LIKE :srch1
                    OR p.payers_name LIKE :srch2
                    OR p.deceased_name LIKE :srch3
                    OR p.payers_email LIKE :srch4
                    OR p.payers_phone_number LIKE :srch5
                )";
                $like = '%' . $filters['search'] . '%';
                $params[':srch1'] = $like;
                $params[':srch2'] = $like;
                $params[':srch3'] = $like;
                $params[':srch4'] = $like;
                $params[':srch5'] = $like;
            }

            $whereSql = "WHERE " . implode(" AND ", $whereClauses);

            // --- Summary over the filtered set ---
            $summaryStmt = $pdo->prepare("
                SELECT
                    COUNT(*) AS total_payments,
                    COALESCE(SUM(p.amount), 0) AS total_amount,
                    SUM(CASE
                        WHEN p.confirmed_office_staff IS NULL
                         AND p.confirmed_ground_staff IS NULL
                        THEN 1 ELSE 0 END) AS pending_count,
                    SUM(CASE
                        WHEN (p.confirmed_office_staff IS NOT NULL AND p.confirmed_ground_staff IS NULL)
                          OR (p.confirmed_office_staff IS NULL AND p.confirmed_ground_staff IS NOT NULL)
                        THEN 1 ELSE 0 END) AS partial_count,
                    SUM(CASE
                        WHEN p.confirmed_office_staff IS NOT NULL
                         AND p.confirmed_ground_staff IS NOT NULL
                        THEN 1 ELSE 0 END) AS confirmed_count
                FROM payments p
                {$whereSql}
            ");
            $summaryStmt->execute($params);
            $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

            // --- Rows ---
            // NOTE: users may be soft-deleted, but their names should still
            // surface on historical payment rows — so no deleted_at filter here.
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
            ";

            if ($limit !== null) {
                $sql .= " LIMIT {$limit} OFFSET {$offset}";
            }

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $payload = $basePayload;
            $payload['summary'] = [
                'total_payments'  => (int)($summary['total_payments'] ?? 0),
                'total_amount'    => (float)($summary['total_amount'] ?? 0),
                'pending_count'   => (int)($summary['pending_count'] ?? 0),
                'partial_count'   => (int)($summary['partial_count'] ?? 0),
                'confirmed_count' => (int)($summary['confirmed_count'] ?? 0),
            ];
            $payload['rows'] = array_map(static function (array $row): array {
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

            $payload['total_records']    = (int)($summary['total_payments'] ?? 0);
            $payload['returned_records'] = count($payload['rows']);

            if ($limit !== null) {
                $payload['pagination'] = [
                    'limit'    => $limit,
                    'offset'   => $offset,
                    'has_more' => ($offset + count($payload['rows'])) < $payload['total_records'],
                ];
            }

            Response::success("Payment ledger retrieved", $payload);
            break;

        // =================================================================
        // 7. PAYMENT OPTIONS — distinct values for filter dropdowns
        // =================================================================
        case 'payment_options':
            $purposesStmt = $pdo->prepare("
                SELECT DISTINCT purpose
                FROM payments
                WHERE deleted_at IS NULL
                  AND purpose IS NOT NULL
                  AND purpose <> ''
                ORDER BY purpose ASC
            ");
            $purposesStmt->execute();
            $purposes = [];
            foreach ($purposesStmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $p = trim((string)($r['purpose'] ?? ''));
                if ($p !== '') $purposes[] = $p;
            }

            $channelsStmt = $pdo->prepare("
                SELECT DISTINCT payment_channel
                FROM payments
                WHERE deleted_at IS NULL
                  AND payment_channel IS NOT NULL
                  AND payment_channel <> ''
                ORDER BY payment_channel ASC
            ");
            $channelsStmt->execute();
            $channels = [];
            foreach ($channelsStmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $c = trim((string)($r['payment_channel'] ?? ''));
                if ($c !== '') $channels[] = $c;
            }

            $payload = $basePayload;
            $payload['purposes'] = $purposes;
            $payload['channels'] = $channels;

            Response::success("Payment filter options retrieved", $payload);
            break;
    }
} catch (Throwable $e) {
    error_log("Report Generation Error: " . $e->getMessage());
    Response::error("Unable to generate report data.", 500);
}
