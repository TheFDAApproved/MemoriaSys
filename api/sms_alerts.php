<?php
// sms_alerts.php
require_once 'config.php';
require_once 'textbee.php';

/**
 * Scan active interments and insert Pending rows for leases that
 * match a reminder stage. Idempotent — safe to run as often as you
 * like; the dedup check prevents duplicate rows for the same
 * (interment, stage, lease-date) combo.
 */
function generateSmsAlerts(PDO $pdo): array
{
    global $SMS_REMINDER_STAGES;

    $inserted = 0;
    $skipped  = 0;

    foreach ($SMS_REMINDER_STAGES as $stageDays => $stageName) {
        // Stage -1 catches any NEGATIVE day (already expired), but
        // strictly < 0 so it does NOT collide with stage 0 on the
        // day of expiry (that would send TWO SMS for one event).
        if ($stageDays === -1) {
            $whereDiff = "DATEDIFF(lease_expiration_date, CURDATE()) < 0";
            $params    = [];
        } else {
            $whereDiff = "DATEDIFF(lease_expiration_date, CURDATE()) = :stage_days";
            $params    = [':stage_days' => $stageDays];
        }

        $sql = "
            SELECT interment_id, deceased_name, contact_person_name,
                   contact_person_phone_number, lease_expiration_date
              FROM interments
             WHERE status = 'Active'
               AND deleted_at IS NULL
               AND lease_expiration_date IS NOT NULL
               AND {$whereDiff}
        ";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $leases = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($leases as $lease) {
            // Dedup: has ANY row already been created for this combo?
            // Sent, Failed, Pending, Skipped — all count. Retries happen
            // inside that single row via attempt_count, so the generator
            // must never create a second one.
            $dedupStmt = $pdo->prepare("
                SELECT 1 FROM sms_notifications
                 WHERE interment_id = ?
                   AND notification_type = 'Lease Expiring'
                   AND lease_expiration_date_at_send = ?
                   AND days_before_expiry = ?
                 LIMIT 1
            ");
            $dedupStmt->execute([
                $lease['interment_id'],
                $lease['lease_expiration_date'],
                $stageDays,
            ]);

            if ($dedupStmt->fetchColumn()) {
                $skipped++;
                continue;
            }

            $message = "Reminder: The lease for {$lease['deceased_name']} at the cemetery is due on {$lease['lease_expiration_date']}. Please contact the office.";

            $pdo->prepare("
                INSERT INTO sms_notifications
                    (interment_id, notification_type, lease_expiration_date_at_send,
                     days_before_expiry, recipient_name, recipient_phone_number,
                     message_body, status)
                VALUES (?, 'Lease Expiring', ?, ?, ?, ?, ?, 'Pending')
            ")->execute([
                $lease['interment_id'],
                $lease['lease_expiration_date'],
                $stageDays,
                $lease['contact_person_name'],
                $lease['contact_person_phone_number'],
                $message,
            ]);
            $inserted++;
        }
    }

    return ['inserted' => $inserted, 'skipped' => $skipped];
}

/**
 * Drain the Pending/Failed queue, respecting the daily cap and the
 * per-run batch cap. Updates status + attempt_count on each row.
 */
function processSmsAlerts(PDO $pdo): array
{
    $dailyLimit = SMS_MAX_DAILY_SENDS;
    $batchLimit = SMS_MAX_BATCH_PER_RUN;
    $maxRetries = SMS_MAX_RETRY_ATTEMPTS;

    // How many did we successfully send TODAY?
    $sentToday = (int)$pdo->query("
        SELECT COUNT(*) FROM sms_notifications
         WHERE status = 'Sent' AND DATE(sent_at) = CURDATE()
    ")->fetchColumn();

    $remainingToday = max(0, $dailyLimit - $sentToday);
    if ($remainingToday === 0) {
        return [
            'processed' => 0,
            'sent' => 0,
            'failed' => 0,
            'skipped' => 0,
            'reason' => 'Daily send cap reached',
            'sent_today' => $sentToday,
        ];
    }

    $effectiveBatch = min($batchLimit, $remainingToday);

    // Priority: closest to 0 (most urgent), then oldest.
    $stmt = $pdo->prepare("
        SELECT *
          FROM sms_notifications
         WHERE status IN ('Pending', 'Failed')
           AND attempt_count < :max_retries
         ORDER BY ABS(DATEDIFF(lease_expiration_date_at_send, CURDATE())) ASC,
                  created_at ASC
         LIMIT :batch_limit
    ");
    $stmt->bindValue(':max_retries', $maxRetries, PDO::PARAM_INT);
    $stmt->bindValue(':batch_limit', $effectiveBatch, PDO::PARAM_INT);
    $stmt->execute();
    $candidates = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $stats = ['processed' => 0, 'sent' => 0, 'failed' => 0, 'skipped' => 0];

    foreach ($candidates as $row) {
        $stats['processed']++;

        // Safety: has the lease been renewed or the interment deactivated
        // between generation and now?
        $checkStmt = $pdo->prepare("
            SELECT 1 FROM interments
             WHERE interment_id = :iid
               AND lease_expiration_date = :led
               AND status = 'Active'
               AND deleted_at IS NULL
        ");
        $checkStmt->execute([
            ':iid' => $row['interment_id'],
            ':led' => $row['lease_expiration_date_at_send'],
        ]);

        if (!$checkStmt->fetchColumn()) {
            $pdo->prepare("
                UPDATE sms_notifications
                   SET status = 'Skipped',
                       error_message = 'Lease renewed or interment status changed before send'
                 WHERE notification_id = ?
            ")->execute([$row['notification_id']]);
            $stats['skipped']++;
            continue;
        }

        // include_cemetery_name = TRUE → function appends the suffix
        $result = sendSmsViaTextBee(
            $row['recipient_phone_number'],
            $row['message_body'],
            true,
            NULL
        );

        if (!empty($result['success'])) {
            $pdo->prepare("
                UPDATE sms_notifications
                   SET status = 'Sent',
                       sent_at = NOW(),
                       attempt_count = attempt_count + 1,
                       error_message = NULL
                 WHERE notification_id = :nid
            ")->execute([':nid' => $row['notification_id']]);
            $stats['sent']++;
        } else {
            $pdo->prepare("
                UPDATE sms_notifications
                   SET status = 'Failed',
                       attempt_count = attempt_count + 1,
                       error_message = :err
                 WHERE notification_id = :nid
            ")->execute([
                ':nid' => $row['notification_id'],
                ':err' => $result['error'] ?? 'Unknown error',
            ]);
            $stats['failed']++;
        }
    }

    return $stats;
}

/**
 * Generate + send in one call. Safe to run every tick because
 * generation is idempotent — most ticks insert 0 rows.
 *
 * Sending is gated by the `auto_send_sms_expiring` setting. Generation
 * always runs so the queue stays fresh (missed stages would otherwise
 * never get caught if the flag was off during that day). When sending is
 * disabled, pending rows simply accumulate until the flag is re-enabled.
 */
function runSmsAlerts(PDO $pdo, ?bool $sendEnabled = null): array
{
    // If caller didn't specify, look up the flag
    if ($sendEnabled === null) {
        $sendEnabled = isAutoSendSmsEnabled($pdo);
    }

    $result = [
        'generation'        => generateSmsAlerts($pdo),
        'auto_send_enabled' => $sendEnabled,
    ];

    if ($sendEnabled) {
        $result['sending'] = processSmsAlerts($pdo);
    } else {
        $result['sending'] = [
            'skipped' => true,
            'reason'  => 'auto_send_sms_expiring is disabled',
        ];
    }

    return $result;
}

/**
 * Is automated SMS sending enabled?
 *
 * Reads the `auto_send_sms_expiring` setting. Default is ENABLED:
 *   - Setting row missing              → true  (default-on)
 *   - Value is empty string / NULL     → true  (treated as "not configured")
 *   - Explicit falsy value             → false
 *     ("0", "false", "no", "off", "disabled")
 *   - Explicit truthy value            → true
 *     ("1", "true", "yes", "on", "enabled")
 *   - Any other unrecognized value     → true  (fail-open)
 *
 * A DB error during the check also fails open (true), so a transient
 * query issue never silently kills all outbound SMS.
 */
function isAutoSendSmsEnabled(PDO $pdo): bool
{
    try {
        $stmt = $pdo->prepare("
            SELECT setting_value
              FROM settings
             WHERE setting_key = 'auto_send_sms_expiring'
               AND deleted_at IS NULL
             LIMIT 1
        ");
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('isAutoSendSmsEnabled: DB check failed — assuming enabled: ' . $e->getMessage());
        return true;
    }

    // Row doesn't exist → default true
    if ($row === false) {
        return true;
    }

    $raw        = (string)($row['setting_value'] ?? '');
    $normalized = strtolower(trim($raw));

    // Empty value → treat as "not configured" → true
    if ($normalized === '') {
        return true;
    }

    $falsy  = ['0', 'false', 'no', 'off', 'disabled'];
    $truthy = ['1', 'true', 'yes', 'on', 'enabled'];

    if (in_array($normalized, $falsy, true)) {
        return false;
    }
    if (in_array($normalized, $truthy, true)) {
        return true;
    }

    // Unknown value → fail open
    return true;
}

/**
 * Return the current state of the SMS notification queue for the UI:
 *   - summary:     counts by status, sent-today vs daily cap, stage breakdown
 *   - rows:        paginated log (filterable, searchable)
 *   - pagination:  page info for the UI
 *   - filters:     echoes back what was applied
 *
 * Options (all optional):
 *   status    'Pending'|'Sent'|'Failed'|'Skipped'   filter by status manual is coming soon?? not yet i guess
 *   stage     30|7|0|-1|'manual'                    filter by reminder stage
 *   search    string                               matches recipient_name, phone, deceased_name
 *   type      'Lease Expiring'|...                 default 'Lease Expiring'
 *   page      int  (default 1)
 *   per_page  int  (default 25, max 100)
 */
function statusesSmsAlerts(PDO $pdo, array $options = []): array
{
    $type     = $options['type']     ?? 'Lease Expiring';
    $status   = $options['status']   ?? null;
    $stage    = $options['stage']    ?? null;
    $search   = $options['search']   ?? null;
    $page     = max(1, (int)($options['page']     ?? 1));
    $perPage  = min(100, max(1, (int)($options['per_page'] ?? 25)));
    $offset   = ($page - 1) * $perPage;

    // Summary: counts by status
    $sumStmt = $pdo->prepare("
        SELECT status, COUNT(*) AS count
          FROM sms_notifications
         WHERE notification_type = :type
         GROUP BY status
    ");
    $sumStmt->execute([':type' => $type]);
    $byStatus = ['Pending' => 0, 'Sent' => 0, 'Failed' => 0, 'Skipped' => 0];
    while ($r = $sumStmt->fetch(PDO::FETCH_ASSOC)) {
        $byStatus[$r['status']] = (int)$r['count'];
    }

    // Sent today vs daily cap
    $sentTodayStmt = $pdo->prepare("
        SELECT COUNT(*)
          FROM sms_notifications
         WHERE status = 'Sent'
           AND DATE(sent_at) = CURDATE()
           AND notification_type = :type
    ");
    $sentTodayStmt->execute([':type' => $type]);
    $sentToday = (int)$sentTodayStmt->fetchColumn();

    // Stage breakdown of queued work (Pending + Failed)
    $stageStmt = $pdo->prepare("
        SELECT days_before_expiry AS stage, COUNT(*) AS count
          FROM sms_notifications
         WHERE status IN ('Pending', 'Failed')
           AND notification_type = :type
         GROUP BY days_before_expiry
         ORDER BY days_before_expiry DESC
    ");
    $stageStmt->execute([':type' => $type]);
    $byStage = [];
    while ($r = $stageStmt->fetch(PDO::FETCH_ASSOC)) {
        $key = $r['stage'] === null ? 'manual' : (string)(int)$r['stage'];
        $byStage[$key] = (int)$r['count'];
    }

    // Build filters
    $where  = ['s.notification_type = :type'];
    $params = [':type' => $type];

    if ($status && in_array($status, ['Pending', 'Sent', 'Failed', 'Skipped'], true)) {
        $where[] = 's.status = :status';
        $params[':status'] = $status;
    }
    if ($stage !== null && $stage !== '') {
        if ($stage === 'manual') {
            $where[] = 's.days_before_expiry IS NULL';
        } else {
            $where[] = 's.days_before_expiry = :stage';
            $params[':stage'] = (int)$stage;
        }
    }
    if ($search) {
        $where[] = '(s.recipient_name LIKE :search1
              OR s.recipient_phone_number LIKE :search2
              OR i.deceased_name LIKE :search3)';
        $searchVal = '%' . $search . '%';
        $params[':search1'] = $searchVal;
        $params[':search2'] = $searchVal;
        $params[':search3'] = $searchVal;
    }
    $whereSql = 'WHERE ' . implode(' AND ', $where);

    // Total count for pagination
    $countStmt = $pdo->prepare("
        SELECT COUNT(*)
          FROM sms_notifications s
          LEFT JOIN interments i ON s.interment_id = i.interment_id
        {$whereSql}
    ");
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    // Paginated rows
    $rowsStmt = $pdo->prepare("
    SELECT
        s.notification_id,
        s.interment_id,
        s.notification_type,
        s.lease_expiration_date_at_send,
        i.lease_expiration_date AS current_lease_expiration_date,
        s.days_before_expiry,
        s.recipient_name,
        s.recipient_phone_number,
        s.message_body,
        s.status,
        s.attempt_count,
        s.sent_at,
        s.provider_message_id,
        s.error_message,
        s.created_at,
        i.deceased_name,
        s.updated_at
      FROM sms_notifications s
      LEFT JOIN interments i ON s.interment_id = i.interment_id
    {$whereSql}
    ORDER BY s.created_at DESC
    LIMIT :lim OFFSET :off
    ");
    foreach ($params as $k => $v) {
        $rowsStmt->bindValue($k, $v);
    }
    $rowsStmt->bindValue(':lim', $perPage, PDO::PARAM_INT);
    $rowsStmt->bindValue(':off', $offset, PDO::PARAM_INT);
    $rowsStmt->execute();
    $rows = $rowsStmt->fetchAll(PDO::FETCH_ASSOC);

    return [
        'summary' => [
            'by_status'       => $byStatus,
            'by_stage'        => $byStage,
            'sent_today'      => $sentToday,
            'daily_cap'       => (int)SMS_MAX_DAILY_SENDS,
            'remaining_today' => max(0, (int)SMS_MAX_DAILY_SENDS - $sentToday),
            'auto_send_enabled' => isAutoSendSmsEnabled($pdo)
        ],
        'rows'       => $rows,
        'pagination' => [
            'page'     => $page,
            'per_page' => $perPage,
            'total'    => $total,
            'pages'    => (int)ceil($total / max(1, $perPage)),
        ],
        'filters' => [
            'type'   => $type,
            'status' => $status,
            'stage'  => $stage,
            'search' => $search,
        ],
    ];
}

/** Flip a Failed (or Skipped) row back to Pending and reset the attempt counter. */
function retrySmsAlert(PDO $pdo, int $notificationId): array
{
    $stmt = $pdo->prepare("
        UPDATE sms_notifications
           SET status        = 'Pending',
               attempt_count = 0,
               error_message = NULL
         WHERE notification_id = :id
           AND status IN ('Failed', 'Skipped')
    ");
    $stmt->execute([':id' => $notificationId]);

    if ($stmt->rowCount() === 0) {
        return ['success' => false, 'error' => 'Row not retryable (not Failed or Skipped, or not found).'];
    }
    return ['success' => true, 'notification_id' => $notificationId];
}

/** Cancel a single Pending row (mark Skipped). Sent rows can't be cancelled. */
function cancelSmsAlert(PDO $pdo, int $notificationId, int $userId): array
{
    // Preserve the original error if this was a Failed row — the user
    // needs the failure reason to make an informed decision later.
    $stmt = $pdo->prepare("
        UPDATE sms_notifications
           SET status = 'Skipped',
               error_message = CONCAT(
                   'Cancelled by user #', :uid, ' at ', :ts,
                   IF(error_message IS NULL OR error_message = '',
                      '',
                      CONCAT(' | Original: ', error_message))
               )
         WHERE notification_id = :id
           AND status IN ('Pending', 'Failed')
    ");
    $stmt->execute([
        ':id'  => $notificationId,
        ':uid' => $userId,
        ':ts'  => date('Y-m-d H:i:s'),
    ]);

    if ($stmt->rowCount() === 0) {
        return [
            'success' => false,
            'error'   => 'Row not cancellable (must be Pending or Failed, and not already Sent/Skipped).',
        ];
    }
    return ['success' => true, 'notification_id' => $notificationId];
}

/** Bulk abort: every Pending row → Skipped. */
function cancelAllPendingSmsAlerts(PDO $pdo, int $userId): array
{
    $stmt = $pdo->prepare("
        UPDATE sms_notifications
           SET status        = 'Skipped',
               error_message = :reason
         WHERE status = 'Pending'
    ");
    $stmt->execute([
        ':reason' => 'Bulk-cancelled by user #' . $userId . ' at ' . date('Y-m-d H:i:s'),
    ]);
    return ['success' => true, 'cancelled' => $stmt->rowCount()];
}

/** Bulk retry: every Failed row under the retry cap → Pending with attempt_count reset. */
function retryAllFailedSmsAlerts(PDO $pdo): array
{
    $stmt = $pdo->prepare("
        UPDATE sms_notifications
           SET status        = 'Pending',
               attempt_count = 0,
               error_message = NULL
         WHERE status = 'Failed'
    ");
    $stmt->execute();
    return ['success' => true, 'retried' => $stmt->rowCount()];
}

/** Bulk retry: every Skipped row → Pending with attempt_count reset. */
function retryAllSkippedSmsAlerts(PDO $pdo): array
{
    $stmt = $pdo->prepare("
        UPDATE sms_notifications
           SET status        = 'Pending',
               attempt_count = 0,
               error_message = NULL
         WHERE status = 'Skipped'
    ");
    $stmt->execute();
    return ['success' => true, 'retried' => $stmt->rowCount()];
}
