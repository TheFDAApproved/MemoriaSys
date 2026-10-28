<?php

require_once 'notallowed.php';

// Normalize 09xxxxxxxxx, 9xxxxxxxxx, or 639xxxxxxxxx to +639xxxxxxxxx
// Strict mode returns false for anything else, non-strict returns the input unchanged
function formatPhNumber($number, $strict = true)
{
    $clean = preg_replace('/[^0-9]/', '', $number);
    if (strlen($clean) == 11 && substr($clean, 0, 2) == '09') {
        $clean = '63' . substr($clean, 1);
    } elseif (strlen($clean) == 10 && substr($clean, 0, 1) == '9') {
        $clean = '63' . $clean;
    }
    if (substr($clean, 0, 3) == '639' && strlen($clean) == 12) {
        return '+' . $clean;
    }
    if (!$strict) return $number;
    return false;
}

// Return a normalized PH phone number, or 400 if it can't be parsed
function validatePhone($phone)
{
    $formatted = formatPhNumber($phone);
    if (!$formatted) {
        Response::error('Invalid Philippines phone number format.', 400);
    }
    return $formatted;
}

// Shared helpers used by reserve.php, monitor.php, records.php
// logPlacement is the only thing that inserts into placement_history
// Grave status is always derived from interments, never set by hand
// Grave locks are always taken in ascending grave_id order to avoid deadlocks
// Reservation checks always filter on reservation_state = 'Active'

// Update a grave's status from its interments and return the new status, or null if the grave is gone
// Occupied means at least one Active non-deleted interment, Vacant means none
// Caller must already hold a FOR UPDATE lock on this grave or the result is racy
function rederiveGraveStatus(PDO $pdo, int $graveId): ?string
{
    $stmt = $pdo->prepare("
        UPDATE graves g
        SET g.status = CASE
            WHEN EXISTS (
                SELECT 1 FROM interments i
                WHERE i.current_grave_id = g.grave_id
                  AND i.status = 'Active'
                  AND i.deleted_at IS NULL
            ) THEN 'Occupied'
            ELSE 'Vacant'
        END
        WHERE g.grave_id = ?
    ");
    $stmt->execute([$graveId]);

    $read = $pdo->prepare("SELECT status FROM graves WHERE grave_id = ?");
    $read->execute([$graveId]);
    $val = $read->fetchColumn();
    return $val === false ? null : (string) $val;
}

// Take FOR UPDATE locks on these graves in ascending grave_id order so two requests needing the same pair don't deadlock
// Nulls, zeros, and negatives are dropped
function lockGraveRows(PDO $pdo, array $graveIds): void
{
    $graveIds = array_values(array_unique(array_filter(
        array_map('intval', $graveIds),
        function ($v) {
            return $v > 0;
        }
    )));

    if (empty($graveIds)) {
        return;
    }

    sort($graveIds, SORT_NUMERIC);

    $stmt = $pdo->prepare("SELECT grave_id FROM graves WHERE grave_id = ? FOR UPDATE");
    foreach ($graveIds as $gid) {
        $stmt->execute([$gid]);
    }
}

// Append one placement_history row, storing the before/after interment snapshots as JSON
// This is the only place that inserts into placement_history, every physical move goes through it
// Field edits (name, contact, permits) must NOT call this, only real moves
// event_type must be Initial, Move, or Removal
function logPlacement(
    PDO $pdo,
    array $before,
    array $after,
    string $eventType,
    ?string $reason,
    ?int $reservationId,
    ?int $relatedIntermentId,
    int $createdBy
): int {
    if (!in_array($eventType, ['Initial', 'Move', 'Removal'], true)) {
        throw new InvalidArgumentException("Invalid event_type: $eventType");
    }

    $stmt = $pdo->prepare("
        INSERT INTO placement_history (
            interment_id,
            event_type,
            from_grave_id,
            to_grave_id,
            event_date,
            reason,
            related_interment_id,
            reservation_id,
            snapshot_before,
            snapshot_after,
            created_by
        ) VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)
    ");

    $stmt->execute([
        (int) $after['interment_id'],
        $eventType,
        $before['current_grave_id'] !== null ? (int) $before['current_grave_id'] : null,
        $after['current_grave_id']  !== null ? (int) $after['current_grave_id']  : null,
        $reason,
        $relatedIntermentId,
        $reservationId,
        json_encode($before, JSON_UNESCAPED_UNICODE),
        json_encode($after,  JSON_UNESCAPED_UNICODE),
        $createdBy,
    ]);

    return (int) $pdo->lastInsertId();
}

// While a reservation is Active its anchors are locked: target_grave_id, pending_interment_id, old_interment_id, old_new_grave_id
// records.php and reserve.php call these before touching anything the reservation depends on

// Return the reservation_id that is holding this interment, or null if none
function activePlanLockingInterment(PDO $pdo, int $intermentId): ?int
{
    $stmt = $pdo->prepare("
        SELECT reservation_id FROM reservations
        WHERE reservation_state = 'Active'
          AND (pending_interment_id = ? OR old_interment_id = ?)
        LIMIT 1
    ");
    $stmt->execute([$intermentId, $intermentId]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int) $id;
}

// Return the reservation_id that is holding this grave, or null if none
function activePlanLockingGrave(PDO $pdo, int $graveId): ?int
{
    $stmt = $pdo->prepare("
        SELECT reservation_id FROM reservations
        WHERE reservation_state = 'Active'
          AND (target_grave_id = ? OR old_new_grave_id = ?)
        LIMIT 1
    ");
    $stmt->execute([$graveId, $graveId]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int) $id;
}

// Turn a free-text search term into structured date criteria the SQL builder can use
// Returns ['exact_dates'=>[], 'month_days'=>[], 'year_months'=>[], 'years'=>[]]
// Deliberately not using strtotime() since it turns things like "next week" or "abc" into dates
function convert_dates($searchTerm)
{
    $result = [
        'exact_dates' => [],
        'month_days'  => [],
        'year_months' => [],
        'years'       => [],
    ];

    $term = trim((string) $searchTerm);
    if ($term === '') {
        return $result;
    }

    // Strip ordinal suffixes: 1st / 2nd / 3rd / 12th to 1 / 2 / 3 / 12
    $term  = preg_replace('/(\d+)(st|nd|rd|th)\b/i', '$1', $term);
    $term  = preg_replace('/\s+/', ' ', $term);
    $lower = strtolower($term);

    $monthNames = [
        'january' => 1,
        'jan' => 1,
        'february' => 2,
        'feb' => 2,
        'march' => 3,
        'mar' => 3,
        'april' => 4,
        'apr' => 4,
        'may' => 5,
        'june' => 6,
        'jun' => 6,
        'july' => 7,
        'jul' => 7,
        'august' => 8,
        'aug' => 8,
        'september' => 9,
        'sep' => 9,
        'sept' => 9,
        'october' => 10,
        'oct' => 10,
        'november' => 11,
        'nov' => 11,
        'december' => 12,
        'dec' => 12,
    ];
    $monthRegex = implode('|', array_keys($monthNames));

    // 2025-10-12, 2025/10/12, or 2025.10.12
    if (preg_match('/\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/', $term, $m)) {
        $y = (int) $m[1];
        $mo = (int) $m[2];
        $d = (int) $m[3];
        if (checkdate($mo, $d, $y)) {
            $result['exact_dates'][] = sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }
    }

    // 10/12/2025, 10-12-2025, or 10.12.2025 (US order)
    if (preg_match('/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\b/', $term, $m)) {
        $mo = (int) $m[1];
        $d = (int) $m[2];
        $y = (int) $m[3];
        if (checkdate($mo, $d, $y)) {
            $result['exact_dates'][] = sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }
    }

    // 10/12/25 or 10-12-25, assumes 2025
    if (preg_match('/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2})\b/', $term, $m)) {
        $mo = (int) $m[1];
        $d = (int) $m[2];
        $y = 2000 + (int) $m[3];
        if (checkdate($mo, $d, $y)) {
            $result['exact_dates'][] = sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }
    }

    // Day then month name: "12 oct 2025" or "12 october"
    // The \b after day stops "12 oct 2025" from being read as "12 20"
    if (preg_match("/\b(\d{1,2})\s+($monthRegex)\b(?:,?\s+(\d{4}))?/i", $lower, $m)) {
        $d  = (int) $m[1];
        $mo = $monthNames[strtolower($m[2])];
        $y  = isset($m[3]) ? (int) $m[3] : null;
        if ($y !== null) {
            if (checkdate($mo, $d, $y)) {
                $result['exact_dates'][] = sprintf('%04d-%02d-%02d', $y, $mo, $d);
            }
        } elseif ($d >= 1 && $d <= 31) {
            $result['month_days'][] = ['m' => $mo, 'd' => $d];
        }
    }

    // Month then day: "oct 12 2025" or "october 12, 2025"
    // The \b after day stops "may 2025" from being read as "may 20"
    if (preg_match("/\b($monthRegex)\s+(\d{1,2})\b(?:,?\s+(\d{4}))?/i", $lower, $m)) {
        $mo = $monthNames[strtolower($m[1])];
        $d  = (int) $m[2];
        $y  = isset($m[3]) ? (int) $m[3] : null;
        if ($y !== null) {
            if (checkdate($mo, $d, $y)) {
                $result['exact_dates'][] = sprintf('%04d-%02d-%02d', $y, $mo, $d);
            }
        } elseif ($d >= 1 && $d <= 31) {
            $result['month_days'][] = ['m' => $mo, 'd' => $d];
        }
    }

    // Month name and year only: "oct 2025"
    // Anchored so "12 oct 2025" doesn't also match the whole month
    if (preg_match('/^\s*(' . $monthRegex . ')\s+(\d{4})\s*\z/i', $lower, $m)) {
        $mo = $monthNames[strtolower($m[1])];
        $y  = (int) $m[2];
        if ($y >= 1900 && $y <= 2100) {
            $result['year_months'][] = ['y' => $y, 'm' => $mo];
        }
    }

    // MM/YYYY or MM-YYYY
    // Anchored so "10/12/2025" doesn't also match "12/2025"
    if (preg_match('/^\s*(\d{1,2})[-\/.](\d{4})\s*\z/', $term, $m)) {
        $mo = (int) $m[1];
        $y = (int) $m[2];
        if ($mo >= 1 && $mo <= 12 && $y >= 1900 && $y <= 2100) {
            $result['year_months'][] = ['y' => $y, 'm' => $mo];
        }
    }

    // Bare MM/DD with no year
    // Anchored so it only fires when the whole term is a month/day pair
    if (preg_match('#^\s*(\d{1,2})/(\d{1,2})\s*\z#', $term, $m)) {
        $mo = (int) $m[1];
        $d = (int) $m[2];
        if ($mo >= 1 && $mo <= 12 && $d >= 1 && $d <= 31) {
            $result['month_days'][] = ['m' => $mo, 'd' => $d];
        }
    }

    // Bare year like 2025
    if (preg_match('/^\d{4}\z/', $term)) {
        $y = (int) $term;
        if ($y >= 1900 && $y <= 2100) {
            $result['years'][] = $y;
        }
    }

    // Drop duplicates
    $result['exact_dates'] = array_values(array_unique($result['exact_dates']));
    $result['years']       = array_values(array_unique($result['years']));

    $seen = [];
    $result['month_days'] = array_values(array_filter(
        $result['month_days'],
        function ($x) use (&$seen) {
            $k = $x['m'] . '-' . $x['d'];
            if (isset($seen[$k])) return false;
            $seen[$k] = true;
            return true;
        }
    ));
    $seen = [];
    $result['year_months'] = array_values(array_filter(
        $result['year_months'],
        function ($x) use (&$seen) {
            $k = $x['y'] . '-' . $x['m'];
            if (isset($seen[$k])) return false;
            $seen[$k] = true;
            return true;
        }
    ));

    return $result;
}
