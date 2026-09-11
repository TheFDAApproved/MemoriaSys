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
// Helper: Validate date format (Y-m-d)
// ------------------------------------------------------------------
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

    throw new Exception("Invalid date format: '$value' (expected Y-m-d or similar)");
}

// ------------------------------------------------------------------
// Helper: Resolve current_grave_id from block_name and grave_code
// ------------------------------------------------------------------
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
    $validStatuses = ['Pending', 'Active', 'Inactive'];
    $validAssistance = ['Burial', 'Transfer the remains of the late', 'Other'];
    $validSex = ['Male', 'Female', 'Unknown'];

    $pdo->beginTransaction();
    $errors = [];
    $rowCount = 0;
    $inserted = 0;
    $updated = 0;

    try {
        $handle = fopen($filePath, 'r');
        if (!$handle) {
            throw new Exception("Could not open file.");
        }

        // Remove BOM if present
        $bom = fread($handle, 3);
        if ($bom !== "\xEF\xBB\xBF") {
            rewind($handle);
        }

        // Read and clean header
        $header = fgetcsv($handle, 0, ',', '"', '\\');
        if ($header === false) {
            throw new Exception("Empty CSV file or no header.");
        }
        $header = array_map('trim', $header);

        // Validate header against expected columns
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
            'remarks'
        ];

        if (array_map('strtolower', $header) !== array_map('strtolower', $expected)) {
            throw new Exception("CSV header does not match expected format.");
        }

        // Process rows
        while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false) {
            // Skip empty rows
            if (empty(array_filter($row, function ($val) {
                return trim($val) !== '';
            }))) {
                continue;
            }

            $rowCount++;
            $data = array_combine($header, $row);

            // Required fields
            if (empty($data['control_number']) || empty($data['deceased_name'])) {
                $errors[] = "Row $rowCount: Missing control_number or deceased_name.";
                continue;
            }

            // Resolve grave_id
            $graveId = null;
            if (!empty($data['block_name']) && !empty($data['grave_code'])) {
                $graveId = getGraveId($pdo, $data['block_name'], $data['grave_code']);
                if (!$graveId) {
                    $errors[] = "Row $rowCount: Grave not found for block '{$data['block_name']}' and code '{$data['grave_code']}'. Grave ID set to NULL.";
                }
            }

            try {
                $params = [
                    'control_number'            => $data['control_number'],
                    'deceased_name'             => $data['deceased_name'],
                    'last_known_address'        => $data['last_known_address'] ?? null,
                    'death_certificate'         => $data['death_certificate'] ?? null,
                    'deceased_date_of_birth'    => parseDate($data['deceased_date_of_birth'] ?? ''),
                    'deceased_date_of_death'    => parseDate($data['deceased_date_of_death'] ?? ''),
                    'deceased_sex'              => $data['deceased_sex'] ?? 'Unknown',
                    'current_grave_id'          => $graveId,
                    'contact_person_name'       => $data['contact_person_name'] ?? null,
                    'contact_person_phone_number' => $data['contact_person_phone_number'] ?? null,
                    'contact_person_email'      => $data['contact_person_email'] ?? null,
                    'contact_person_address'    => $data['contact_person_address'] ?? null,
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
                $errors[] = "Row $rowCount: " . $e->getMessage();
                continue;
            }

            // Validate enums
            if (!in_array($params['status'], $validStatuses)) {
                $errors[] = "Row $rowCount: Invalid status '{$params['status']}'.";
                continue;
            }
            if (!in_array($params['assistance_type'], $validAssistance)) {
                $errors[] = "Row $rowCount: Invalid assistance_type '{$params['assistance_type']}'.";
                continue;
            }
            if (!in_array($params['deceased_sex'], $validSex)) {
                $errors[] = "Row $rowCount: Invalid deceased_sex '{$params['deceased_sex']}'.";
                continue;
            }

            // --- Check if control_number already exists (including soft-deleted) ---
            $checkStmt = $pdo->prepare("
                SELECT interment_id, deleted_at FROM interments 
                WHERE control_number = :control_number
            ");
            $checkStmt->execute(['control_number' => $params['control_number']]);
            $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);

            try {
                if ($existing) {
                    // Update existing record (restore if soft-deleted)
                    $updateSql = "
                        UPDATE interments 
                        SET deceased_name = :deceased_name,
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
                            deleted_at = NULL  -- restore if it was soft-deleted
                        WHERE control_number = :control_number
                    ";
                    $updateParams = $params;
                    $updateParams['updated_by'] = $userId;
                    $updateParams['control_number'] = $params['control_number'];
                    $updateStmt = $pdo->prepare($updateSql);
                    $updateStmt->execute($updateParams);
                    $updated++;
                } else {
                    // Insert new record
                    $insertSql = "
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
                    ";
                    $insertParams = $params;
                    $insertParams['created_by'] = $userId;
                    $insertParams['updated_by'] = $userId;
                    $insertStmt = $pdo->prepare($insertSql);
                    $insertStmt->execute($insertParams);
                    $inserted++;
                }

                // --- NEW ADDITION: Synchronize the grave status upon import ---
                if ($params['status'] === 'Active' && !empty($params['current_grave_id'])) {
                    $markOccupied = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = :grave_id AND deleted_at IS NULL");
                    $markOccupied->execute(['grave_id' => $params['current_grave_id']]);
                }
                // --------------------------------------------------------------

            } catch (PDOException $e) {
                $errors[] = "Row $rowCount: Database error - " . $e->getMessage();
            }
        }

        fclose($handle);

        if (empty($errors)) {
            $pdo->commit();
            return ['success' => true, 'inserted' => $inserted, 'updated' => $updated];
        } else {
            $pdo->rollBack();
            $errorMsg = "Import completed with " . count($errors) . " error(s):\n- " . implode("\n- ", $errors);
            throw new Exception($errorMsg);
        }
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
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
    systemLog("{$userData['name']} ({$userData['username']}) exported a csv file", $userData['user_id']);
    exit;
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

    // 1. Check file size
    $maxSize = 100 * 1024 * 1024; // 100MB
    if ($file['size'] > $maxSize || $file['size'] === 0) {
        Response::error("Invalid file size.", 400);
        exit;
    }

    // 2. Validate extension
    $allowedExtensions = ['csv'];
    $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if (!in_array($extension, $allowedExtensions, true)) {
        Response::error("Only CSV files are allowed.", 400);
        exit;
    }

    // 3. Detect MIME type
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $detectedMime = $finfo->file($tmpPath);
    $allowedMimes = ['text/plain', 'text/csv', 'application/vnd.ms-excel'];
    if (!in_array($detectedMime, $allowedMimes, true)) {
        Response::error("File type not permitted.", 400);
        exit;
    }

    // 4. Validate CSV structure
    $handle = fopen($tmpPath, 'r');
    if ($handle === false) {
        Response::error("Cannot read file.", 500);
        exit;
    }

    $rowCount = 0;
    $validRows = 0;
    while (($row = fgetcsv($handle, 0, ',', '"', '\\')) !== false && $rowCount < 10) {
        $rowCount++;
        if (is_array($row) && count($row) > 0) {
            $validRows++;
        }
    }
    fclose($handle);

    if ($validRows === 0) {
        Response::error("File does not appear to be a valid CSV.", 400);
        exit;
    }

    // Process import
    try {
        $result = importInterments($pdo, $tmpPath, $userData['user_id']);
        systemLog(
            "CSV import completed. Inserted: {$result['inserted']}, Updated: {$result['updated']}",
            $userData['user_id']
        );
        Response::success("Import completed successfully.", $result);
    } catch (Exception $e) {
        systemLog("CSV import error: " . $e->getMessage(), $userData['user_id']);
        Response::error("Import error: " . $e->getMessage(), 500);
    }
    exit;
}

// If neither GET nor POST, return 405
Response::error("Method not allowed", 405);
