<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logger.php';
require_once 'checkuser.php';

$userData = checkuser();
if ($userData['role'] !== ROLE_ADMIN) {
    Response::error("Forbidden: Only administrators can access this resource", 403);
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Convert an empty string (or whitespace) to null. */
function nonEmpty($value)
{
    if ($value === null) return null;
    $value = trim((string)$value);
    return $value === '' ? null : $value;
}

/** Validate date format (Y-m-d), accepting many common inputs. */
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

/** Find a grave_id from block_name + grave_code. */
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

/**
 * Keep graves.status in sync based on whether any Active interment
 * currently uses that grave. Active usage => 'Occupied', otherwise 'Vacant'.
 */
function syncGraveStatus($pdo, $graveId)
{
    if (empty($graveId)) return;

    $stmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM interments
        WHERE current_grave_id = :gid
          AND status = 'Active'
          AND deleted_at IS NULL
    ");
    $stmt->execute(['gid' => $graveId]);
    $isOccupied = ((int)$stmt->fetchColumn()) > 0;

    $pdo->prepare("
        UPDATE graves
        SET status = :s
        WHERE grave_id = :gid AND deleted_at IS NULL
    ")->execute([
        's'   => $isOccupied ? 'Occupied' : 'Vacant',
        'gid' => $graveId,
    ]);
}

// ------------------------------------------------------------------
// EXPORT
// ------------------------------------------------------------------
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
            i.remarks,
            i.created_at,
            i.updated_at,
            i.deleted_at
        FROM interments i
        LEFT JOIN graves g ON i.current_grave_id = g.grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON g.block_id = b.block_id AND b.deleted_at IS NULL
        WHERE i.deleted_at IS NULL
        ORDER BY i.interment_id
    ");
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    if ($stmt->rowCount() === 0) {
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

// ------------------------------------------------------------------
// IMPORT
// ------------------------------------------------------------------
function importInterments($pdo, $filePath, $userId)
{
    $validStatuses   = ['Pending', 'Active', 'Inactive'];
    $validAssistance = ['Burial', 'Transfer the remains of the late', 'Other'];
    $validSex        = ['Male', 'Female', 'Unknown'];

    $errors   = [];   // fatal — row not saved
    $warnings = [];   // non-fatal — row saved with a caveat
    $inserted = 0;
    $updated  = 0;
    $skipped  = 0;
    $rowCount = 0;

    // Detect duplicate control_numbers inside the same file
    $seenControls = [];

    $handle = fopen($filePath, 'r');
    if ($handle === false) {
        throw new Exception("Could not open the uploaded file.");
    }

    // Remove UTF-8 BOM if present
    $bom = fread($handle, 3);
    if ($bom !== "\xEF\xBB\xBF") {
        rewind($handle);
    }

    // Header
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

        while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false) {
            // Skip fully empty rows
            if (!is_array($row) || empty(array_filter($row, fn($v) => trim((string)$v) !== ''))) {
                continue;
            }

            $rowCount++;
            $lineNum = $rowCount + 1; // +1 because line 1 is the header in the file

            // Normalize row length and trim values
            $row = array_map(fn($v) => is_string($v) ? trim($v) : $v, $row);
            if (count($row) < $headerCount) {
                $row = array_pad($row, $headerCount, '');
            } elseif (count($row) > $headerCount) {
                $row = array_slice($row, 0, $headerCount);
            }
            $data = array_combine($header, $row);

            $pdo->exec("SAVEPOINT import_row");

            try {
                // ---- Required fields --------------------------------------
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

                // ---- Duplicate control_number inside the same file --------
                if (isset($seenControls[$controlNumber])) {
                    throw new Exception(
                        "Duplicate control_number '$controlNumber' in this file " .
                            "(already used on line {$seenControls[$controlNumber]})."
                    );
                }

                // ---- Grave lookup -----------------------------------------
                $graveId   = null;
                $blockName = trim((string)($data['block_name'] ?? ''));
                $graveCode = trim((string)($data['grave_code'] ?? ''));

                if ($blockName !== '' && $graveCode !== '') {
                    $graveId = getGraveId($pdo, $blockName, $graveCode);
                    if (!$graveId) {
                        $warnings[] = "Line $lineNum: grave not found for block " .
                            "'$blockName' and code '$graveCode'. " .
                            "Saved without a grave.";
                    }
                } elseif ($blockName !== '' || $graveCode !== '') {
                    $warnings[] = "Line $lineNum: block_name and grave_code must " .
                        "both be filled to link a grave. Saved without a grave.";
                }

                // ---- Dates (each error names the offending column) --------
                $parseCol = function ($value, $column) {
                    try {
                        return parseDate($value ?? '');
                    } catch (Exception $e) {
                        throw new Exception("$column: " . $e->getMessage());
                    }
                };

                $deceasedDob       = $parseCol($data['deceased_date_of_birth'] ?? '', 'deceased_date_of_birth');
                $deceasedDod       = $parseCol($data['deceased_date_of_death'] ?? '', 'deceased_date_of_death');
                $burialPermitDate  = $parseCol($data['burial_permit_date'] ?? '', 'burial_permit_date');
                $transferPermitDate = $parseCol($data['transfer_permit_date'] ?? '', 'transfer_permit_date');
                $exhumationPermitDate = $parseCol($data['exhumation_permit_date'] ?? '', 'exhumation_permit_date');
                $dateBuried        = $parseCol($data['date_buried'] ?? '', 'date_buried');
                $dateExhumed       = $parseCol($data['date_exhumed'] ?? '', 'date_exhumed');
                $burialClearance   = $parseCol($data['burial_clearance_date'] ?? '', 'burial_clearance_date');
                $leaseExpiration   = $parseCol($data['lease_expiration_date'] ?? '', 'lease_expiration_date');

                // ---- Enums (empty string falls back to default) -----------
                $status         = trim((string)($data['status'] ?? '')) ?: 'Pending';
                $assistanceType = trim((string)($data['assistance_type'] ?? '')) ?: 'Burial';
                $sex            = trim((string)($data['deceased_sex'] ?? '')) ?: 'Unknown';

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

                // ---- Grave conflict warning -------------------------------
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

                // ---- Params -----------------------------------------------
                $params = [
                    'control_number'              => $controlNumber,
                    'deceased_name'               => $deceasedName,
                    'last_known_address'          => nonEmpty($data['last_known_address'] ?? null),
                    'death_certificate'           => nonEmpty($data['death_certificate'] ?? null),
                    'deceased_date_of_birth'      => $deceasedDob,
                    'deceased_date_of_death'      => $deceasedDod,
                    'deceased_sex'                => $sex,
                    'current_grave_id'            => $graveId,
                    'contact_person_name'         => nonEmpty($data['contact_person_name'] ?? null),
                    'contact_person_phone_number' => nonEmpty($data['contact_person_phone_number'] ?? null),
                    'contact_person_email'        => nonEmpty($data['contact_person_email'] ?? null),
                    'contact_person_address'      => nonEmpty($data['contact_person_address'] ?? null),
                    'assistance_type'             => $assistanceType,
                    'burial_permit_number'        => nonEmpty($data['burial_permit_number'] ?? null),
                    'burial_permit_date'          => $burialPermitDate,
                    'transfer_permit_number'      => nonEmpty($data['transfer_permit_number'] ?? null),
                    'transfer_permit_issued_by'   => nonEmpty($data['transfer_permit_issued_by'] ?? null),
                    'transfer_permit_date'        => $transferPermitDate,
                    'exhumation_permit_number'    => nonEmpty($data['exhumation_permit_number'] ?? null),
                    'exhumation_permit_date'      => $exhumationPermitDate,
                    'date_buried'                 => $dateBuried,
                    'date_exhumed'                => $dateExhumed,
                    'burial_clearance_date'       => $burialClearance,
                    'lease_expiration_date'       => $leaseExpiration,
                    'status'                      => $status,
                    'remarks'                     => nonEmpty($data['remarks'] ?? null),
                ];

                // ---- Existing? --------------------------------------------
                $checkStmt = $pdo->prepare("
                    SELECT interment_id, current_grave_id, status, deleted_at
                    FROM interments
                    WHERE control_number = :cn
                    LIMIT 1
                ");
                $checkStmt->execute(['cn' => $controlNumber]);
                $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);

                if ($existing) {
                    if (!empty($existing['deleted_at'])) {
                        $warnings[] = "Line $lineNum: control_number '$controlNumber' " .
                            "was soft-deleted and has been restored.";
                    }

                    $updateParams = $params;
                    $updateParams['updated_by'] = $userId;

                    $pdo->prepare("
                        UPDATE interments SET
                            deceased_name = :deceased_name,
                            last_known_address = :last_known_address,
                            death_certificate = :death_certificate,
                            deceased_date_of_birth = :deceased_date_of_birth,
                            deceased_date_of_death = :deceased_date_of_death,
                            deceased_sex = :deceased_sex,
                            current_grave_id = :current_grave_id,
                            contact_person_name = :contact_person_name,
                            contact_person_phone_number = :contact_person_phone_number,
                            contact_person_email = :contact_person_email,
                            contact_person_address = :contact_person_address,
                            assistance_type = :assistance_type,
                            burial_permit_number = :burial_permit_number,
                            burial_permit_date = :burial_permit_date,
                            transfer_permit_number = :transfer_permit_number,
                            transfer_permit_issued_by = :transfer_permit_issued_by,
                            transfer_permit_date = :transfer_permit_date,
                            exhumation_permit_number = :exhumation_permit_number,
                            exhumation_permit_date = :exhumation_permit_date,
                            date_buried = :date_buried,
                            date_exhumed = :date_exhumed,
                            burial_clearance_date = :burial_clearance_date,
                            lease_expiration_date = :lease_expiration_date,
                            status = :status,
                            remarks = :remarks,
                            updated_at = NOW(),
                            updated_by = :updated_by,
                            deleted_at = NULL
                        WHERE control_number = :control_number
                    ")->execute($updateParams);

                    // Sync both old and new graves
                    syncGraveStatus($pdo, $existing['current_grave_id']);
                    syncGraveStatus($pdo, $graveId);

                    $updated++;
                } else {
                    $insertParams = $params;
                    $insertParams['created_by'] = $userId;
                    $insertParams['updated_by'] = $userId;

                    $pdo->prepare("
                        INSERT INTO interments (
                            control_number, deceased_name, last_known_address,
                            death_certificate, deceased_date_of_birth, deceased_date_of_death,
                            deceased_sex, current_grave_id, contact_person_name,
                            contact_person_phone_number, contact_person_email,
                            contact_person_address, assistance_type,
                            burial_permit_number, burial_permit_date,
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
                            :contact_person_address, :assistance_type,
                            :burial_permit_number, :burial_permit_date,
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

                // Claim this control_number only after the row succeeded
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

// ------------------------------------------------------------------
// Route: GET -> export
// ------------------------------------------------------------------
if ($method === 'GET') {
    exportInterments($pdo);
    systemLog(
        "{$userData['name']} ({$userData['username']}) exported a csv file",
        $userData['user_id']
    );
    exit;
}

// ------------------------------------------------------------------
// Route: POST -> import
// ------------------------------------------------------------------
if ($method === 'POST') {
    if (!isset($_FILES['csv_file']) || $_FILES['csv_file']['error'] !== UPLOAD_ERR_OK) {
        Response::error("No valid CSV file uploaded.", 400);
        exit;
    }

    $file = $_FILES['csv_file'];
    $tmpPath = $file['tmp_name'];
    $originalName = $file['name'];

    // 1. File size
    $maxSize = 100 * 1024 * 1024; // 100MB
    if ($file['size'] > $maxSize || $file['size'] === 0) {
        Response::error("Invalid file size.", 400);
        exit;
    }

    // 2. Extension
    $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if ($extension !== 'csv') {
        Response::error("Only CSV files are allowed.", 400);
        exit;
    }

    // 3. MIME type
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $detectedMime = $finfo->file($tmpPath);
    $allowedMimes = ['text/plain', 'text/csv', 'application/vnd.ms-excel'];
    if (!in_array($detectedMime, $allowedMimes, true)) {
        Response::error("File type not permitted.", 400);
        exit;
    }

    // 4. Basic structure sanity check
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

    // 5. Run the import
    try {
        $result = importInterments($pdo, $tmpPath, $userData['user_id']);

        systemLog(
            "CSV import finished. Inserted: {$result['inserted']}, " .
                "Updated: {$result['updated']}, Skipped: {$result['skipped']}, " .
                "Warnings: " . count($result['warnings']) . ", " .
                "Errors: " . count($result['errors']),
            $userData['user_id']
        );

        // Build a friendly one-line summary for the toast/banner
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

        // Include a "has_errors" flag so the frontend can style it red/amber
        $result['has_errors']   = !empty($result['errors']);
        $result['has_warnings'] = !empty($result['warnings']);

        Response::success($summary, $result);
    } catch (Exception $e) {
        systemLog("CSV import error: " . $e->getMessage(), $userData['user_id']);
        Response::error("Import error: " . $e->getMessage(), 500);
    }
    exit;
}

// Neither GET nor POST
Response::error("Method not allowed", 405);
