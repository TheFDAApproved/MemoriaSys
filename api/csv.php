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

// Stream all interments as a CSV download
function exportInterments($pdo, $filename = 'interments_export.csv')
{
    $stmt = $pdo->query("
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
        WHERE i.deleted_at IS NULL
        ORDER BY i.interment_id
    ");
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    if (count($rows) === 0) {
        Response::success("Looks like the database is empty.");
        exit;
    }

    header('Content-Type: text/csv');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    $output = fopen('php://output', 'w');
    fputcsv($output, array_keys($rows[0]), ',', '"', '\\');

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

if ($method === 'GET') {
    $now = new DateTime('now', new DateTimeZone(DB_TIMEZONE));

    $exportFilename = 'memoria_interments_export_'
        . $now->format('Y-m-d_H-i-s-A')
        . '.csv';

    exportInterments($pdo, $exportFilename);

    systemLog(
        "{$userData['name']} ({$userData['username']}) exported a csv file",
        $userData['user_id']
    );
    exit;
}

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
