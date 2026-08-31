<?php

/**
 * reports.php
 */

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method !== 'GET') {
    Response::error("Method not allowed", 405);
}

// Only Admin and Office can manage records
$userRole = $userData['role'] ?? null;
if (!in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Unauthorized access", 403);
}

$report      = strtolower(trim((string)($_GET['report'] ?? 'interment')));
$filterType  = strtolower(trim((string)($_GET['filter'] ?? 'none')));
$filterValue = trim((string)($_GET['value'] ?? 'all'));

if ($filterValue === '') {
    $filterValue = 'all';
}

$basePayload = [
    'report'       => $report,
    'generated_at' => date('c'),
    'filters'      => [
        'type'  => $filterType,
        'value' => $filterValue,
    ],
];

try {
    switch ($report) {

        // ---------------------------------------------------------
        // 1. CAPACITY REPORT (Aggregated Data)
        // ---------------------------------------------------------
        case 'capacity':
            // Overall Cemetery Summary
            $summaryStmt = $pdo->prepare("
                SELECT
                    COUNT(*) AS total_graves,
                    SUM(CASE WHEN status = 'Occupied' THEN 1 ELSE 0 END) AS occupied,
                    SUM(CASE WHEN status = 'Vacant' THEN 1 ELSE 0 END) AS vacant
                FROM graves
            ");
            $summaryStmt->execute();
            $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

            // Capacity by Block
            $blockStmt = $pdo->prepare("
                SELECT
                    b.block_name,
                    b.block_type,
                    COUNT(g.grave_id) AS total_graves,
                    SUM(CASE WHEN g.status = 'Occupied' THEN 1 ELSE 0 END) AS occupied,
                    SUM(CASE WHEN g.status = 'Vacant' THEN 1 ELSE 0 END) AS vacant
                FROM blocks b
                LEFT JOIN graves g ON g.block_id = b.block_id
                GROUP BY b.block_id, b.block_name, b.block_type
                ORDER BY b.block_name ASC
            ");
            $blockStmt->execute();

            $payload = $basePayload;
            $payload['summary'] = [
                'total_graves' => (int)($summary['total_graves'] ?? 0),
                'occupied'     => (int)($summary['occupied'] ?? 0),
                'vacant'       => (int)($summary['vacant'] ?? 0),
            ];
            $payload['by_block']      = $blockStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            $payload['total_records'] = count($payload['by_block']);

            Response::success("Cemetery capacity summary retrieved", $payload);
            break;

        // ---------------------------------------------------------
        // 2. LEASE EXPIRATIONS REPORT
        // ---------------------------------------------------------
        case 'expirations':
            // Already Expired Leases
            $expiredStmt = $pdo->prepare("
                SELECT
                    i.interment_id,
                    g.grave_code,
                    i.deceased_name,
                    i.lease_expiration_date,
                    i.contact_person_name AS contact_name,
                    i.contact_person_phone_number AS phone_number,
                    i.remarks,
                    i.status
                FROM interments i
                LEFT JOIN graves g ON g.grave_id = i.current_grave_id
                WHERE i.status = 'Active'
                  AND i.lease_expiration_date IS NOT NULL
                  AND i.lease_expiration_date < CURDATE()
                ORDER BY i.lease_expiration_date ASC
            ");
            $expiredStmt->execute();

            // Leases Expiring within the next 30 days
            $expiringStmt = $pdo->prepare("
                SELECT
                    i.interment_id,
                    g.grave_code,
                    i.deceased_name,
                    i.lease_expiration_date,
                    i.contact_person_name AS contact_name,
                    i.contact_person_phone_number AS phone_number,
                    i.remarks,
                    i.status
                FROM interments i
                LEFT JOIN graves g ON g.grave_id = i.current_grave_id
                WHERE i.status = 'Active'
                  AND i.lease_expiration_date IS NOT NULL
                  AND i.lease_expiration_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
                ORDER BY i.lease_expiration_date ASC
            ");
            $expiringStmt->execute();

            $payload = $basePayload;
            $payload['expired']       = $expiredStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            $payload['expiring']      = $expiringStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            $payload['total_records'] = count($payload['expired']) + count($payload['expiring']);

            Response::success("Lease expiration report retrieved", $payload);
            break;

        // ---------------------------------------------------------
        // 3. ALL GRAVES REGISTRY
        // ---------------------------------------------------------
        case 'allgraves':
        case 'graves':
            $params = [];
            $whereClauses = ["1=1"];

            if ($filterType === 'status' && $filterValue !== 'all') {
                $whereClauses[] = "g.status = :status";
                $params[':status'] = $filterValue;
            }

            $whereSql = "WHERE " . implode(" AND ", $whereClauses);

            $sql = "
                SELECT
                    g.grave_id,
                    g.grave_code,
                    g.status,
                    g.remarks,
                    b.block_name,
                    b.block_type
                FROM graves g
                LEFT JOIN blocks b ON b.block_id = g.block_id
                $whereSql
                ORDER BY b.block_name ASC, g.grave_code ASC
            ";

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $payload = $basePayload;
            $payload['rows'] = array_map(function ($row) {
                return [
                    'grave_id'       => (int)($row['grave_id'] ?? 0),
                    'grave_code'     => $row['grave_code'] ?? 'N/A',
                    'status'         => $row['status'] ?? 'Unknown',
                    'remarks'        => $row['remarks'] ?? '',
                    'block_name'     => $row['block_name'] ?? 'N/A',
                    'block_type'     => $row['block_type'] ?? 'N/A',
                    'display_status' => $row['status'] ?? 'Unknown'
                ];
            }, $rows);
            $payload['total_records'] = count($payload['rows']);

            Response::success("All graves registry status retrieved", $payload);
            break;

        // ---------------------------------------------------------
        // 4. INTERMENT DIRECTORY
        // ---------------------------------------------------------
        case 'interment':
        case 'interments':
        default:
            $params = [];
            $whereClauses = ["1=1"];

            if ($filterType === 'address' && $filterValue !== 'all') {
                $whereClauses[] = "i.last_known_address LIKE :address";
                $params[':address'] = "%" . $filterValue . "%";
            }

            if ($filterType === 'gender' && $filterValue !== 'all') {
                $whereClauses[] = "i.deceased_sex = :gender";
                $params[':gender'] = $filterValue;
            }

            if ($filterType === 'year' && $filterValue !== 'all') {
                $whereClauses[] = "YEAR(COALESCE(i.date_buried, i.deceased_date_of_death)) = :year";
                $params[':year'] = (int)$filterValue;
            }

            if ($filterType === 'remarks' && $filterValue !== 'all') {
                // If filter value is 'Family', ensure contact exists. Otherwise 'No Family'.
                if (strtolower($filterValue) === 'family') {
                    $whereClauses[] = "(i.contact_person_name IS NOT NULL AND i.contact_person_name != '')";
                } else {
                    $whereClauses[] = "(i.contact_person_name IS NULL OR i.contact_person_name = '')";
                }
            }

            $whereSql = "WHERE " . implode(" AND ", $whereClauses);

            $sql = "
                SELECT
                    i.interment_id,
                    i.control_number,
                    i.date_buried,
                    i.lease_expiration_date,
                    i.remarks AS interment_remarks,
                    i.deceased_name,
                    i.deceased_sex,
                    i.deceased_date_of_death,
                    i.last_known_address,
                    g.grave_code,
                    b.block_name,
                    b.block_type,
                    i.contact_person_name,
                    i.contact_person_phone_number,
                    i.contact_person_address
                FROM interments i
                LEFT JOIN graves g ON g.grave_id = i.current_grave_id
                LEFT JOIN blocks b ON b.block_id = g.block_id
                $whereSql
                ORDER BY i.date_buried DESC, i.interment_id DESC
            ";

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $payload = $basePayload;
            $payload['rows'] = array_map(function ($row) {

                $contactName = trim((string)($row['contact_person_name'] ?? ''));
                $hasFamily = ($contactName !== '');
                $familyStatus = $hasFamily ? 'Family' : 'No Family';

                return [
                    'interment_id'          => (int)($row['interment_id'] ?? 0),
                    'control_number'        => $row['control_number'] ?? null,
                    'name'                  => $row['deceased_name'] ?? 'Unknown',
                    'date_of_death'         => $row['deceased_date_of_death'] ?? null,
                    'date_buried'           => $row['date_buried'] ?? null,
                    'burial_year'           => $row['date_buried'] ? date('Y', strtotime($row['date_buried'])) : null,
                    'grave_code'            => $row['grave_code'] ?? 'N/A',
                    'location'              => trim((string)($row['block_name'] ?? '')) !== ''
                        ? ($row['block_name'] . ' - ' . ($row['grave_code'] ?? 'N/A'))
                        : ($row['grave_code'] ?? 'N/A'),
                    'contact_person'        => $hasFamily ? $contactName : 'CSWS Officer',
                    'contact_phone'         => $row['contact_person_phone_number'] ?? null,
                    'address'               => $row['contact_person_address'] ?? null,
                    'deceased_address'      => $row['last_known_address'] ?? null,
                    'gender'                => $row['deceased_sex'] ?? 'Unknown',
                    'family_status'         => $familyStatus,
                    'lease_expiration_date' => $row['lease_expiration_date'] ?? null,
                    'interment_remarks'     => $row['interment_remarks'] ?? null,
                ];
            }, $rows);

            $payload['total_records'] = count($payload['rows']);
            Response::success("Interment directory retrieved", $payload);
            break;
    }
} catch (Throwable $e) {
    error_log("Report Generation Error: " . $e->getMessage());
    Response::error("Unable to generate report data.", 500);
}
