<?php
// alertsms.php
define('ITS_ME_JUSTTOVERIFY', true);

require_once 'checkuser.php';
require_once 'sms_alerts.php';

$userData = checkuser();
$userRole = $userData['role'];
$userId   = (int)$userData['user_id'];

// Every authenticated role can VIEW. Only Admin + Office can MUTATE.
$canView   = in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS], true);
$canMutate = in_array($userRole, [ROLE_ADMIN, ROLE_OFFICE], true);

if (!$canView) {
    Response::error("Unauthorized access", 403);
}

$method = $_SERVER['REQUEST_METHOD'] ?? null;

// Enforce: GET is always allowed for viewers; POST/DELETE require mutator role
if (in_array($method, ['POST', 'DELETE'], true) && !$canMutate) {
    Response::error("Your role can view SMS alerts but not modify them.", 403);
}

switch ($method) {

    // GET — view details (summary + paginated rows). All roles.
    case 'GET':
        $searchTerm = trim((string) ($_GET['search_term'] ?? ''));
        if ($searchTerm !== '' && mb_strlen($searchTerm) < 3) {
            Response::error("Search term must be at least 3 characters long", 400);
        }
        $data = statusesSmsAlerts($pdo, [
            'status'   => $_GET['status']   ?? null,
            'stage'    => $_GET['stage']    ?? null,
            'search'   => $_GET['search_term']   ?? null,
            'page'     => $_GET['page']     ?? 1,
            'per_page' => $_GET['per_page'] ?? 25,
        ]);
        // Tell the UI whether to render action buttons
        $data['permissions'] = [
            'can_mutate' => $canMutate,
            'can_view'   => $canView,
            'role'       => $userRole,
        ];
        Response::success("SMS alert statuses retrieved", $data);
        break;

    // POST — actions. Admin + Office only (guarded above)
    case 'POST':
        $input  = json_decode(file_get_contents('php://input'), true) ?: $_POST;
        $action = $input['action'] ?? null;

        switch ($action) {
            case 'run_now':
                if (!isAutoSendSmsEnabled($pdo)) {
                    Response::success(
                        "Auto-send is currently disabled (auto_send_sms_expiring = off). Enable it in settings to process the queue.",
                        ['auto_send_enabled' => false]
                    );
                    break;
                }
                Response::success("Queue will be processed on the next cron tick (within 2 minutes). Check system logs for progress.");
                break;
            case 'retry':
                $id = (int)($input['notification_id'] ?? 0);
                if (!$id) Response::error("notification_id required", 400);
                $result = retrySmsAlert($pdo, $id);
                $result['success']
                    ? Response::success("Queued for retry", $result)
                    : Response::error($result['error'], 409);
                break;

            case 'cancel':
                $id = (int)($input['notification_id'] ?? 0);
                if (!$id) Response::error("notification_id required", 400);
                $result = cancelSmsAlert($pdo, $id, $userId);
                $result['success']
                    ? Response::success("Cancelled", $result)
                    : Response::error($result['error'], 409);
                break;

            case 'cancel_all_pending':
                $result = cancelAllPendingSmsAlerts($pdo, $userId);
                Response::success("Cancelled {$result['cancelled']} pending SMS", $result);
                break;

            case 'retry_all_failed':
                $result = retryAllFailedSmsAlerts($pdo);
                Response::success("Retried {$result['retried']} failed SMS", $result);
                break;

            case 'generate_now':
                $result = generateSmsAlerts($pdo);
                Response::success("Generated {$result['inserted']} new notifications", $result);
                break;

            case 'retry_all_skipped':
                $result = retryAllSkippedSmsAlerts($pdo);
                Response::success("Retried {$result['retried']} skipped SMS", $result);
                break;

            default:
                Response::error("Unknown action", 400);
        }
        break;

    // DELETE — single-row cancel. Admin + Office only (guarded above)
    case 'DELETE':
        $id = (int)($_GET['notification_id'] ?? 0);
        if (!$id) Response::error("notification_id required", 400);
        $result = cancelSmsAlert($pdo, $id, $userId);
        $result['success']
            ? Response::success("Cancelled", $result)
            : Response::error($result['error'], 409);
        break;

    default:
        Response::error("Method not allowed", 405);
}
