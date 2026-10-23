<?php

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'database.php';
require_once 'responses.php';
require_once 'logger.php';

$method = $_SERVER['REQUEST_METHOD'] ?? null;

if ($method !== 'GET') {
    Response::error("Method not allowed", 405);
}

// Grab the search query from the URL (e.g., search.php?q=Hannah)
$searchQuery = $_GET['q'] ?? '';

if (empty($searchQuery)) {
    Response::error("Search query is required", 400);
}

try {
    // Can only search for those who are active
    $sql = "
        SELECT
            i.interment_id             AS id,
            i.deceased_name            AS name,
            i.deceased_date_of_birth   AS date_of_birth,
            i.deceased_date_of_death   AS date_of_death,
            b.block_name               AS block,
            g.row_num                  AS `row`,
            g.col_num                  AS `column`,
            b.block_type               AS grave_type,
            g.grave_code
        FROM interments i
        LEFT JOIN graves g
               ON i.current_grave_id = g.grave_id
              AND g.deleted_at IS NULL
        LEFT JOIN blocks b
               ON g.block_id = b.block_id
              AND b.deleted_at IS NULL
        WHERE i.deceased_name LIKE :search
          AND i.status = 'Active'
          AND i.deleted_at IS NULL
        ORDER BY i.deceased_name ASC
        LIMIT 11
    ";

    $stmt = $pdo->prepare($sql);

    // Using wildcard % to allow partial name searches
    $stmt->execute(['search' => '%' . $searchQuery . '%']);

    $results = $stmt->fetchAll(PDO::FETCH_ASSOC);

    if (empty($results)) {
        Response::error("No results found for: " . $searchQuery, 404);
    }
    Response::success("Search results for: " . $searchQuery, $results);
} catch (PDOException $e) {
    // Logs the actual error but sends a generic message to the frontend for security
    error_log("Search Error: " . $e->getMessage());
    systemLog("Search Error: " . $e->getMessage(), 'System');
    Response::error("An error occurred while searching the records. " . $e->getMessage(), 500);
}
