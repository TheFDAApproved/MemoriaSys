<?php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'logger.php';
// require_once 'responses.php';  // Uncomment if Response class is defined there
require_once 'checkuser.php';

$userData = checkuser();
if ($userData['role'] !== ROLE_ADMIN) {
    Response::error("Forbidden: Only administrators can access this resource", 403);
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';

// ------------------------------------------------------------------
// Helper: Validate date format (Y-m-d)
// ------------------------------------------------------------------

/**
 * Parse a date string from CSV into Y-m-d format.
 * Accepts multiple formats and trims whitespace.
 * Returns null for empty strings, throws exception on failure.
 */
function parseDate($value)
{
    $value = trim($value);
    if ($value === '' || strtolower($value) === 'null') {
        return null;
    }

    // List of possible input formats (most common first)
    $formats = [
        'Y-m-d',               // 2025-01-15
        'm/d/Y',               // 01/15/2025 (US)
        'd/m/Y',               // 15/01/2025 (EU)
        'Y-m-d H:i:s',         // 2025-01-15 00:00:00
        'Y-m-d H:i',           // 2025-01-15 00:00
        'n/j/Y',               // 1/15/2025
        'j/n/Y',               // 15/1/2025
        'm-d-Y',               // 01-15-2025
        'd-m-Y',               // 15-01-2025
        'M d Y',               // Jan 15 2025
        'M d, Y',              // Jan 15, 2025
        'd M Y',               // 15 Jan 2025
    ];

    foreach ($formats as $format) {
        $date = DateTime::createFromFormat($format, $value);
        if ($date && $date->format($format) === $value) {
            return $date->format('Y-m-d');
        }
    }

    // Try standard DateTime parsing as fallback (handles many formats)
    try {
        $date = new DateTime($value);
        return $date->format('Y-m-d');
    } catch (Exception $e) {
        // fall through to error
    }

    throw new Exception("Invalid date format: '$value' (expected Y-m-d or similar)");
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
            b.block_name,
            g.grave_code,
            g.row_num,
            g.col_num,
            i.contact_person_name,
            i.contact_person_phone_number,
            i.contact_person_email,
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
        LEFT JOIN graves g ON i.grave_id = g.grave_id
        LEFT JOIN blocks b ON g.block_id = b.block_id
        ORDER BY i.interment_id
    ");
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    if ($stmt->rowCount() === 0) Response::success("Looks like the database is empty.");

    header('Content-Type: text/csv');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    $output = fopen('php://output', 'w');
    // Write header
    fputcsv($output, array_keys($rows[0]), ',', '"', '\\');

    foreach ($rows as $row) {
        // Convert NULLs to empty strings
        $row = array_map(function ($val) {
            return $val === null ? '' : $val;
        }, $row);
        fputcsv($output, $row, ',', '"', '\\');
    }
    fclose($output);
    exit;
}

// ------------------------------------------------------------------
// Helper: Resolve grave_id from block_name and grave_code
// ------------------------------------------------------------------
function getGraveId($pdo, $blockName, $graveCode)
{
    $sql = "SELECT g.grave_id
            FROM graves g
            JOIN blocks b ON g.block_id = b.block_id
            WHERE b.block_name = :block_name AND g.grave_code = :grave_code";
    $stmt = $pdo->prepare($sql);
    $stmt->execute(['block_name' => $blockName, 'grave_code' => $graveCode]);
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}

// ------------------------------------------------------------------
// IMPORT
// ------------------------------------------------------------------
function importInterments($pdo, $filePath)
{
    // Allowed enum values
    $validStatuses = ['Pending', 'Active', 'Inactive'];
    $validAssistance = ['Burial', 'Transfer the remains of the late', 'Other'];

    $pdo->beginTransaction();
    $errors = [];
    $rowCount = 0;

    try {
        $handle = fopen($filePath, 'r');
        if (!$handle) {
            throw new Exception("Could not open file.");
        }

        // --- 1. Remove BOM if present ---
        $bom = fread($handle, 3);
        if ($bom !== "\xEF\xBB\xBF") {
            rewind($handle); // no BOM, rewind to start
        } // else we are already after BOM, continue

        // --- 2. Read and clean header ---
        $header = fgetcsv($handle, 0, ',', '"', '\\');
        if ($header === false) {
            throw new Exception("Empty CSV file or no header.");
        }
        $header = array_map('trim', $header); // trim each field

        // --- 3. Validate header against expected columns ---
        $expected = [
            'control_number',
            'deceased_name',
            'last_known_address',
            'death_certificate',
            'deceased_date_of_birth',
            'deceased_date_of_death',
            'block_name',
            'grave_code',
            'row_num',
            'col_num',
            'contact_person_name',
            'contact_person_phone_number',
            'contact_person_email',
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
            'remarks'
        ];

        // Case‑insensitive comparison (allow exact after trim)
        if (array_map('strtolower', $header) !== array_map('strtolower', $expected)) {
            throw new Exception("CSV header does not match expected format.");
        }

        // --- 4. Prepare SQL statement ---
        $stmtInsert = $pdo->prepare("
            INSERT INTO interments (
                control_number, deceased_name, last_known_address,
                death_certificate, deceased_date_of_birth, deceased_date_of_death,
                grave_id, contact_person_name, contact_person_phone_number,
                contact_person_email, assistance_type,
                burial_permit_number, burial_permit_date,
                transfer_permit_number, transfer_permit_issued_by, transfer_permit_date,
                exhumation_permit_number, exhumation_permit_date,
                date_buried, date_exhumed, burial_clearance_date, lease_expiration_date,
                status, remarks
            ) VALUES (
                :control_number, :deceased_name, :last_known_address,
                :death_certificate, :deceased_date_of_birth, :deceased_date_of_death,
                :grave_id, :contact_person_name, :contact_person_phone_number,
                :contact_person_email, :assistance_type,
                :burial_permit_number, :burial_permit_date,
                :transfer_permit_number, :transfer_permit_issued_by, :transfer_permit_date,
                :exhumation_permit_number, :exhumation_permit_date,
                :date_buried, :date_exhumed, :burial_clearance_date, :lease_expiration_date,
                :status, :remarks
            )
            ON DUPLICATE KEY UPDATE
                deceased_name = VALUES(deceased_name),
                last_known_address = VALUES(last_known_address),
                death_certificate = VALUES(death_certificate),
                deceased_date_of_birth = VALUES(deceased_date_of_birth),
                deceased_date_of_death = VALUES(deceased_date_of_death),
                grave_id = VALUES(grave_id),
                contact_person_name = VALUES(contact_person_name),
                contact_person_phone_number = VALUES(contact_person_phone_number),
                contact_person_email = VALUES(contact_person_email),
                assistance_type = VALUES(assistance_type),
                burial_permit_number = VALUES(burial_permit_number),
                burial_permit_date = VALUES(burial_permit_date),
                transfer_permit_number = VALUES(transfer_permit_number),
                transfer_permit_issued_by = VALUES(transfer_permit_issued_by),
                transfer_permit_date = VALUES(transfer_permit_date),
                exhumation_permit_number = VALUES(exhumation_permit_number),
                exhumation_permit_date = VALUES(exhumation_permit_date),
                date_buried = VALUES(date_buried),
                date_exhumed = VALUES(date_exhumed),
                burial_clearance_date = VALUES(burial_clearance_date),
                lease_expiration_date = VALUES(lease_expiration_date),
                status = VALUES(status),
                remarks = VALUES(remarks)
        ");

        // --- 5. Process rows, collect errors ---
        while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false) {

            // Skip completely empty rows
            if (empty(array_filter($row, function ($val) {
                return trim($val) !== '';
            }))) {
                continue; // ignore blank lines
            }

            $rowCount++;
            $data = array_combine($header, $row);

            // ---- a) Required fields ----
            if (empty($data['control_number']) || empty($data['deceased_name'])) {
                $errors[] = "Row $rowCount: Missing control_number or deceased_name.";
                continue; // skip this row
            }

            // ---- b) Resolve grave_id ----
            $graveId = null;
            if (!empty($data['block_name']) && !empty($data['grave_code'])) {
                $graveId = getGraveId($pdo, $data['block_name'], $data['grave_code']);
                if (!$graveId) {
                    // Optional: add warning (not a fatal error)
                    $errors[] = "Row $rowCount: Grave not found for block '{$data['block_name']}' and code '{$data['grave_code']}'. Grave ID set to NULL.";
                }
            }

            // ---- c) Build parameter array ----
            try {
                $params = [
                    'control_number'            => $data['control_number'],
                    'deceased_name'             => $data['deceased_name'],
                    'last_known_address'        => $data['last_known_address'] ?? null,
                    'death_certificate'         => $data['death_certificate'] ?? null,
                    'deceased_date_of_birth'    => parseDate($data['deceased_date_of_birth'] ?? ''),
                    'deceased_date_of_death'    => parseDate($data['deceased_date_of_death'] ?? ''),
                    'grave_id'                  => $graveId,
                    'contact_person_name'       => $data['contact_person_name'] ?? null,
                    'contact_person_phone_number' => $data['contact_person_phone_number'] ?? null,
                    'contact_person_email'      => $data['contact_person_email'] ?? null,
                    'assistance_type'           => $data['assistance_type'] ?? 'Burial',
                    'burial_permit_number'      => $data['burial_permit_number'] ?? null,
                    'burial_permit_date'        => parseDate($data['burial_permit_date'] ?? ''),
                    'transfer_permit_number'    => $data['transfer_permit_number'] ?? null,
                    'transfer_permit_issued_by' => $data['transfer_permit_issued_by'] ?? null,
                    'transfer_permit_date'      => parseDate($data['transfer_permit_date'] ?? ''),
                    'exhumation_permit_number'  => $data['exhumation_permit_number'] ?? null,
                    'exhumation_permit_date'    => parseDate($data['exhumation_permit_date'] ?? ''),
                    'date_buried'               => parseDate($data['date_buried'] ?? ''),
                    'date_exhumed'              => parseDate($data['date_exhumed'] ?? ''),
                    'burial_clearance_date'     => parseDate($data['burial_clearance_date'] ?? ''),
                    'lease_expiration_date'     => parseDate($data['lease_expiration_date'] ?? ''),
                    'status'                    => $data['status'] ?? 'Pending',
                    'remarks'                   => $data['remarks'] ?? null,
                ];
            } catch (Exception $e) {
                // parseDate threw an exception
                $errors[] = "Row $rowCount: " . $e->getMessage();
                continue;
            }

            // ---- d) Validate enums ----
            if (!in_array($params['status'], $validStatuses)) {
                $errors[] = "Row $rowCount: Invalid status '{$params['status']}'.";
                continue;
            }
            if (!in_array($params['assistance_type'], $validAssistance)) {
                $errors[] = "Row $rowCount: Invalid assistance_type '{$params['assistance_type']}'.";
                continue;
            }

            // ---- e) Execute ----
            try {
                $stmtInsert->execute($params);
            } catch (PDOException $e) {
                $errors[] = "Row $rowCount: Database error - " . $e->getMessage();
                // Continue to next row
            }
        }

        fclose($handle);

        // --- 6. Finish: commit or rollback ---
        if (empty($errors)) {
            $pdo->commit();
            return true;
        } else {
            $pdo->rollBack();
            // Build a detailed error message
            $errorMsg = "Import completed with " . count($errors) . " error(s):\n- " . implode("\n- ", $errors);
            throw new Exception($errorMsg);
        }
    } catch (Exception $e) {
        // Catch any other exception (e.g., file open, header mismatch)
        if (isset($pdo) && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

// ------------------------------------------------------------------
// Route requests
// ------------------------------------------------------------------
if ($method === 'GET') {
    exportInterments($pdo);
}

if ($method === 'POST') {

    // Check if file was uploaded
    if (!isset($_FILES['csv_file']) || $_FILES['csv_file']['error'] !== UPLOAD_ERR_OK) {
        Response::error("No valid CSV file uploaded.", 400);
        exit;
    }

    $file = $_FILES['csv_file'];
    $tmpPath = $file['tmp_name'];
    $originalName = $file['name'];

    // 1. Check file size (adjust limit as needed)
    $maxSize = 100 * 1024 * 1024; // 100MB
    if ($file['size'] > $maxSize || $file['size'] === 0) {
        Response::error("Invalid file size.", 400);
        exit;
    }

    // 2. Validate extension (whitelist only)
    $allowedExtensions = ['csv'];
    $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if (!in_array($extension, $allowedExtensions, true)) {
        Response::error("Only CSV files are allowed.", 400);
        exit;
    }

    // 3. Detect MIME type from actual file content (not browser-supplied)
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $detectedMime = $finfo->file($tmpPath);

    // CSV files often show as text/plain or text/csv
    $allowedMimes = ['text/plain', 'text/csv', 'application/vnd.ms-excel'];
    if (!in_array($detectedMime, $allowedMimes, true)) {
        Response::error("File type not permitted.", 400);
        exit;
    }

    // 4. Validate CSV structure by attempting to parse it
    $handle = fopen($tmpPath, 'r');
    if ($handle === false) {
        Response::error("Cannot read file.", 500);
        exit;
    }

    // Read first few rows to check structure
    $rowCount = 0;
    $validRows = 0;
    while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false && $rowCount < 10) {
        $rowCount++;
        // Ensure row is an array with at least one field
        if (is_array($row) && count($row) > 0) {
            $validRows++;
        }
    }
    fclose($handle);

    // If none of the first 10 rows parsed as CSV, reject
    if ($validRows === 0) {
        Response::error("File does not appear to be a valid CSV.", 400);
        exit;
    }

    // Optional: Additional content validation
    // - Check for expected column count
    // - Sanitize/validate cell values before DB insertion
    // - Limit number of rows

    // If all checks pass, proceed to move_uploaded_file() and process

    $file = $_FILES['csv_file']['tmp_name'];
    try {
        importInterments($pdo, $file);
        Response::success("Imported data successfully");
    } catch (Exception $e) {
        Response::error("Import error: " . $e->getMessage(), 500);
    }
    exit; // Important: stop execution
}

// If neither GET nor POST, return 405
Response::error("Method not allowed", 405);
