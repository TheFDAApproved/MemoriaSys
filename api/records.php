<?php

// records.php - Master File, full CRUD for interments
// GET    /records.php/{id}  returns one interment plus its placement history
// GET    /records.php       lists interments (Active or Inactive only) with nested placement history
// POST   /records.php       creates a manual interment record
// PUT    /records.php/{id}  updates, blocked if an Active reservation locks it
// DELETE /records.php/{id}  soft-deletes, blocked if an Active reservation locks it
//
// CO-INTERMENT
// multiple Active interments may point at the same grave
// this file does not enforce grave.status = 'Vacant' when creating or editing an Active interment
// grave status is derived from interments via rederiveGraveStatus()
//
// RESERVATION-AWARE LOCKS
// while a reservation is Active its anchors are locked
// the incoming person (reservations.pending_interment_id)
// the old occupant (reservations.old_interment_id)
// the target grave (reservations.target_grave_id)
// the old occupant's destination grave (reservations.old_new_grave_id)
// this file refuses to edit or delete a locked interment
// this file refuses to move any interment into a locked grave
// this file refuses to create a new interment in a locked grave
// this file does allow moving a bystander out of a locked grave, the reservation only cares that the target eventually holds exactly N
// this file does allow editing records that no Active reservation references
//
// HISTORY
// placement_history records physical placements only
// field edits like name corrections, contact updates, or permits added are not logged
// Initial means current_grave_id went from NULL to a grave
// Move means current_grave_id went from one grave to another
// Removal means current_grave_id went from a grave to NULL
// a POST that creates a row already Active with a grave also logs an Initial event
// a POST that creates an Inactive row or an Active row without a grave logs nothing, nothing moved
// DELETE does not log, deleted_at is a record-keeping flag not a movement
// a PUT that only changes fields and not the grave logs nothing
//
// RESPONSE SHAPE
// both GET handlers return an interments array
// each item is a live row with is_history: false
// each item carries its own history array of placement entries with is_history: true
// the single-ID handler keeps the historical flat shape too
// the top-level array still contains the live row at index 0 and each history entry at indexes 1..n for backwards compatibility

define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'logger.php';
require_once 'reusable_functions.php';

$userData = checkuser();
$method   = $_SERVER['REQUEST_METHOD'] ?? null;

$role = $userData['role'] ?? null;
if (!in_array($role, [ROLE_ADMIN, ROLE_OFFICE], true)) {
    Response::error("Forbidden. You do not have permission.", 403);
}

$rawData = array_merge(
    json_decode(file_get_contents("php://input"), true) ?: [],
    $_POST ?? []
);

$pathInfo   = $_GET['path_info'] ?? $_SERVER['PATH_INFO'] ?? '';
$pathParts  = array_filter(explode('/', trim($pathInfo, '/')));
$resourceId = array_shift($pathParts);

$userId = (int) $userData['user_id'];

// Shape a live or snapshot row into the JSON structure the client expects
$formatInterment = function (array $r): array {
    $g = function ($key, $default = null) use ($r) {
        return array_key_exists($key, $r) ? $r[$key] : $default;
    };
    return [
        'interment_id'                    => (int) $r['interment_id'],
        'control_number'                  => $g('control_number'),
        'deceased_name'                   => $g('deceased_name'),
        'deceased_sex'                    => $g('deceased_sex'),
        'last_known_address'              => $g('last_known_address'),
        'death_certificate'               => $g('death_certificate'),
        'deceased_date_of_birth'          => $g('deceased_date_of_birth'),
        'deceased_date_of_death'          => $g('deceased_date_of_death'),
        'current_grave_id'                => $g('current_grave_id') !== null ? (int) $g('current_grave_id') : null,
        'grave_code'                      => $g('grave_code'),
        'row_num'                         => $g('row_num') !== null ? (int) $g('row_num') : null,
        'col_num'                         => $g('col_num') !== null ? (int) $g('col_num') : null,
        'grave_status'                    => $g('grave_status'),
        'grave_remarks'                   => $g('grave_remarks'),
        'block_id'                        => $g('block_id') !== null ? (int) $g('block_id') : null,
        'block_name'                      => $g('block_name'),
        'block_type'                      => $g('block_type'),
        'contact_person_name'             => $g('contact_person_name'),
        'contact_person_phone_number'     => $g('contact_person_phone_number'),
        'contact_person_email'            => $g('contact_person_email'),
        'contact_person_address'          => $g('contact_person_address'),
        'contact_person_address_barangay' => $g('contact_person_address_barangay'),
        'assistance_type'                 => $g('assistance_type'),
        'burial_permit_number'            => $g('burial_permit_number'),
        'burial_permit_date'              => $g('burial_permit_date'),
        'transfer_permit_number'          => $g('transfer_permit_number'),
        'transfer_permit_issued_by'       => $g('transfer_permit_issued_by'),
        'transfer_permit_date'            => $g('transfer_permit_date'),
        'exhumation_permit_number'        => $g('exhumation_permit_number'),
        'exhumation_permit_date'          => $g('exhumation_permit_date'),
        'date_buried'                     => $g('date_buried'),
        'date_exhumed'                    => $g('date_exhumed'),
        'burial_clearance_date'           => $g('burial_clearance_date'),
        'lease_expiration_date'           => $g('lease_expiration_date'),
        'status'                          => $g('status'),
        'remarks'                         => $g('remarks'),
        'created_at'                      => $g('created_at'),
        'updated_at'                      => $g('updated_at'),
    ];
};

// Build one history item from a placement_history row plus its grave joins
$buildHistoryRow = function (array $e) use ($formatInterment): array {
    $before = json_decode((string) $e['snapshot_before'], true) ?: [];
    $after  = json_decode((string) $e['snapshot_after'],  true) ?: [];

    // Base the display state on snapshot_before, then override with the from-grave join
    $base = $before;
    $base['grave_code']       = $e['from_grave_code'];
    $base['row_num']          = $e['from_row_num'];
    $base['col_num']          = $e['from_col_num'];
    $base['grave_status']     = $e['from_grave_status'];
    $base['grave_remarks']    = $e['from_grave_remarks'];
    $base['block_id']         = $e['from_block_id'];
    $base['block_name']       = $e['from_block_name'];
    $base['block_type']       = $e['from_block_type'];

    $row = $formatInterment($base);
    $row['is_history']    = true;
    $row['history_id']    = (int) $e['history_id'];
    $row['event_type']    = $e['event_type'];
    $row['event_date']    = $e['event_date'];
    $row['reason']        = $e['reason'];
    $row['related_interment_id'] = $e['related_interment_id'] !== null ? (int) $e['related_interment_id'] : null;
    $row['reservation_id'] = $e['reservation_id'] !== null ? (int) $e['reservation_id'] : null;

    $row['from_grave'] = $e['from_grave_id'] ? [
        'grave_id'   => (int) $e['from_grave_id'],
        'grave_code' => $e['from_grave_code'],
        'row_num'    => $e['from_row_num'] !== null ? (int) $e['from_row_num'] : null,
        'col_num'    => $e['from_col_num'] !== null ? (int) $e['from_col_num'] : null,
        'block_id'   => $e['from_block_id'] !== null ? (int) $e['from_block_id'] : null,
        'block_name' => $e['from_block_name'],
        'block_type' => $e['from_block_type'],
    ] : null;

    $row['to_grave'] = $e['to_grave_id'] ? [
        'grave_id'   => (int) $e['to_grave_id'],
        'grave_code' => $e['to_grave_code'],
        'row_num'    => $e['to_row_num'] !== null ? (int) $e['to_row_num'] : null,
        'col_num'    => $e['to_col_num'] !== null ? (int) $e['to_col_num'] : null,
        'block_id'   => $e['to_block_id'] !== null ? (int) $e['to_block_id'] : null,
        'block_name' => $e['to_block_name'],
        'block_type' => $e['to_block_type'],
    ] : null;

    $row['state_after'] = $after;

    return $row;
};

// Shared column list for placement history so both GET handlers stay in sync
$historySelectSql = "
    SELECT ph.*,
           fg.grave_code AS from_grave_code, fg.row_num AS from_row_num, fg.col_num AS from_col_num,
           fg.status AS from_grave_status, fg.remarks AS from_grave_remarks,
           fb.block_id AS from_block_id, fb.block_name AS from_block_name, fb.block_type AS from_block_type,
           tg.grave_code AS to_grave_code, tg.row_num AS to_row_num, tg.col_num AS to_col_num,
           tg.status AS to_grave_status, tg.remarks AS to_grave_remarks,
           tb.block_id AS to_block_id, tb.block_name AS to_block_name, tb.block_type AS to_block_type
    FROM placement_history ph
    LEFT JOIN graves fg ON fg.grave_id = ph.from_grave_id AND fg.deleted_at IS NULL
    LEFT JOIN blocks fb ON fb.block_id = fg.block_id        AND fb.deleted_at IS NULL
    LEFT JOIN graves tg ON tg.grave_id = ph.to_grave_id     AND tg.deleted_at IS NULL
    LEFT JOIN blocks tb ON tb.block_id = tg.block_id        AND tb.deleted_at IS NULL
";

if ($method === 'GET') {

    if ($resourceId && is_numeric($resourceId)) {
        $id = (int) $resourceId;

        $stmt = $pdo->prepare("
            SELECT i.*,
                   g.grave_code, g.row_num, g.col_num,
                   g.status AS grave_status, g.remarks AS grave_remarks,
                   b.block_id, b.block_name, b.block_type
            FROM interments i
            LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
            LEFT JOIN blocks b ON b.block_id = g.block_id         AND b.deleted_at IS NULL
            WHERE i.interment_id = ? AND i.deleted_at IS NULL
        ");
        $stmt->execute([$id]);
        $live = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$live) {
            Response::error('Interment not found.', 404);
        }

        // Flat shape: live row first, history rows after
        $interments = [];
        $liveFormatted = $formatInterment($live);
        $liveFormatted['is_history'] = false;
        $interments[] = $liveFormatted;

        $histStmt = $pdo->prepare(
            $historySelectSql . "
            WHERE ph.interment_id = ?
            ORDER BY ph.event_date DESC, ph.history_id DESC
        "
        );
        $histStmt->execute([$id]);
        $events = $histStmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($events as $e) {
            $interments[] = $buildHistoryRow($e);
        }

        Response::success('Interment retrieved', ['interments' => $interments]);
    }

    $searchTerm = trim((string) ($_GET['search_term'] ?? ''));
    if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
        Response::error("Search term must be at least 3 characters long", 400);
    }
    $hasSearch = ($searchTerm !== '');

    $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
    $page  = max(1, (int) ($_GET['page'] ?? 1));

    // Status filter defaults to both Active and Inactive
    $statusRaw = $_GET['status'] ?? '';
    if (is_array($statusRaw)) {
        $statusRaw = implode(',', $statusRaw);
    }
    $wantedStatuses = [];
    if (trim((string) $statusRaw) !== '') {
        foreach (explode(',', strtolower(trim((string) $statusRaw))) as $s) {
            $s = trim($s);
            if ($s === '') continue;
            $cased = ucfirst($s);
            if (!in_array($cased, ['Active', 'Inactive'], true)) {
                Response::error("Invalid status '$s'. Allowed: active, inactive.", 400);
            }
            $wantedStatuses[] = $cased;
        }
    }

    $where         = ["i.deleted_at IS NULL", "i.status IN ('Active', 'Inactive')"];
    $statusParams  = [];

    if (!empty($wantedStatuses)) {
        $ph = implode(',', array_fill(0, count($wantedStatuses), '?'));
        $where[1] = "i.status IN ($ph)";
        $statusParams = $wantedStatuses;
    }

    $liveMatchSQL       = '';
    $liveMatchParams    = [];
    $historyMatchSQL    = '';
    $historyMatchParams = [];

    if ($hasSearch) {
        $like = '%' . $searchTerm . '%';

        // Parsed once and reused for live and history branches, plain text adds no clauses
        $dateCriteria = convert_dates($searchTerm);

        $liveCols = [
            'i.control_number',
            'i.deceased_name',
            'i.deceased_sex',
            'i.last_known_address',
            'i.death_certificate',
            'i.contact_person_name',
            'i.contact_person_phone_number',
            'i.contact_person_email',
            'i.contact_person_address',
            'i.contact_person_address_barangay',
            'i.assistance_type',
            'i.burial_permit_number',
            'i.transfer_permit_number',
            'i.transfer_permit_issued_by',
            'i.exhumation_permit_number',
            'i.status',
            'i.remarks',
            'g.grave_code',
            'g.status',
            'g.remarks',
            'b.block_name',
            'b.block_type',
        ];
        $parts = [];
        foreach ($liveCols as $c) {
            $parts[] = "$c LIKE ?";
            $liveMatchParams[] = $like;
        }

        // DATE()/MONTH()/DAY()/YEAR() skip indexes but LIKE '%...%' already forced a scan
        $liveDateCols = [
            'i.deceased_date_of_birth',
            'i.deceased_date_of_death',
            'i.burial_permit_date',
            'i.transfer_permit_date',
            'i.exhumation_permit_date',
            'i.date_buried',
            'i.date_exhumed',
            'i.burial_clearance_date',
            'i.lease_expiration_date',
            'i.created_at',
            'i.updated_at',
        ];

        foreach ($dateCriteria['exact_dates'] as $d) {
            foreach ($liveDateCols as $col) {
                $parts[] = "DATE($col) = ?";
                $liveMatchParams[] = $d;
            }
        }
        foreach ($dateCriteria['month_days'] as $md) {
            foreach ($liveDateCols as $col) {
                $parts[] = "(MONTH($col) = ? AND DAY($col) = ?)";
                $liveMatchParams[] = $md['m'];
                $liveMatchParams[] = $md['d'];
            }
        }
        foreach ($dateCriteria['year_months'] as $ym) {
            foreach ($liveDateCols as $col) {
                $parts[] = "(YEAR($col) = ? AND MONTH($col) = ?)";
                $liveMatchParams[] = $ym['y'];
                $liveMatchParams[] = $ym['m'];
            }
        }
        foreach ($dateCriteria['years'] as $y) {
            foreach ($liveDateCols as $col) {
                $parts[] = "YEAR($col) = ?";
                $liveMatchParams[] = $y;
            }
        }

        $liveMatchSQL = '(' . implode(' OR ', $parts) . ')';

        $histCols = [
            'ph.reason',
            'ph.event_type',
            'fg.grave_code',
            'fb.block_name',
            'fb.block_type',
            'tg.grave_code',
            'tb.block_name',
            'tb.block_type',
        ];
        $parts = [];
        foreach ($histCols as $c) {
            $parts[] = "$c LIKE ?";
            $historyMatchParams[] = $like;
        }

        // Same date criteria against placement_history.event_date
        foreach ($dateCriteria['exact_dates'] as $d) {
            $parts[] = "DATE(ph.event_date) = ?";
            $historyMatchParams[] = $d;
        }
        foreach ($dateCriteria['month_days'] as $md) {
            $parts[] = "(MONTH(ph.event_date) = ? AND DAY(ph.event_date) = ?)";
            $historyMatchParams[] = $md['m'];
            $historyMatchParams[] = $md['d'];
        }
        foreach ($dateCriteria['year_months'] as $ym) {
            $parts[] = "(YEAR(ph.event_date) = ? AND MONTH(ph.event_date) = ?)";
            $historyMatchParams[] = $ym['y'];
            $historyMatchParams[] = $ym['m'];
        }
        foreach ($dateCriteria['years'] as $y) {
            $parts[] = "YEAR(ph.event_date) = ?";
            $historyMatchParams[] = $y;
        }

        $historyMatchSQL = '(' . implode(' OR ', $parts) . ')';

        // A record matches if its live fields match OR any history entry matches
        $historyExistsSql = "
            EXISTS (
                SELECT 1
                FROM placement_history ph
                LEFT JOIN graves fg ON fg.grave_id = ph.from_grave_id AND fg.deleted_at IS NULL
                LEFT JOIN blocks fb ON fb.block_id = fg.block_id        AND fb.deleted_at IS NULL
                LEFT JOIN graves tg ON tg.grave_id = ph.to_grave_id     AND tg.deleted_at IS NULL
                LEFT JOIN blocks tb ON tb.block_id = tg.block_id        AND tb.deleted_at IS NULL
                WHERE ph.interment_id = i.interment_id
                  AND $historyMatchSQL
            )
        ";
        $where[] = "($liveMatchSQL OR $historyExistsSql)";
    }

    $whereSQL = ' WHERE ' . implode(' AND ', $where);

    // Params in SQL text order: status, then live search, then history search
    $outerParams = array_merge(
        $statusParams,
        $hasSearch ? $liveMatchParams    : [],
        $hasSearch ? $historyMatchParams : []
    );

    $countStmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM interments i
        LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON b.block_id = g.block_id         AND b.deleted_at IS NULL
        $whereSQL
    ");
    $countStmt->execute($outerParams);
    $totalRecords = (int) $countStmt->fetchColumn();

    $totalPages = (int) ceil($totalRecords / $limit);
    $page       = min($page, max(1, $totalPages));
    $offset     = ($page - 1) * $limit;

    $pageStmt = $pdo->prepare("
        SELECT i.*,
               g.grave_code, g.row_num, g.col_num,
               g.status AS grave_status, g.remarks AS grave_remarks,
               b.block_id, b.block_name, b.block_type
        FROM interments i
        LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
        LEFT JOIN blocks b ON b.block_id = g.block_id         AND b.deleted_at IS NULL
        $whereSQL
        ORDER BY i.interment_id DESC
        LIMIT $limit OFFSET $offset
    ");
    $pageStmt->execute($outerParams);
    $rows = $pageStmt->fetchAll(PDO::FETCH_ASSOC);

    // Split rows into "matched on record" vs "matched on history only"
    $liveMatchedIds = [];
    if ($hasSearch && !empty($rows)) {
        $pageIds = array_map(function ($r) {
            return (int) $r['interment_id'];
        }, $rows);
        $inPh    = implode(',', array_fill(0, count($pageIds), '?'));

        $checkStmt = $pdo->prepare("
            SELECT i.interment_id
            FROM interments i
            LEFT JOIN graves g ON g.grave_id = i.current_grave_id AND g.deleted_at IS NULL
            LEFT JOIN blocks b ON b.block_id = g.block_id         AND b.deleted_at IS NULL
            WHERE i.interment_id IN ($inPh)
              AND $liveMatchSQL
        ");
        $checkStmt->execute(array_merge($pageIds, $liveMatchParams));
        $liveMatchedIds = array_map(
            'intval',
            array_column($checkStmt->fetchAll(PDO::FETCH_ASSOC), 'interment_id')
        );
    }

    // Rows that matched on record get full history, rows that matched on history get only matching entries
    $historyByInterment = [];
    $fullHistoryIds     = [];
    $filteredHistoryIds = [];

    if (!empty($rows)) {
        foreach ($rows as $r) {
            $iid = (int) $r['interment_id'];
            if (!$hasSearch || in_array($iid, $liveMatchedIds, true)) {
                $fullHistoryIds[] = $iid;
            } else {
                $filteredHistoryIds[] = $iid;
            }
        }

        if (!empty($fullHistoryIds)) {
            $inPh = implode(',', array_fill(0, count($fullHistoryIds), '?'));
            $histStmt = $pdo->prepare(
                $historySelectSql . "
                WHERE ph.interment_id IN ($inPh)
                ORDER BY ph.interment_id ASC, ph.event_date DESC, ph.history_id DESC
            "
            );
            $histStmt->execute($fullHistoryIds);
            foreach ($histStmt->fetchAll(PDO::FETCH_ASSOC) as $e) {
                $iid = (int) $e['interment_id'];
                $historyByInterment[$iid][] = $buildHistoryRow($e);
            }
        }

        if (!empty($filteredHistoryIds)) {
            $inPh = implode(',', array_fill(0, count($filteredHistoryIds), '?'));
            $histStmt = $pdo->prepare(
                $historySelectSql . "
                WHERE ph.interment_id IN ($inPh)
                  AND $historyMatchSQL
                ORDER BY ph.interment_id ASC, ph.event_date DESC, ph.history_id DESC
            "
            );
            $histStmt->execute(array_merge($filteredHistoryIds, $historyMatchParams));
            foreach ($histStmt->fetchAll(PDO::FETCH_ASSOC) as $e) {
                $iid = (int) $e['interment_id'];
                $historyByInterment[$iid][] = $buildHistoryRow($e);
            }
        }
    }

    $items = [];
    foreach ($rows as $r) {
        $iid = (int) $r['interment_id'];
        $f = $formatInterment($r);
        $f['is_history']  = false;
        // matched_via tells the frontend whether the search hit the record or one of its history entries
        $f['matched_via'] = (!$hasSearch || in_array($iid, $liveMatchedIds, true))
            ? 'record'
            : 'history';
        $f['history'] = $historyByInterment[$iid] ?? [];
        $items[] = $f;
    }

    $payload = [
        'pagination' => [
            'current_page'  => $page,
            'per_page'      => $limit,
            'total_records' => $totalRecords,
            'total_pages'   => $totalPages,
        ],
        'interments' => $items,
    ];
    if ($searchTerm !== '') {
        $payload['search_term'] = $searchTerm;
    }
    if ($statusRaw) {
        $payload['status'] = $statusRaw;
    }

    Response::success('Interments retrieved', $payload);
}

if ($method === 'POST') {

    $required = ['control_number', 'deceased_name', 'assistance_type'];
    foreach ($required as $field) {
        if (empty($rawData[$field])) {
            Response::error("Field '$field' is required.", 400);
        }
    }

    $status = $rawData['status'] ?? 'Active';
    if (!in_array($status, ['Active', 'Inactive'], true)) {
        Response::error("Invalid status. Must be Active, or Inactive.", 400);
    }

    if (!in_array($rawData['assistance_type'], ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
        Response::error("Invalid assistance_type.", 400);
    }
    if (
        !empty($rawData['deceased_sex'])
        && !in_array($rawData['deceased_sex'], ['Male', 'Female', 'Unknown'], true)
    ) {
        Response::error("Invalid deceased_sex.", 400);
    }

    // Inactive rows never carry a grave
    $currentGraveId = !empty($rawData['current_grave_id']) ? (int) $rawData['current_grave_id'] : null;
    if ($status === 'Inactive') {
        $rawData['current_grave_id'] = null;
        $currentGraveId              = null;
    }

    $dateFields = [
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
    foreach ($dateFields as $field) {
        if (!empty($rawData[$field]) && !strtotime($rawData[$field])) {
            Response::error("Invalid date format for '$field'.", 400);
        }
    }

    $insertFields = [
        'control_number',
        'deceased_name',
        'deceased_sex',
        'last_known_address',
        'death_certificate',
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'current_grave_id',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'contact_person_address',
        'contact_person_address_barangay',
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
        'created_by',
        'updated_by',
    ];

    $placeholders = [];
    $values       = [];
    foreach ($insertFields as $f) {
        if ($f === 'status') {
            $val = $status;
        } elseif ($f === 'created_by' || $f === 'updated_by') {
            $val = $userId;
        } else {
            $val = isset($rawData[$f]) && $rawData[$f] !== '' ? $rawData[$f] : null;
        }
        $placeholders[] = '?';
        $values[]       = $val;
    }

    $pdo->beginTransaction();
    try {
        if ($currentGraveId) {
            lockGraveRows($pdo, [$currentGraveId]);

            $gc = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? AND deleted_at IS NULL");
            $gc->execute([$currentGraveId]);
            if (!$gc->fetch()) {
                throw new Exception("Current grave does not exist or is deleted.");
            }

            $lock = activePlanLockingGrave($pdo, $currentGraveId);
            if ($lock !== null) {
                throw new Exception("Grave is reserved by an Active reservation (#$lock). Cancel the reservation first.");
            }
        }

        $sql = "INSERT INTO interments (" . implode(', ', $insertFields) . ") VALUES (" . implode(', ', $placeholders) . ")";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($values);
        $newId = (int) $pdo->lastInsertId();

        // Only Active rows with a grave represent a physical placement
        if ($status === 'Active' && $currentGraveId) {
            $afterStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ?");
            $afterStmt->execute([$newId]);
            $after = $afterStmt->fetch(PDO::FETCH_ASSOC);

            // Synthetic before: Pending with no grave, so the log reads naturally
            $before = $after;
            $before['current_grave_id'] = null;
            $before['status']           = 'Pending';

            logPlacement(
                $pdo,
                $before,
                $after,
                'Initial',
                'Initial placement (created via Master File)',
                null,
                null,
                $userId
            );

            rederiveGraveStatus($pdo, $currentGraveId);
        }

        $pdo->commit();
        systemLog("Manual interment $newId created with status $status", $userId);

        Response::success("Interment created.", ['interment_id' => $newId], 201);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $sqlState = (string) $e->getCode();
        $msg      = $e->getMessage();

        if ($sqlState === '23000' && strpos($msg, 'uk_active_control_number') !== false) {
            Response::error("Conflict: Control number already exists.", 409);
        }
        if ($sqlState === 'HY000' && strpos($msg, 'chk_status_grave') !== false) {
            Response::error("Conflict: Only Active interments may have a current_grave_id.", 409);
        }
        if ($sqlState === '22007') {
            Response::error("The Date Formats are invalid, please check again!", 409);
        }
        systemLog("Record create DB error: " . $msg, 'System');
        Response::error("Database error while creating record.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Record create error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 400);
    }
}

if ($method === 'PUT') {

    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = (int) $resourceId;
    }
    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("
            SELECT * FROM interments
            WHERE interment_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $stmt->execute([$id]);
        $before = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$before) {
            $pdo->rollBack();
            Response::error("Interment not found.", 404);
        }

        $lock = activePlanLockingInterment($pdo, $id);
        if ($lock !== null) {
            $pdo->rollBack();
            Response::error("This record is part of an Active reservation (#$lock). Cancel or Confirm the reservation first.", 409);
        }

        // Pending rows belong to the Reserve / Monitor flow, not the Master File
        if ($before['status'] === 'Pending') {
            $pdo->rollBack();
            Response::error("Cannot edit a Pending interment. Use Monitor to Confirm or Cancel its reservation.", 409);
        }

        $updatable = [
            'control_number',
            'deceased_name',
            'deceased_sex',
            'last_known_address',
            'death_certificate',
            'deceased_date_of_birth',
            'deceased_date_of_death',
            'current_grave_id',
            'contact_person_name',
            'contact_person_phone_number',
            'contact_person_email',
            'contact_person_address',
            'contact_person_address_barangay',
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

        $dateFields = [
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

        $oldGraveId    = $before['current_grave_id'] !== null ? (int) $before['current_grave_id'] : null;
        $newGraveId    = $oldGraveId;
        $newStatus     = $before['status'];
        $statusChanged = false;
        $graveChanged  = false;

        $updates = [];
        $params  = [];

        foreach ($updatable as $f) {
            if (!array_key_exists($f, $rawData)) continue;
            $val = $rawData[$f];

            if (in_array($f, $dateFields, true) && !empty($val) && !strtotime($val)) {
                $pdo->rollBack();
                Response::error("Invalid date format for '$f'.", 400);
            }

            if ($f === 'status') {
                if (!in_array($val, ['Active', 'Inactive'], true)) {
                    $pdo->rollBack();
                    Response::error("Invalid status. Use Active or Inactive.", 400);
                }
                if ($val !== $newStatus) $statusChanged = true;
                $newStatus = $val;
            } elseif ($f === 'current_grave_id') {
                $candidate = !empty($val) ? (int) $val : null;
                if ((int) ($candidate ?? 0) !== (int) ($newGraveId ?? 0)) $graveChanged = true;
                $newGraveId = $candidate;
            } elseif ($f === 'assistance_type') {
                if (!in_array($val, ['Burial', 'Transfer the remains of the late', 'Other'], true)) {
                    $pdo->rollBack();
                    Response::error("Invalid assistance_type.", 400);
                }
            } elseif ($f === 'deceased_sex') {
                if ($val !== null && $val !== '' && !in_array($val, ['Male', 'Female', 'Unknown'], true)) {
                    $pdo->rollBack();
                    Response::error("Invalid deceased_sex.", 400);
                }
            }

            $updates[] = "$f = ?";
            $params[]  = $val !== '' ? $val : null;
        }

        // Becoming Inactive with no grave in the payload still needs the grave cleared
        if ($newStatus === 'Inactive' && !array_key_exists('current_grave_id', $rawData)) {
            if ($newGraveId !== null) {
                $newGraveId   = null;
                $graveChanged = true;
                $updates[]    = "current_grave_id = ?";
                $params[]     = null;
            }
        }

        // Non-Active rows must not have a grave (CHECK constraint)
        if ($newStatus !== 'Active' && $newGraveId !== null) {
            $pdo->rollBack();
            Response::error("Only Active interments may have a current_grave_id.", 400);
        }

        if (empty($updates)) {
            $pdo->rollBack();
            Response::error("No fields to update.", 400);
        }

        // Ascending order so two concurrent updates touching the same pair can't deadlock
        lockGraveRows($pdo, [$oldGraveId, $newGraveId]);

        // Moving into a new grave is blocked if a reservation is holding it
        if ($graveChanged && $newGraveId !== null) {
            $lock = activePlanLockingGrave($pdo, $newGraveId);
            if ($lock !== null) {
                $pdo->rollBack();
                Response::error("Cannot move into this grave: it is reserved by an Active reservation (#$lock).", 409);
            }
            $gc = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? AND deleted_at IS NULL");
            $gc->execute([$newGraveId]);
            if (!$gc->fetch()) {
                $pdo->rollBack();
                Response::error("Target grave does not exist.", 400);
            }
        }

        $updates[] = "updated_by = ?";
        $params[]  = $userId;
        $params[]  = $id;

        $sql = "UPDATE interments SET " . implode(', ', $updates) . " WHERE interment_id = ?";
        $updStmt = $pdo->prepare($sql);
        $updStmt->execute($params);

        $afterStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ?");
        $afterStmt->execute([$id]);
        $after = $afterStmt->fetch(PDO::FETCH_ASSOC);

        // Only log a placement when the grave actually changed, field edits don't touch the log
        if ($graveChanged) {
            if ($before['current_grave_id'] === null) {
                $eventType = 'Initial';
            } elseif ($after['current_grave_id'] === null) {
                $eventType = 'Removal';
            } else {
                $eventType = 'Move';
            }

            logPlacement(
                $pdo,
                $before,
                $after,
                $eventType,
                'Manual update via Master File',
                null,
                null,
                $userId
            );
        }

        if ($graveChanged) {
            if ($oldGraveId) rederiveGraveStatus($pdo, $oldGraveId);
            if ($newGraveId) rederiveGraveStatus($pdo, $newGraveId);
        } elseif ($statusChanged && $oldGraveId) {
            rederiveGraveStatus($pdo, $oldGraveId);
        }

        $pdo->commit();
        systemLog("Interment $id updated manually.", $userId);

        Response::success("Interment updated.", [
            'interment_id' => $id,
            'old_grave_id' => $oldGraveId,
            'new_grave_id' => $newGraveId,
            'new_status'   => $newStatus,
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $sqlState = (string) $e->getCode();
        $msg      = $e->getMessage();

        if ($sqlState === '23000' && strpos($msg, 'uk_active_control_number') !== false) {
            Response::error("Conflict: Control number already exists.", 409);
        }
        if ($sqlState === 'HY000' && strpos($msg, 'chk_status_grave') !== false) {
            Response::error("Conflict: Only Active interments may have a current_grave_id.", 409);
        }
        if ($sqlState === '22007') {
            Response::error("The Date Formats are invalid, please check again!", 409);
        }
        systemLog("Record update DB error: " . $msg, 'System');
        Response::error("Database error while updating record.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Record update error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

if ($method === 'DELETE') {

    if ($resourceId && is_numeric($resourceId)) {
        $rawData['interment_id'] = (int) $resourceId;
    }
    if (empty($rawData['interment_id'])) {
        Response::error("interment_id is required.", 400);
    }
    $id = (int) $rawData['interment_id'];

    $pdo->beginTransaction();
    try {
        $check = $pdo->prepare("
            SELECT interment_id, status, current_grave_id
            FROM interments
            WHERE interment_id = ? AND deleted_at IS NULL
            FOR UPDATE
        ");
        $check->execute([$id]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $pdo->rollBack();
            Response::error("Interment not found or already deleted.", 404);
        }

        // Pending rows belong to the Reserve / Monitor flow
        if ($row['status'] === 'Pending') {
            $pdo->rollBack();
            Response::error("Cannot delete a Pending interment. Cancel the reservation first via Monitor.", 409);
        }

        $lock = activePlanLockingInterment($pdo, $id);
        if ($lock !== null) {
            $pdo->rollBack();
            Response::error("This record is part of an Active reservation (#$lock). Cancel or Confirm the reservation first.", 409);
        }

        $graveId = $row['current_grave_id'] !== null ? (int) $row['current_grave_id'] : null;
        if ($graveId) {
            lockGraveRows($pdo, [$graveId]);
        }

        $upd = $pdo->prepare("
            UPDATE interments
            SET deleted_at = NOW(), updated_by = ?
            WHERE interment_id = ? AND deleted_at IS NULL
        ");
        $upd->execute([$userId, $id]);

        $graveFreed = false;
        if ($graveId) {
            $newGraveStatus = rederiveGraveStatus($pdo, $graveId);
            $graveFreed     = ($newGraveStatus === 'Vacant');
        }

        $pdo->commit();
        systemLog("Interment $id soft-deleted" . ($graveFreed ? " and freed grave $graveId" : ""), $userId);

        Response::success("Interment deleted (soft delete).", [
            'interment_id' => $id,
            'grave_id'     => $graveId,
            'grave_freed'  => $graveFreed,
        ]);
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Record delete DB error: " . $e->getMessage(), 'System');
        Response::error("Database error while deleting record.", 500);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        systemLog("Record delete error: " . $e->getMessage(), 'System');
        Response::error($e->getMessage(), 409);
    }
}

Response::error("Method Not Allowed", 405);
