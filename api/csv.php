<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logger.php';
require_once 'checkuser.php';

// CSV export and import for interments
$userData = checkuser();
if ($userData['role'] !== ROLE_ADMIN) {
    Response::error("Forbidden: Only administrators can access this resource", 403);
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';

// Request parameter helpers, mirror the reports API for consistency hehe
if (!function_exists('rr_str')) {
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
}

if (!function_exists('rr_int')) {
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
}

if (!function_exists('rr_enum')) {
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
}

if (!function_exists('rr_csv_list')) {
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
}

if (!function_exists('rr_enum_list')) {
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
}

if (!function_exists('rr_iso_date')) {
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
}

// Return null for empty or whitespace-only strings
function nonEmpty($value)
{
    if ($value === null) return null;
    $value = trim((string)$value);
    return $value === '' ? null : $value;
}

// Return a Y-m-d string from many accepted date formats, or null for empty input
function parseDate($value)
{
    $value = trim($value);
    if ($value === '' || strtolower($value) === 'null') {
        return null;
    }

    $formats = [
        'Y-m-d',
        'm/d/Y',
        'd/m/Y',
        'Y-m-d H:i:s',
        'Y-m-d H:i',
        'n/j/Y',
        'j/n/Y',
        'm-d-Y',
        'd-m-Y',
        'M d Y',
        'M d, Y',
        'd M Y',
    ];

    foreach ($formats as $format) {
        $date = DateTime::createFromFormat($format, $value);
        if ($date && $date->format($format) === $value) {
            return $date->format('Y-m-d');
        }
    }

    try {
        $date = new DateTime($value);
        return $date->format('Y-m-d');
    } catch (Exception $e) {
        // fall through
    }

    throw new Exception("Invalid date format: '$value' (expected Y-m-d or similar).");
}

// Return the grave_id matching a block_name + grave_code pair, or null
function getGraveId($pdo, $blockName, $graveCode)
{
    $sql = "SELECT g.grave_id
            FROM graves g
            JOIN blocks b ON g.block_id = b.block_id
            WHERE b.block_name = :block_name
              AND g.grave_code = :grave_code
              AND b.deleted_at IS NULL
              AND g.deleted_at IS NULL";
    $stmt = $pdo->prepare($sql);
    $stmt->execute(['block_name' => $blockName, 'grave_code' => $graveCode]);
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}

function syncGraveStatus($pdo, $graveId)
{
    if (empty($graveId)) return;

    $pdo->prepare("
        UPDATE graves g
        SET g.status = CASE
            WHEN EXISTS (
                SELECT 1
                FROM interments i
                WHERE i.current_grave_id = g.grave_id
                  AND i.status = 'Active'
                  AND i.deleted_at IS NULL
            ) THEN 'Occupied'
            ELSE 'Vacant'
        END
        WHERE g.grave_id = :gid
          AND g.deleted_at IS NULL
    ")->execute(['gid' => $graveId]);
}

/**
 * Filter reference for the CSV export (GET):
 *   status            Active,Inactive,Pending            (CSV list)
 *   gender            Male,Female,Unknown                (CSV list)
 *   block             block_name (exact)
 *   block_type        Niche,Bone Chamber,Lawn/Grounds,   (CSV list)
 *                     Unmapped Area,Private,Mausoleum,
 *                     Mass Grave,Cluster,Block
 *   barangay          partial match on contact barangay  (CSV list)
 *   address           partial match on any address col
 *   contact           has_contact | no_contact
 *   deceased_name     partial match
 *   control_number    partial match
 *   remarks           partial match
 *   assistance_type   Burial,Transfer the remains of the late,Other  (CSV list)
 *   start_date        YYYY-MM-DD (on COALESCE(date_buried, deceased_date_of_death))
 *   end_date          YYYY-MM-DD
 *   lease_status      expired,expiring,upcoming,unknown  (CSV list)
 *   days              0..365, default 30 — expiring window only
 *   has_reservation   yes | no (any Active reservation touches this interment)
 *   limit             1..1,000,000
 *
 * Build the WHERE clause / params shared by the count and select queries.
 * Keeps both queries in lockstep so totals always match.
 */
function buildExportWhere(array $filters): array
{
    $where  = ["i.deleted_at IS NULL"];
    $params = [];

    // Status list
    if (!empty($filters['statuses'])) {
        $phs = [];
        foreach ($filters['statuses'] as $idx => $s) {
            $ph = ":status_" . $idx;
            $phs[] = $ph;
            $params[$ph] = $s;
        }
        $where[] = "i.status IN (" . implode(', ', $phs) . ")";
    }

    // Gender list
    if (!empty($filters['genders'])) {
        $phs = [];
        foreach ($filters['genders'] as $idx => $g) {
            $ph = ":gender_" . $idx;
            $phs[] = $ph;
            $params[$ph] = $g;
        }
        $where[] = "i.deceased_sex IN (" . implode(', ', $phs) . ")";
    }

    // Date range — anchored on burial date, falling back to death date
    // (matches how the interments report behaves)
    if (!empty($filters['start_date'])) {
        $where[] = "COALESCE(i.date_buried, i.deceased_date_of_death) >= :start_date";
        $params[':start_date'] = $filters['start_date'];
    }
    if (!empty($filters['end_date'])) {
        $where[] = "COALESCE(i.date_buried, i.deceased_date_of_death) <= :end_date";
        $params[':end_date'] = $filters['end_date'];
    }

    // Free-text address (matches any of the address columns)
    if (!empty($filters['address'])) {
        $where[] = "(
            i.last_known_address LIKE :addr1
            OR i.contact_person_address LIKE :addr2
            OR i.contact_person_address_barangay LIKE :addr3
        )";
        $like = '%' . $filters['address'] . '%';
        $params[':addr1'] = $like;
        $params[':addr2'] = $like;
        $params[':addr3'] = $like;
    }

    // Barangay list (partial match each)
    if (!empty($filters['barangays'])) {
        $phrases = [];
        foreach ($filters['barangays'] as $idx => $b) {
            $ph = ":barangay_" . $idx;
            $params[$ph] = '%' . $b . '%';
            $phrases[] = "i.contact_person_address_barangay LIKE {$ph}";
        }
        $where[] = "(" . implode(" OR ", $phrases) . ")";
    }

    // Block name (exact)
    if (!empty($filters['block'])) {
        $where[] = "b.block_name = :block_name";
        $params[':block_name'] = $filters['block'];
    }

    // Block type list (Niche, Lawn/Grounds, etc.)
    if (!empty($filters['block_types'])) {
        $phs = [];
        foreach ($filters['block_types'] as $idx => $bt) {
            $ph = ":block_type_" . $idx;
            $phs[] = $ph;
            $params[$ph] = $bt;
        }
        $where[] = "b.block_type IN (" . implode(', ', $phs) . ")";
    }

    // Assistance type list
    if (!empty($filters['assistance_types'])) {
        $phs = [];
        foreach ($filters['assistance_types'] as $idx => $a) {
            $ph = ":assistance_" . $idx;
            $phs[] = $ph;
            $params[$ph] = $a;
        }
        $where[] = "i.assistance_type IN (" . implode(', ', $phs) . ")";
    }

    // Contact presence
    if (!empty($filters['contact'])) {
        if ($filters['contact'] === 'has_contact') {
            $where[] = "(i.contact_person_name IS NOT NULL AND i.contact_person_name <> '')";
        } elseif ($filters['contact'] === 'no_contact') {
            $where[] = "(i.contact_person_name IS NULL OR i.contact_person_name = '')";
        }
    }

    // Deceased name (partial)
    if (!empty($filters['deceased_name'])) {
        $where[] = "i.deceased_name LIKE :deceased_name_like";
        $params[':deceased_name_like'] = '%' . $filters['deceased_name'] . '%';
    }

    // Control number (partial)
    if (!empty($filters['control_number'])) {
        $where[] = "i.control_number LIKE :control_number_like";
        $params[':control_number_like'] = '%' . $filters['control_number'] . '%';
    }

    // Remarks (partial)
    if (!empty($filters['remarks'])) {
        $where[] = "i.remarks LIKE :remarks_like";
        $params[':remarks_like'] = '%' . $filters['remarks'] . '%';
    }

    // Lease status categories — mirrors the cemetery_capacity / lease_expirations
    // categorization so a filtered export matches what the dashboard shows.
    //   expired  = lease_expiration_date <= CURDATE()
    //   expiring = CURDATE() < lease_expiration_date <= CURDATE() + days
    //   upcoming = lease_expiration_date > CURDATE() + days
    //   unknown  = lease_expiration_date IS NULL
    if (!empty($filters['lease_statuses'])) {
        $days = isset($filters['days']) && $filters['days'] !== null
            ? (int)$filters['days']
            : 30;
        // Compute the cutoff in PHP so we never rely on INTERVAL placeholders
        $cutoff = date('Y-m-d', strtotime('+' . $days . ' days'));

        $clauses = [];
        foreach ($filters['lease_statuses'] as $status) {
            if ($status === 'expired') {
                $clauses[] = "(i.lease_expiration_date IS NOT NULL AND i.lease_expiration_date <= CURDATE())";
            } elseif ($status === 'expiring') {
                $clauses[] = "(i.lease_expiration_date IS NOT NULL AND i.lease_expiration_date > CURDATE() AND i.lease_expiration_date <= :lease_cutoff_expiring)";
                $params[':lease_cutoff_expiring'] = $cutoff;
            } elseif ($status === 'upcoming') {
                $clauses[] = "(i.lease_expiration_date IS NOT NULL AND i.lease_expiration_date > :lease_cutoff_upcoming)";
                $params[':lease_cutoff_upcoming'] = $cutoff;
            } elseif ($status === 'unknown') {
                $clauses[] = "i.lease_expiration_date IS NULL";
            }
        }
        if ($clauses) {
            $where[] = "(" . implode(" OR ", $clauses) . ")";
        }
    }

    // Reservation involvement (mirrors reports.php's has_active_reservation idea,
    // but applied at the interment level: does any Active reservation reference
    // this interment as either incoming person or old occupant?)
    if (!empty($filters['has_reservation'])) {
        $exists = "EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.reservation_state = 'Active'
              AND (r.pending_interment_id = i.interment_id
                   OR r.old_interment_id = i.interment_id)
        )";
        if ($filters['has_reservation'] === 'yes') {
            $where[] = $exists;
        } elseif ($filters['has_reservation'] === 'no') {
            $where[] = "NOT " . $exists;
        }
    }

    return ["WHERE " . implode(" AND ", $where), $params];
}

// Stream interments as a CSV download.
// $filters keys: statuses[], genders[], start_date, end_date, address,
//   barangays[], block, block_types[], assistance_types[], contact,
//   deceased_name, control_number, remarks, lease_statuses[], days,
//   has_reservation, limit
function exportInterments($pdo, array $filters = [], $filename = 'interments_export.csv')
{
    [$whereSql, $params] = buildExportWhere($filters);

    // Count first so we can set headers / short-circuit before streaming
    $countStmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        {$whereSql}
    ");
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    if ($total === 0) {
        $noFilters = empty(array_filter([
            $filters['statuses']         ?? null,
            $filters['genders']          ?? null,
            $filters['start_date']       ?? null,
            $filters['end_date']         ?? null,
            $filters['address']          ?? null,
            $filters['barangays']        ?? null,
            $filters['block']            ?? null,
            $filters['block_types']      ?? null,
            $filters['assistance_types'] ?? null,
            $filters['contact']          ?? null,
            $filters['deceased_name']    ?? null,
            $filters['control_number']   ?? null,
            $filters['remarks']          ?? null,
            $filters['lease_statuses']   ?? null,
            $filters['has_reservation']  ?? null,
        ]));
        Response::success(
            $noFilters
                ? "Looks like the database is empty."
                : "No records match the selected filters."
        );
        exit;
    }

    $limit    = !empty($filters['limit']) ? (int)$filters['limit'] : null;
    $exported = ($limit !== null) ? min($limit, $total) : $total;

    $sql = "
        SELECT
            i.control_number,
            i.deceased_name,
            i.last_known_address,
            i.death_certificate,
            i.deceased_date_of_birth,
            i.deceased_date_of_death,
            i.deceased_sex,
            b.block_name,
            g.grave_code,
            g.row_num,
            g.col_num,
            i.contact_person_name,
            i.contact_person_phone_number,
            i.contact_person_email,
            i.contact_person_address_barangay,
            i.contact_person_address,
            i.assistance_type,
            i.burial_permit_number,
            i.burial_permit_date,
            i.transfer_permit_number,
            i.transfer_permit_issued_by,
            i.transfer_permit_date,
            i.exhumation_permit_number,
            i.exhumation_permit_date,
            i.date_buried,
            i.date_exhumed,
            i.burial_clearance_date,
            i.lease_expiration_date,
            i.status,
            i.remarks
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        {$whereSql}
        ORDER BY i.interment_id
    ";
    if ($limit !== null) {
        $sql .= " LIMIT " . $limit;
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('X-Total-Records: ' . $total);
    header('X-Exported-Records: ' . $exported);
    if ($limit !== null && $total > $limit) {
        header('X-Truncated: 1');
    }

    $output = fopen('php://output', 'w');
    if (count($rows) > 0) {
        fputcsv($output, array_keys($rows[0]), ',', '"', '\\');
    }
    foreach ($rows as $row) {
        $row = array_map(function ($val) {
            return $val === null ? '' : $val;
        }, $row);
        fputcsv($output, $row, ',', '"', '\\');
    }
    fclose($output);
}

// Import interments from a CSV file, using savepoints so one bad row doesn't kill the batch
function importInterments($pdo, $filePath, $userId)
{
    $validStatuses   = ['Pending', 'Active', 'Inactive'];
    $validAssistance = ['Burial', 'Transfer the remains of the late', 'Other'];
    $validSex        = ['Male', 'Female', 'Unknown'];

    $errors   = [];   // fatal, row is skipped
    $warnings = [];   // non-fatal, row is saved with a caveat
    $inserted = 0;
    $updated  = 0;
    $skipped  = 0;
    $rowCount = 0;

    // Track duplicate control_numbers inside this file
    $seenControls = [];

    $handle = fopen($filePath, 'r');
    if ($handle === false) {
        throw new Exception("Could not open the uploaded file.");
    }

    // Skip the UTF-8 BOM if the file starts with one
    $bom = fread($handle, 3);
    if ($bom !== "\xEF\xBB\xBF") {
        rewind($handle);
    }

    $header = fgetcsv($handle, 0, ',', '"', '\\');
    if ($header === false) {
        fclose($handle);
        throw new Exception("The CSV file is empty or has no header row.");
    }
    $header = array_map('trim', $header);

    $expected = [
        'control_number',
        'deceased_name',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'deceased_sex',
        'block_name',
        'grave_code',
        'row_num',
        'col_num',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'contact_person_address_barangay',
        'contact_person_address',
        'assistance_type',
        'burial_permit_number',
        'burial_permit_date',
        'transfer_permit_number',
        'transfer_permit_issued_by',
        'transfer_permit_date',
        'exhumation_permit_number',
        'exhumation_permit_date',
        'date_buried',
        'date_exhumed',
        'burial_clearance_date',
        'lease_expiration_date',
        'status',
        'remarks',
    ];

    if (array_map('strtolower', $header) !== array_map('strtolower', $expected)) {
        fclose($handle);
        throw new Exception(
            "CSV header does not match the expected format.\n" .
                "Expected columns: " . implode(', ', $expected) . "\n" .
                "Found columns:    " . implode(', ', $header)
        );
    }

    $headerCount = count($header);

    try {
        $pdo->beginTransaction();

        $reservedInterments = [];
        $resStmt = $pdo->query("
            SELECT reservation_id, pending_interment_id, old_interment_id
            FROM reservations
            WHERE reservation_state = 'Active'
        ");
        while ($r = $resStmt->fetch(PDO::FETCH_ASSOC)) {
            if (!empty($r['pending_interment_id'])) {
                $reservedInterments[(int)$r['pending_interment_id']] = [
                    'reservation_id' => (int)$r['reservation_id'],
                    'role'           => 'incoming person',
                ];
            }
            if (!empty($r['old_interment_id'])) {
                $reservedInterments[(int)$r['old_interment_id']] = [
                    'reservation_id' => (int)$r['reservation_id'],
                    'role'           => 'old occupant',
                ];
            }
        }

        while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false) {
            // Skip fully empty rows
            if (!is_array($row) || empty(array_filter($row, fn($v) => trim((string)$v) !== ''))) {
                continue;
            }

            $rowCount++;
            $lineNum = $rowCount;

            // Pad or trim the row so it lines up with the header
            $row = array_map(fn($v) => is_string($v) ? trim($v) : $v, $row);
            if (count($row) < $headerCount) {
                $row = array_pad($row, $headerCount, '');
            } elseif (count($row) > $headerCount) {
                $row = array_slice($row, 0, $headerCount);
            }
            $data = array_combine($header, $row);

            $pdo->exec("SAVEPOINT import_row");

            try {
                $controlNumber = trim((string)($data['control_number'] ?? ''));
                $deceasedName  = trim((string)($data['deceased_name'] ?? ''));

                if ($controlNumber === '' || $deceasedName === '') {
                    $missing = [];
                    if ($controlNumber === '') $missing[] = 'control_number';
                    if ($deceasedName === '')  $missing[] = 'deceased_name';
                    throw new Exception(
                        "Missing required field(s): " . implode(', ', $missing) . "."
                    );
                }

                if (isset($seenControls[$controlNumber])) {
                    throw new Exception(
                        "Duplicate control_number '$controlNumber' in this file " .
                            "(already used on line {$seenControls[$controlNumber]})."
                    );
                }

                // Grave is only linked when both block_name and grave_code are given
                $graveId              = null;
                $blockName            = trim((string)($data['block_name'] ?? ''));
                $graveCode            = trim((string)($data['grave_code'] ?? ''));
                $graveProvided        = ($blockName !== '' && $graveCode !== '');
                $graveProvidedPartial = ($blockName !== '' || $graveCode !== '');

                if ($graveProvided) {
                    $graveId = getGraveId($pdo, $blockName, $graveCode);
                    if (!$graveId) {
                        $warnings[] = "Line $lineNum: grave not found for block " .
                            "'$blockName' and code '$graveCode'. " .
                            "Saved without a grave.";
                    }
                } elseif ($graveProvidedPartial) {
                    $warnings[] = "Line $lineNum: block_name and grave_code must " .
                        "both be filled to link a grave. Saved without a grave.";
                }

                $graveResolved = ($graveId !== null);

                // Wrap parseDate so the error names the offending column
                $parseCol = function ($value, $column) {
                    try {
                        return parseDate($value ?? '');
                    } catch (Exception $e) {
                        throw new Exception("$column: " . $e->getMessage());
                    }
                };

                $deceasedDob          = $parseCol($data['deceased_date_of_birth'] ?? '', 'deceased_date_of_birth');
                $deceasedDod          = $parseCol($data['deceased_date_of_death'] ?? '', 'deceased_date_of_death');
                $burialPermitDate     = $parseCol($data['burial_permit_date'] ?? '', 'burial_permit_date');
                $transferPermitDate   = $parseCol($data['transfer_permit_date'] ?? '', 'transfer_permit_date');
                $exhumationPermitDate = $parseCol($data['exhumation_permit_date'] ?? '', 'exhumation_permit_date');
                $dateBuried           = $parseCol($data['date_buried'] ?? '', 'date_buried');
                $dateExhumed          = $parseCol($data['date_exhumed'] ?? '', 'date_exhumed');
                $burialClearance      = $parseCol($data['burial_clearance_date'] ?? '', 'burial_clearance_date');
                $leaseExpiration      = $parseCol($data['lease_expiration_date'] ?? '', 'lease_expiration_date');

                // Keep raw cells so merge-update can tell "not set" from "set to default"
                $statusCell     = trim((string)($data['status'] ?? ''));
                $sexCell        = trim((string)($data['deceased_sex'] ?? ''));
                $assistanceCell = trim((string)($data['assistance_type'] ?? ''));

                $status         = $statusCell ?: 'Pending';
                $sex            = $sexCell ?: 'Unknown';
                $assistanceType = $assistanceCell ?: 'Burial';

                if (!in_array($status, $validStatuses, true)) {
                    throw new Exception(
                        "invalid status '$status'. Allowed: " .
                            implode(', ', $validStatuses) . "."
                    );
                }
                if (!in_array($assistanceType, $validAssistance, true)) {
                    throw new Exception(
                        "invalid assistance_type '$assistanceType'. Allowed: " .
                            implode(', ', $validAssistance) . "."
                    );
                }
                if (!in_array($sex, $validSex, true)) {
                    throw new Exception(
                        "invalid deceased_sex '$sex'. Allowed: " .
                            implode(', ', $validSex) . "."
                    );
                }

                // Pending rows come from the reservation flow, never from CSV
                if ($status === 'Pending') {
                    throw new Exception(
                        "status 'Pending' cannot be imported via CSV. " .
                            "Pending rows are created via Reserve."
                    );
                }

                // Non-Active rows can't have a grave (CHECK constraint), so drop it and warn
                if ($status !== 'Active' && $graveId !== null) {
                    $warnings[] = "Line $lineNum: status '$status' cannot have a grave; " .
                        "ignored block '$blockName' / code '$graveCode'.";
                    $graveId       = null;
                    $graveResolved = false;
                }

                // Warn when another Active interment already uses this grave
                if ($graveId && $status === 'Active') {
                    $conflictStmt = $pdo->prepare("
                        SELECT control_number, deceased_name
                        FROM interments
                        WHERE current_grave_id = :gid
                          AND status = 'Active'
                          AND deleted_at IS NULL
                          AND control_number <> :cn
                        LIMIT 1
                    ");
                    $conflictStmt->execute(['gid' => $graveId, 'cn' => $controlNumber]);
                    $conflict = $conflictStmt->fetch(PDO::FETCH_ASSOC);
                    if ($conflict) {
                        $warnings[] = "Line $lineNum: grave '$blockName / $graveCode' " .
                            "is already occupied by active interment " .
                            "({$conflict['control_number']} — {$conflict['deceased_name']}). " .
                            "Both will be marked Active on this grave.";
                    }
                }

                // null means the CSV cell was empty, so merge keeps the DB value
                $insertParams = [
                    'control_number'                  => $controlNumber,
                    'deceased_name'                   => $deceasedName,
                    'last_known_address'              => nonEmpty($data['last_known_address'] ?? null),
                    'death_certificate'               => nonEmpty($data['death_certificate'] ?? null),
                    'deceased_date_of_birth'          => $deceasedDob,
                    'deceased_date_of_death'          => $deceasedDod,
                    'deceased_sex'                    => $sex,
                    'current_grave_id'                => $graveId,
                    'contact_person_name'             => nonEmpty($data['contact_person_name'] ?? null),
                    'contact_person_phone_number'     => nonEmpty($data['contact_person_phone_number'] ?? null),
                    'contact_person_email'            => nonEmpty($data['contact_person_email'] ?? null),
                    'contact_person_address_barangay' => nonEmpty($data['contact_person_address_barangay'] ?? null),
                    'contact_person_address'          => nonEmpty($data['contact_person_address'] ?? null),
                    'assistance_type'                 => $assistanceType,
                    'burial_permit_number'            => nonEmpty($data['burial_permit_number'] ?? null),
                    'burial_permit_date'              => $burialPermitDate,
                    'transfer_permit_number'          => nonEmpty($data['transfer_permit_number'] ?? null),
                    'transfer_permit_issued_by'       => nonEmpty($data['transfer_permit_issued_by'] ?? null),
                    'transfer_permit_date'            => $transferPermitDate,
                    'exhumation_permit_number'        => nonEmpty($data['exhumation_permit_number'] ?? null),
                    'exhumation_permit_date'          => $exhumationPermitDate,
                    'date_buried'                     => $dateBuried,
                    'date_exhumed'                    => $dateExhumed,
                    'burial_clearance_date'           => $burialClearance,
                    'lease_expiration_date'           => $leaseExpiration,
                    'status'                          => $status,
                    'remarks'                         => nonEmpty($data['remarks'] ?? null),
                ];

                // Prefer the live row over a soft-deleted one so LIMIT 1 never picks the dead copy
                $checkStmt = $pdo->prepare("
                    SELECT interment_id, current_grave_id, status, deleted_at
                    FROM interments
                    WHERE control_number = :cn
                    ORDER BY (deleted_at IS NULL) DESC, interment_id ASC
                    LIMIT 1
                ");
                $checkStmt->execute(['cn' => $controlNumber]);
                $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);

                if ($existing) {
                    // Empty CSV cells keep the DB value, non-empty ones overwrite it
                    // Soft-deleted rows are restored first, then merged with the same rule
                    if (!empty($existing['deleted_at'])) {
                        $warnings[] = "Line $lineNum: control_number '$controlNumber' " .
                            "was soft-deleted and has been restored.";
                    }

                    // Active reservations may not expect a full replace, so just warn
                    $existingId = (int)$existing['interment_id'];
                    if (isset($reservedInterments[$existingId])) {
                        $r = $reservedInterments[$existingId];
                        $warnings[] = "Line $lineNum: this interment is referenced by " .
                            "Active reservation #{$r['reservation_id']} as the {$r['role']}. " .
                            "Updating it may conflict with the reservation when confirmed.";
                    }

                    $setClauses = [
                        'deceased_name = :deceased_name',
                        'status = :status',
                        'updated_at = NOW()',
                        'updated_by = :updated_by',
                        'deleted_at = NULL',
                    ];
                    $mergeParams = [
                        'control_number' => $controlNumber,
                        'deceased_name'  => $deceasedName,
                        'status'         => $status,
                        'updated_by'     => $userId,
                    ];

                    // Text fields: null means "CSV cell was empty", so skip it
                    $textMergeFields = [
                        'last_known_address',
                        'death_certificate',
                        'contact_person_name',
                        'contact_person_phone_number',
                        'contact_person_email',
                        'contact_person_address_barangay',
                        'contact_person_address',
                        'burial_permit_number',
                        'transfer_permit_number',
                        'transfer_permit_issued_by',
                        'exhumation_permit_number',
                        'remarks',
                    ];
                    foreach ($textMergeFields as $field) {
                        $value = $insertParams[$field];
                        if ($value !== null) {
                            $setClauses[] = "$field = :$field";
                            $mergeParams[$field] = $value;
                        }
                    }

                    // Date fields: null means "CSV cell was empty", so skip it
                    $dateMergeFields = [
                        'deceased_date_of_birth',
                        'deceased_date_of_death',
                        'burial_permit_date',
                        'transfer_permit_date',
                        'exhumation_permit_date',
                        'date_buried',
                        'date_exhumed',
                        'burial_clearance_date',
                        'lease_expiration_date',
                    ];
                    foreach ($dateMergeFields as $field) {
                        $value = $insertParams[$field];
                        if ($value !== null) {
                            $setClauses[] = "$field = :$field";
                            $mergeParams[$field] = $value;
                        }
                    }

                    // Enum fields: empty raw cell means keep the existing value
                    if ($sexCell !== '') {
                        $setClauses[] = "deceased_sex = :deceased_sex";
                        $mergeParams['deceased_sex'] = $sexCell;
                    }
                    if ($assistanceCell !== '') {
                        $setClauses[] = "assistance_type = :assistance_type";
                        $mergeParams['assistance_type'] = $assistanceCell;
                    }

                    // chk_status_grave: non-Active forces NULL, so only set the grave when resolved
                    if ($status !== 'Active') {
                        $setClauses[] = "current_grave_id = :current_grave_id";
                        $mergeParams['current_grave_id'] = null;
                    } elseif ($graveResolved) {
                        $setClauses[] = "current_grave_id = :current_grave_id";
                        $mergeParams['current_grave_id'] = $graveId;
                    }

                    $sql = "UPDATE interments SET "
                        . implode(', ', $setClauses)
                        . " WHERE control_number = :control_number";
                    $pdo->prepare($sql)->execute($mergeParams);

                    // Sync both old and new graves (either may be null)
                    syncGraveStatus($pdo, $existing['current_grave_id']);
                    syncGraveStatus($pdo, $graveId);

                    $updated++;
                } else {
                    $insertParams['created_by'] = $userId;
                    $insertParams['updated_by'] = $userId;

                    $pdo->prepare("
                        INSERT INTO interments (
                            control_number, deceased_name, last_known_address,
                            death_certificate, deceased_date_of_birth, deceased_date_of_death,
                            deceased_sex, current_grave_id, contact_person_name,
                            contact_person_phone_number, contact_person_email,
                            contact_person_address_barangay, contact_person_address,
                            assistance_type, burial_permit_number, burial_permit_date,
                            transfer_permit_number, transfer_permit_issued_by,
                            transfer_permit_date, exhumation_permit_number,
                            exhumation_permit_date, date_buried, date_exhumed,
                            burial_clearance_date, lease_expiration_date,
                            status, remarks, created_at, updated_at, created_by, updated_by
                        ) VALUES (
                            :control_number, :deceased_name, :last_known_address,
                            :death_certificate, :deceased_date_of_birth, :deceased_date_of_death,
                            :deceased_sex, :current_grave_id, :contact_person_name,
                            :contact_person_phone_number, :contact_person_email,
                            :contact_person_address_barangay, :contact_person_address,
                            :assistance_type, :burial_permit_number, :burial_permit_date,
                            :transfer_permit_number, :transfer_permit_issued_by,
                            :transfer_permit_date, :exhumation_permit_number,
                            :exhumation_permit_date, :date_buried, :date_exhumed,
                            :burial_clearance_date, :lease_expiration_date,
                            :status, :remarks, NOW(), NOW(), :created_by, :updated_by
                        )
                    ")->execute($insertParams);

                    syncGraveStatus($pdo, $graveId);
                    $inserted++;
                }

                // Mark this control_number as used only after the row saved
                $seenControls[$controlNumber] = $lineNum;

                $pdo->exec("RELEASE SAVEPOINT import_row");
            } catch (Exception $rowEx) {
                $pdo->exec("ROLLBACK TO SAVEPOINT import_row");
                $pdo->exec("RELEASE SAVEPOINT import_row");
                $errors[] = "Line $lineNum: " . $rowEx->getMessage();
                $skipped++;
            }
        }

        fclose($handle);
        $pdo->commit();

        return [
            'total_rows' => $rowCount,
            'inserted'   => $inserted,
            'updated'    => $updated,
            'skipped'    => $skipped,
            'warnings'   => $warnings,
            'errors'     => $errors,
        ];
    } catch (Exception $e) {
        if (is_resource($handle)) fclose($handle);
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

// GET  = export (with optional filters)
if ($method === 'GET') {
    // Parse filters
    $statuses  = rr_enum_list('status', ['Active', 'Inactive', 'Pending']);
    $genders   = rr_enum_list('gender', ['Male', 'Female', 'Unknown']);
    $startDate = rr_iso_date('start_date');
    $endDate   = rr_iso_date('end_date');
    $address   = rr_str('address');
    $barangays = rr_csv_list('barangay');
    $blockName = rr_str('block');
    $blockTypes      = rr_enum_list('block_type', [
        'Niche',
        'Bone Chamber',
        'Lawn/Grounds',
        'Unmapped Area',
        'Private',
        'Mausoleum',
        'Mass Grave',
        'Cluster',
        'Block',
    ]);
    $assistanceTypes = rr_enum_list('assistance_type', [
        'Burial',
        'Transfer the remains of the late',
        'Other',
    ]);
    $contact   = rr_enum('contact', ['has_contact', 'no_contact']);
    $deceasedName   = rr_str('deceased_name');
    $controlNumber  = rr_str('control_number');
    $remarks        = rr_str('remarks');
    $leaseStatuses  = rr_enum_list('lease_status', ['expired', 'expiring', 'upcoming', 'unknown']);
    $days           = rr_int('days', 30, 0, 365);
    $hasReservation = rr_enum('has_reservation', ['yes', 'no']);
    $limit          = rr_int('limit', null, 1, 1000000);

    if ($startDate !== null && $endDate !== null && $startDate > $endDate) {
        Response::error("start_date must be before or equal to end_date.", 400);
    }

    $filters = [
        'statuses'         => $statuses,
        'genders'          => $genders,
        'start_date'       => $startDate,
        'end_date'         => $endDate,
        'address'          => $address,
        'barangays'        => $barangays,
        'block'            => $blockName,
        'block_types'      => $blockTypes,
        'assistance_types' => $assistanceTypes,
        'contact'          => $contact,
        'deceased_name'    => $deceasedName,
        'control_number'   => $controlNumber,
        'remarks'          => $remarks,
        'lease_statuses'   => $leaseStatuses,
        'days'             => $days,
        'has_reservation'  => $hasReservation,
        'limit'            => $limit,
    ];

    $now = new DateTime('now', new DateTimeZone(DB_TIMEZONE));

    $exportFilename = 'memoria_interments_export_'
        . $now->format('Y-m-d_H-i-s-A')
        . '.csv';

    exportInterments($pdo, $filters, $exportFilename);

    // Build a readable filter summary for the audit log
    $parts = [];
    if ($statuses)         $parts[] = 'status=' . implode('|', $statuses);
    if ($genders)          $parts[] = 'gender=' . implode('|', $genders);
    if ($startDate)        $parts[] = 'start=' . $startDate;
    if ($endDate)          $parts[] = 'end=' . $endDate;
    if ($address)          $parts[] = 'address=' . $address;
    if ($barangays)        $parts[] = 'barangay=' . implode('|', $barangays);
    if ($blockName)        $parts[] = 'block=' . $blockName;
    if ($blockTypes)       $parts[] = 'block_type=' . implode('|', $blockTypes);
    if ($assistanceTypes)  $parts[] = 'assistance_type=' . implode('|', $assistanceTypes);
    if ($contact)          $parts[] = 'contact=' . $contact;
    if ($deceasedName)     $parts[] = 'deceased_name=' . $deceasedName;
    if ($controlNumber)    $parts[] = 'control_number=' . $controlNumber;
    if ($remarks)          $parts[] = 'remarks=' . $remarks;
    if ($leaseStatuses)    $parts[] = 'lease_status=' . implode('|', $leaseStatuses);
    if ($leaseStatuses && $days !== 30) $parts[] = 'days=' . $days;
    if ($hasReservation)   $parts[] = 'has_reservation=' . $hasReservation;
    if ($limit)            $parts[] = 'limit=' . $limit;

    $filtersLog = $parts ? ' [' . implode(', ', $parts) . ']' : ' [no filters]';

    systemLog(
        "{$userData['name']} ({$userData['username']}) exported a csv file{$filtersLog}",
        $userData['user_id']
    );
    exit;
}

// POST = import
if ($method === 'POST') {
    if (!isset($_FILES['csv_file']) || $_FILES['csv_file']['error'] !== UPLOAD_ERR_OK) {
        Response::error("No valid CSV file uploaded.", 400);
        exit;
    }

    $file = $_FILES['csv_file'];
    $tmpPath = $file['tmp_name'];
    $originalName = $file['name'];

    $maxSize = 100 * 1024 * 1024; // 100MB
    if ($file['size'] > $maxSize || $file['size'] === 0) {
        Response::error("Invalid file size.", 400);
        exit;
    }

    $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if ($extension !== 'csv') {
        Response::error("Only CSV files are allowed.", 400);
        exit;
    }

    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $detectedMime = $finfo->file($tmpPath);
    $allowedMimes = ['text/plain', 'text/csv', 'application/vnd.ms-excel'];
    if (!in_array($detectedMime, $allowedMimes, true)) {
        Response::error("File type not permitted.", 400);
        exit;
    }

    // Peek at the first few rows to make sure the file is really CSV-shaped
    $handle = fopen($tmpPath, 'r');
    if ($handle === false) {
        Response::error("Cannot read file.", 500);
        exit;
    }

    $rowCount = 0;
    $validRows = 0;
    while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false && $rowCount < 10) {
        $rowCount++;
        if (is_array($row) && count($row) > 0) $validRows++;
    }
    fclose($handle);

    if ($validRows === 0) {
        Response::error("File does not appear to be a valid CSV.", 400);
        exit;
    }

    // GET_LOCK is server-wide and auto-released on disconnect, so a crashed worker can't stick it
    // 30s timeout means a second import waits briefly, then gets a clean 409
    $lockAcquired = (int) $pdo->query("SELECT GET_LOCK('csv_import', 30)")->fetchColumn();
    if ($lockAcquired !== 1) {
        Response::error(
            "Another CSV import is already in progress. Please try again in a moment.",
            409
        );
        exit;
    }

    try {
        $result = importInterments($pdo, $tmpPath, $userData['user_id']);

        systemLog(
            "CSV import finished. Inserted: {$result['inserted']}, " .
                "Updated: {$result['updated']}, Skipped: {$result['skipped']}, " .
                "Warnings: " . count($result['warnings']) . ", " .
                "Errors: " . count($result['errors']),
            $userData['user_id']
        );

        // Short toast summary the frontend can show as-is
        $summary = "Import finished. " .
            "Inserted: {$result['inserted']}, " .
            "Updated: {$result['updated']}, " .
            "Skipped: {$result['skipped']} of {$result['total_rows']} row(s).";

        if (!empty($result['warnings'])) {
            $summary .= " " . count($result['warnings']) . " warning(s).";
        }
        if (!empty($result['errors'])) {
            $summary .= " " . count($result['errors']) . " error(s).";
        }

        // Flags so the frontend can colour the result red or amber
        $result['has_errors']   = !empty($result['errors']);
        $result['has_warnings'] = !empty($result['warnings']);

        Response::success($summary, $result);
    } catch (Exception $e) {
        systemLog("CSV import error: " . $e->getMessage(), $userData['user_id']);
        Response::error("Import error: " . $e->getMessage(), 500);
    } finally {
        // Release in finally so a crash can't leave the import lock behind
        $pdo->query("SELECT RELEASE_LOCK('csv_import')");
    }
    exit;
}

// Neither GET nor POST
Response::error("Method not allowed", 405);
