<?php

require_once 'notallowed.php';
require_once 'reusable_functions.php';

// api/config.example.php
define('DB_HOST', env('DB_HOST', 'localhost'));
define('DB_NAME', env('DB_NAME', 'memoria_db'));
define('DB_USER', env('DB_USER', 'root'));
define('DB_PASS', env('DB_PASS', ''));
define('DB_CHARSET', 'utf8mb4');
define('DB_TIMEZONE',  env('DB_TIMEZONE', '+08:00'));

define('JWT_SECRET',  env('JWT_SECRET', 'SIR_PAPASARAMIINTAWNPLEASEHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHU'));
define('JWT_ALGO', 'HS256');
define('JWT_EXPIRATION', 18000); //in seconds
define('APP_URL',  env('APP_URL', 'http://yourdomain.com'));
define('LOG_SECRET_KEY',  env('LOG_SECRET_KEY', 'your_log_secret_key'));
define('ENCRYPTION_KEY',  env('ENCRYPTION_KEY', 'SIR_PAPASARAMIINTAWNPLEASEHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHU!')); //textbee used to encrypt

// --- ENUM CONSTANTS ---
// Manually update these if the database schema ever changes
const ROLE_ADMIN = 'Administrator';
const ROLE_OFFICE = 'Office Staff';
const ROLE_GROUNDS = 'Grounds Staff'; // Default Role I guess

const STATUS_VERIFIED = 'Verified';
const STATUS_UNVERIFIED = 'Unverified'; // Default Status I guess

const ALLOWED_ROLES = [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]; //database
const ALLOWED_STATUSES = [STATUS_VERIFIED, STATUS_UNVERIFIED]; //database

// EDITABLE SETTINGS (Change these as you see fit)
define('SMS_MAX_DAILY_SENDS', 20); // Free plan is 50, leaving headroom textbee
define('SMS_MAX_BATCH_PER_RUN', 10); // Process at most 10 messages per cron run
define('SMS_MAX_RETRY_ATTEMPTS', 3); // Try a notification a maximum of 3 times
define('CRON_SECRET', env('CRON_SECRET', "SECRETTTTTTTTtTTTTTTTTTHUAHAUSHDUAHDUAHSDUYAWAAAA"));

// Define the reminder stages: [days_before_expiry => stage_identifier]
// Using negative for "already expired".
$SMS_REMINDER_STAGES = [
    30 => '30-Day Reminder',
    7  => '7-Day Final Notice',
    0  => 'Lease Expires Today',
    -1 => 'Lease Has Expired' // This stage will catch any negative days
];

//change if not supports +08:00??? then go to Asia/Manila?? idk really
$tz = DB_TIMEZONE;
if (preg_match('/^([+-])(\d{1,2}):?(\d{2})$/', $tz, $m)) {
    $sign    = $m[1] === '-' ? -1 : 1;
    $seconds = $sign * ((int)$m[2] * 3600 + (int)$m[3] * 60);
    $tz      = timezone_name_from_abbr('', $seconds, 0) ?: 'UTC';
}
date_default_timezone_set($tz);
