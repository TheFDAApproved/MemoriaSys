<?php

/**
 * records.php – Master File. Full CRUD for interments.
 *
 * GET    /records.php/{id}  : One interment + its placement history
 * GET    /records.php       : List interments (Active / Inactive only),
 *                             each with its nested placement history
 * POST   /records.php       : Create a manual interment record
 * PUT    /records.php/{id}  : Update (blocked if an Active reservation locks it)
 * DELETE /records.php/{id}  : Soft-delete (blocked if an Active reservation locks it)
 *
 * CO-INTERMENT
 *   Multiple Active interments may point at the same grave. This file does
 *   NOT enforce grave.status = 'Vacant' when creating or editing an Active
 *   interment. Grave status is derived from `interments` via
 *   rederiveGraveStatus().
 *
 * RESERVATION-AWARE LOCKS
 *   While a reservation is Active, its anchors are locked:
 *     - The incoming person   (reservations.pending_interment_id)
 *     - The old occupant      (reservations.old_interment_id)
 *     - The target grave      (reservations.target_grave_id)
 *     - The old occupant's destination grave (reservations.old_new_grave_id)
 *
 *   This file refuses to:
 *     - Edit or delete a locked interment.
 *     - Move any interment INTO a locked grave.
 *     - Create a new interment in a locked grave.
 *
 *   It DOES allow:
 *     - Moving a bystander OUT of a locked grave (the reservation only cares
 *       that the target eventually holds exactly N; a bystander leaving is fine).
 *     - Editing records that aren't referenced by any Active reservation.
 *
 * HISTORY
 *   placement_history records PHYSICAL PLACEMENTS only.  Field edits
 *   (name correction, contact update, permit added) are NOT logged.
 *
 *   Event types produced by this file:
 *     - Initial  : current_grave_id went from NULL  -> a grave
 *     - Move     : current_grave_id went from grave -> a different grave
 *     - Removal  : current_grave_id went from grave -> NULL
 *
 *   POST that creates a row already Active with a grave also logs an
 *   'Initial' event. POST that creates an Inactive (or Active-without-grave)
 *   row does NOT log — nothing moved.
 *
 *   DELETE does NOT log. deleted_at is a record-keeping flag, not a movement.
 *
 *   A PUT that only changes fields (no grave change) logs nothing.
 *
 * RESPONSE SHAPE
 *   Both GET handlers return an `interments` array.  Each item is a LIVE
 *   row (is_history: false).  Each item carries its own `history` array of
 *   placement entries (is_history: true) inside it.
 *
 *   The single-ID handler keeps the historical flat shape too: the top-level
 *   array still contains BOTH the live row (index 0) and each history entry
 *   (indexes 1..n) for backwards compatibility.
 */

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

// -----------------------------------------------------------------------------
// Formatter for a live or snapshot row
// -----------------------------------------------------------------------------
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
    ];
};

// -----------------------------------------------------------------------------
// Build one history item from a placement_history row + its grave joins.
// Shared by the single-record handler and the list handler.
// -----------------------------------------------------------------------------
$buildHistoryRow = function (array $e) use ($formatInterment): array {
    $before = json_decode((string) $e['snapshot_before'], true) ?: [];
    $after  = json_decode((string) $e['snapshot_after'],  true) ?: [];

    // Display the "state at the time of the event" using snapshot_before
    // as the base. Override grave fields with the from-grave join.
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

// The history SELECT is shared too — same column list in both handlers.
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

// =============================================================================
// GET
// =============================================================================
if ($method === 'GET') {

    // -------------------------------------------------------------------------
    // GET /records.php/{id} — one interment + placement history
    //
    // FLAT shape (backwards-compatible):
    //   interments[0]      = live row, is_history = false
    //   interments[1..n]   = history rows, is_history = true
    // -------------------------------------------------------------------------
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

        $interments = [];
        $liveFormatted = $formatInterment($live);
        $liveFormatted['is_history'] = false;
        $interments[] = $liveFormatted;

        // History entries for this interment
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

    // -------------------------------------------------------------------------
    // GET /records.php — list
    //
    // NESTED shape (paginated over LIVE records):
    //   interments[i]              = live row, is_history = false
    //   interments[i]['history']   = array of history rows, is_history = true
    //
    // SEARCH SCOPE (when search_term is provided)
    //   A live row is included if EITHER:
    //     - the row's own fields match (name, grave, contacts, etc.), OR
    //     - one of its placement_history entries matches
    //       (reason, event_type, from/to grave codes and blocks).
    //
    //   When a row matches via its history only, its nested `history` array
    //   is filtered to just the matching entries.
    //
    //   The item-level `matched_via` field ('record' | 'history') tells the
    //   frontend which dimension the match came from.  Only meaningful when
    //   a search term was provided.
    // -------------------------------------------------------------------------
    $searchTerm = trim((string) ($_GET['search_term'] ?? ''));
    if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
        Response::error("Search term must be at least 3 characters long", 400);
    }
    $hasSearch = ($searchTerm !== '');

    $limit = max(1, min((int) ($_GET['limit'] ?? 100), 500));
    $page  = max(1, (int) ($_GET['page'] ?? 1));

    // Status filter: Active, Inactive (comma-separated). Default: both.
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

    // ---- Build search clauses (live + history) -----------------------------
    $liveMatchSQL       = '';
    $liveMatchParams    = [];
    $historyMatchSQL    = '';
    $historyMatchParams = [];

    if ($hasSearch) {
        $like = '%' . $searchTerm . '%';

        // Live-row columns
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
        $liveMatchSQL = '(' . implode(' OR ', $parts) . ')';

        // History columns
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
        $historyMatchSQL = '(' . implode(' OR ', $parts) . ')';

        // Outer WHERE: (live OR history exists)
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

    // Params in SQL text order for the outer queries:
    //   status  → live (if search)  → history (if search)
    $outerParams = array_merge(
        $statusParams,
        $hasSearch ? $liveMatchParams    : [],
        $hasSearch ? $historyMatchParams : []
    );

    // ---- Count -------------------------------------------------------------
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

    // ---- Page fetch --------------------------------------------------------
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

    // ---- Classify rows: matched on record vs. matched on history only ------
    $liveMatchedIds = [];   // rows whose LIVE fields match the search
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

    // ---- Fetch nested history ----------------------------------------------
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

        // Full history for rows whose live fields matched (or no search)
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

        // Filtered history for rows that matched only via history
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

    // ---- Build items -------------------------------------------------------
    $items = [];
    foreach ($rows as $r) {
        $iid = (int) $r['interment_id'];
        $f = $formatInterment($r);
        $f['is_history']  = false;
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

    Response::success('Interments retrieved', $payload);
}

// =============================================================================
// POST — create a manual interment
// =============================================================================
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

    // Inactive rows never carry a grave.
    $currentGraveId = !empty($rawData['current_grave_id']) ? (int) $rawData['current_grave_id'] : null;
    if ($status === 'Inactive') {
        $rawData['current_grave_id'] = null;
        $currentGraveId              = null;
    }

    // Date validation
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

        // Log the initial placement if the row starts Active with a grave.
        if ($status === 'Active' && $currentGraveId) {
            $afterStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ?");
            $afterStmt->execute([$newId]);
            $after = $afterStmt->fetch(PDO::FETCH_ASSOC);

            // Synthetic "before": Pending, no grave.
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

// =============================================================================
// PUT — update an interment
// =============================================================================
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
        // Lock the row
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

        // Reservation lock on the interment itself
        $lock = activePlanLockingInterment($pdo, $id);
        if ($lock !== null) {
            $pdo->rollBack();
            Response::error("This record is part of an Active reservation (#$lock). Cancel or Confirm the reservation first.", 409);
        }

        // Never allow editing Pending rows via the Master File.
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

        // Becoming Inactive without an explicit grave change: clear the grave.
        if ($newStatus === 'Inactive' && !array_key_exists('current_grave_id', $rawData)) {
            if ($newGraveId !== null) {
                $newGraveId   = null;
                $graveChanged = true;
                $updates[]    = "current_grave_id = ?";
                $params[]     = null;
            }
        }

        // Non-Active rows must not have a grave.
        if ($newStatus !== 'Active' && $newGraveId !== null) {
            $pdo->rollBack();
            Response::error("Only Active interments may have a current_grave_id.", 400);
        }

        if (empty($updates)) {
            $pdo->rollBack();
            Response::error("No fields to update.", 400);
        }

        // Lock affected graves in ascending order.
        lockGraveRows($pdo, [$oldGraveId, $newGraveId]);

        // If moving into a new grave, that grave must not be locked by a reservation.
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

        // Audit + apply
        $updates[] = "updated_by = ?";
        $params[]  = $userId;
        $params[]  = $id;

        $sql = "UPDATE interments SET " . implode(', ', $updates) . " WHERE interment_id = ?";
        $updStmt = $pdo->prepare($sql);
        $updStmt->execute($params);

        // Read after
        $afterStmt = $pdo->prepare("SELECT * FROM interments WHERE interment_id = ?");
        $afterStmt->execute([$id]);
        $after = $afterStmt->fetch(PDO::FETCH_ASSOC);

        // ---------------------------------------------------------------------
        // Write placement history ONLY when the grave changed.
        //
        // Field edits (name, contacts, permits) are NOT logged.  They only
        // modify the live interments row.
        // ---------------------------------------------------------------------
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

        // Re-derive affected graves.
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

// =============================================================================
// DELETE — soft-delete
// =============================================================================
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

        // Pending rows are owned by the Reserve / Monitor flow.
        if ($row['status'] === 'Pending') {
            $pdo->rollBack();
            Response::error("Cannot delete a Pending interment. Cancel the reservation first via Monitor.", 409);
        }

        // Reservation lock on the interment.
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
