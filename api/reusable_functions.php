<?php

require_once 'notallowed.php';

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

/**
 * reusable_functions.php
 *
 * Shared helpers for the cemetery system.
 * Used by reserve.php, monitor.php, records.php.
 *
 * Contains:
 *   - rederiveGraveStatus()            Grave status derivation from interments
 *   - lockGraveRows()                  FOR UPDATE locks in ascending order
 *   - logPlacement()                   Append-only write to placement_history
 *   - activePlanLockingInterment()     Is this interment referenced by an Active reservation?
 *   - activePlanLockingGrave()         Is this grave referenced by an Active reservation?
 *
 * Design rules enforced here:
 *   - logPlacement is the ONLY function that inserts into placement_history.
 *   - Grave status is always derived from interments, never set blindly.
 *   - Grave locks are always taken in ascending grave_id order.
 *   - Reservation-lock checks are always scoped to reservation_state = 'Active'.
 */

// -----------------------------------------------------------------------------
// Grave status re-derivation
// -----------------------------------------------------------------------------

/**
 * Re-derive a grave's status from the interments table, atomically.
 *
 *   Occupied  <=> at least one Active, non-deleted interment references it.
 *   Vacant    otherwise.
 *
 * The caller MUST hold a FOR UPDATE lock on this grave row, otherwise
 * the derivation is racy.
 *
 * Returns the new status, or null if the grave no longer exists.
 */
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

// -----------------------------------------------------------------------------
// Lock helpers – must be called inside an active transaction
// -----------------------------------------------------------------------------

/**
 * Take FOR UPDATE locks on one or more grave rows, in ascending grave_id
 * order.  Ascending order prevents deadlocks between concurrent requests
 * that each need the same pair of graves.
 *
 * NULLs, zeros, and negatives are dropped silently.
 */
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

// -----------------------------------------------------------------------------
// Placement history logging
// -----------------------------------------------------------------------------

/**
 * Append a row to placement_history.
 *
 * The caller passes the full interment row as it was BEFORE the change
 * (read just before the UPDATE) and as it is AFTER the change (read just
 * after the UPDATE).  Both are stored as JSON snapshots so the history is
 * self-contained and can be replayed without touching `interments`.
 *
 * This is the ONLY function that inserts into placement_history.  Every
 * physical movement — reservation Confirm, manual move, manual removal —
 * goes through it.
 *
 * FIELD EDITS ARE NOT LOGGED.  If a caller changes only non-grave fields
 * (name, contact, permits), it must NOT call this function.  This keeps
 * placement_history semantically about *physical placement*, not about
 * form-field churn.
 *
 * $eventType must be 'Initial', 'Move', or 'Removal'.
 *
 * Returns the new history_id.
 */
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

// -----------------------------------------------------------------------------
// Reservation-lock checks
// -----------------------------------------------------------------------------
//
// While a reservation is Active, its anchors are locked:
//   - target_grave_id
//   - pending_interment_id   (N)
//   - old_interment_id       (O)
//   - old_new_grave_id       (O's destination, if any)
//
// records.php calls these before allowing an edit / move / delete.
// reserve.php calls these before allowing a new reservation.

/**
 * Is this interment referenced by an Active reservation?
 * Returns the reservation_id if locked, or null if free.
 */
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

/**
 * Is this grave referenced by an Active reservation?
 * Returns the reservation_id if locked, or null if free.
 */
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
