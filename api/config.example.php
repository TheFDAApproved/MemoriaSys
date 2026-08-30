<?php

require_once 'notallowed.php';

// api/config.example.php
define('DB_HOST', 'localhost');
define('DB_NAME', 'mydatayawa');
define('DB_USER', 'root');
define('DB_PASS', '');
define('DB_CHARSET', 'utf8mb4');
define('DB_TIMEZONE', '+08:00');

define('JWT_SECRET', 'SIR_PAPASARAMIINTAWNPLEASEHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHU');
define('JWT_ALGO', 'HS256');
define('JWT_EXPIRATION', 3600);
define('APP_URL', 'http://yourdomain.com');
define('LOG_SECRET_KEY', 'your_log_secret_key');
define('ENCRYPTION_KEY', 'SIR_PAPASARAMIINTAWNPLEASEHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHUHU!');

// --- ENUM CONSTANTS ---
// Manually update these if the database schema ever changes
const ROLE_ADMIN = 'Administrator';
const ROLE_OFFICE = 'Office Staff';
const ROLE_GROUNDS = 'Grounds Staff'; // Default Role I guess

const STATUS_VERIFIED = 'Verified';
const STATUS_UNVERIFIED = 'Unverified'; // Default Status I guess

const ALLOWED_ROLES = [ROLE_ADMIN, ROLE_OFFICE, ROLE_GROUNDS]; //database
const ALLOWED_STATUSES = [STATUS_VERIFIED, STATUS_UNVERIFIED]; //database
