<?php
//THIS IS TO RUN WHEN I CHANGE MY SQL.TXT HUHUHUHHHAHAHAHAHAHAHHA
declare(strict_types=1);

// ---------------------------------------------------------------------
// Database configuration
// ---------------------------------------------------------------------
$host    = '127.0.0.1';
$db      = 'memoria_db';
$user    = 'root';
$pass    = '';
$charset = 'utf8mb4';

$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
];

try {
    // -----------------------------------------------------------------
    // 1. Connect to MySQL server without selecting a database
    // -----------------------------------------------------------------
    $pdo = new PDO("mysql:host=$host;charset=$charset", $user, $pass, $options);

    // Drop and recreate memoria_db
    $pdo->exec("DROP DATABASE IF EXISTS `$db`");
    $pdo->exec("CREATE DATABASE `$db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    echo "Database `$db` recreated.\n";

    // Connect to the new database
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=$charset", $user, $pass, $options);

    // -----------------------------------------------------------------
    // 2. Create tables, trigger, comments, indexes
    // -----------------------------------------------------------------
    $ddl = [
        <<<'SQL'
CREATE TABLE users (
    user_id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL,
    role ENUM('Administrator', 'Office Staff', 'Grounds Staff') NOT NULL DEFAULT 'Grounds Staff',
    status ENUM('Verified', 'Unverified') NOT NULL DEFAULT 'Unverified',
    email VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    session_token TEXT NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    active_username VARCHAR(50)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN username ELSE NULL END) STORED,
    active_email VARCHAR(255)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN email ELSE NULL END) STORED,
    active_phone VARCHAR(20)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN phone_number ELSE NULL END) STORED,

    CONSTRAINT uk_active_username UNIQUE (active_username),
    CONSTRAINT uk_active_email    UNIQUE (active_email),
    CONSTRAINT uk_active_phone    UNIQUE (active_phone),

    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
SQL,

        <<<'SQL'
CREATE TABLE blocks (
    block_id INT AUTO_INCREMENT PRIMARY KEY,
    block_name VARCHAR(100) NOT NULL,
    block_type ENUM(
        'Niche', 'Bone Chamber', 'Lawn/Grounds',
        'Unmapped Area', 'Private', 'Mausoleum',
        'Mass Grave', 'Cluster', 'Block'
    ) NOT NULL,
    image_link TEXT,
    coordinates JSON,
    remarks TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    active_block_name VARCHAR(100)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN block_name ELSE NULL END) STORED,
    CONSTRAINT uk_active_block_name UNIQUE (active_block_name),

    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
SQL,

        <<<'SQL'
CREATE TABLE graves (
    grave_id INT AUTO_INCREMENT PRIMARY KEY,
    block_id INT NOT NULL,
    grave_code VARCHAR(50) NOT NULL,
    row_num INT,
    col_num INT,
    status ENUM('Vacant', 'Occupied') DEFAULT 'Vacant',
    remarks TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    active_grave_code VARCHAR(50)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN grave_code ELSE NULL END) STORED,
    CONSTRAINT uk_active_grave_code UNIQUE (active_grave_code),

    FOREIGN KEY (block_id) REFERENCES blocks(block_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
SQL,

        // NOTE: transfer_to_grave removed. A new CHECK constraint enforces that
        // Pending/Inactive rows have NULL current_grave_id.
        <<<'SQL'
CREATE TABLE interments (
    interment_id INT AUTO_INCREMENT PRIMARY KEY,

    control_number VARCHAR(100) NOT NULL,

    deceased_name VARCHAR(255) NOT NULL,
    last_known_address TEXT,
    death_certificate VARCHAR(100),
    deceased_date_of_birth DATE,
    deceased_date_of_death DATE,
    deceased_sex ENUM('Male', 'Female', 'Unknown') DEFAULT 'Unknown',

    current_grave_id INT,

    contact_person_name VARCHAR(255),
    contact_person_phone_number VARCHAR(50),
    contact_person_email VARCHAR(150),
    contact_person_address_barangay TEXT,
    contact_person_address TEXT,

    assistance_type ENUM('Burial', 'Transfer the remains of the late', 'Other')
        NOT NULL DEFAULT 'Burial',

    burial_permit_number VARCHAR(100),
    burial_permit_date DATE,
    transfer_permit_number VARCHAR(100),
    transfer_permit_issued_by VARCHAR(150),
    transfer_permit_date DATE,
    exhumation_permit_number VARCHAR(100),
    exhumation_permit_date DATE,

    date_buried DATE,
    date_exhumed DATE,
    burial_clearance_date DATE,
    lease_expiration_date DATE,

    status ENUM('Pending', 'Active', 'Inactive') NOT NULL DEFAULT 'Pending',

    remarks TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    active_control_number VARCHAR(100)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN control_number ELSE NULL END) STORED,
    CONSTRAINT uk_active_control_number UNIQUE (active_control_number),

    FOREIGN KEY (current_grave_id) REFERENCES graves(grave_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL,

    -- If status is Pending or Inactive, current_grave_id must be NULL.
    -- Active rows may have NULL (Common Bone Chamber / location unknown).
    CONSTRAINT chk_status_grave CHECK (
        status = 'Active' OR current_grave_id IS NULL
    )
);
SQL,

        // NOTE: the reservation is a first-class row now — one per active plan.
        // The pending interment carries the *incoming* person's data; this table
        // carries the *plan* for the grave and (optionally) the displaced occupant.
        <<<'SQL'
CREATE TABLE reservation_details (
    reservation_id INT AUTO_INCREMENT PRIMARY KEY,

    pending_interment_id INT NOT NULL,
    target_grave_id INT NOT NULL,

    old_interment_id INT NULL,

    old_new_grave_id        INT NULL,
    old_new_status          ENUM('Active','Inactive') NULL,
    old_new_assistance_type ENUM('Burial','Transfer the remains of the late','Other') NULL,
    old_new_remarks         TEXT NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    UNIQUE KEY uk_pending_interment (pending_interment_id),

    active_target_grave_id INT
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN target_grave_id ELSE NULL END) STORED,
    CONSTRAINT uk_active_target_grave UNIQUE (active_target_grave_id),

    FOREIGN KEY (pending_interment_id) REFERENCES interments(interment_id) ON DELETE RESTRICT,
    FOREIGN KEY (target_grave_id)      REFERENCES graves(grave_id)          ON DELETE RESTRICT,
    FOREIGN KEY (old_interment_id)     REFERENCES interments(interment_id)  ON DELETE RESTRICT,
    FOREIGN KEY (old_new_grave_id)     REFERENCES graves(grave_id)          ON DELETE RESTRICT,
    FOREIGN KEY (created_by)           REFERENCES users(user_id)            ON DELETE SET NULL,
    FOREIGN KEY (updated_by)           REFERENCES users(user_id)            ON DELETE SET NULL,

    CONSTRAINT chk_old_pairing CHECK (
        old_interment_id IS NOT NULL
        OR (old_new_grave_id IS NULL
            AND old_new_status IS NULL
            AND old_new_assistance_type IS NULL)
    )
);
SQL,

        <<<'SQL'
CREATE TABLE transfer_log (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    interment_id INT NOT NULL,
    from_grave_id INT NULL,
    to_grave_id INT NULL,
    transfer_date DATETIME NOT NULL,
    reason TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    FOREIGN KEY (interment_id) REFERENCES interments(interment_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
SQL,

        <<<'SQL'
CREATE TABLE settings (
    setting_id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(50) NOT NULL,
    setting_value TEXT,
    description VARCHAR(255) NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    active_setting_key VARCHAR(50)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN setting_key ELSE NULL END) STORED,
    CONSTRAINT uk_active_setting_key UNIQUE (active_setting_key),

    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
SQL,

        <<<'SQL'
CREATE TABLE payments (
    payment_id INT AUTO_INCREMENT PRIMARY KEY,
    reference_number VARCHAR(100) NOT NULL,
    payment_channel VARCHAR(100) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    deceased_name  VARCHAR(255),
    payers_phone_number VARCHAR(20),
    payers_email VARCHAR(255),
    payers_name VARCHAR(255),

    purpose VARCHAR(100) NOT NULL,
    image_link TEXT,

    confirmed_office_staff INT NULL,
    confirmed_ground_staff INT NULL,
    remarks_payer TEXT,
    remarks_office TEXT,
    remarks_grounds TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,

    active_reference_number VARCHAR(100)
        GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN reference_number ELSE NULL END) STORED,
    CONSTRAINT uk_active_reference_number UNIQUE (active_reference_number),

    FOREIGN KEY (confirmed_office_staff) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (confirmed_ground_staff) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
SQL,

        <<<'SQL'
CREATE TRIGGER log_grave_transfer
BEFORE UPDATE ON interments
FOR EACH ROW
BEGIN
    IF OLD.current_grave_id IS NOT NULL
       AND (OLD.current_grave_id <=> NEW.current_grave_id) = 0 THEN

        INSERT INTO transfer_log (
            interment_id,
            from_grave_id,
            to_grave_id,
            transfer_date,
            reason
        ) VALUES (
            NEW.interment_id,
            OLD.current_grave_id,
            NEW.current_grave_id,
            NOW(),
            NEW.remarks
        );

    END IF;
END
SQL,

        "ALTER TABLE users     COMMENT = 'System users with role-based access'",
        "ALTER TABLE blocks    COMMENT = 'Cemetery sections/areas (Niche, Lawn, etc.)'",
        "ALTER TABLE graves    COMMENT = 'Individual burial slots inside a block'",
        "ALTER TABLE interments COMMENT = 'Burial/transfer records with status workflow (Pending → Active → Inactive)'",
        "ALTER TABLE reservation_details COMMENT = 'Planned grave changes (one row per active reservation; consumed on execute/cancel)'",
        "ALTER TABLE transfer_log COMMENT = 'Audit trail of grave location changes (auto-logged by trigger)'",
        "ALTER TABLE settings  COMMENT = 'System configuration key-value store'",
        "ALTER TABLE payments  COMMENT = 'Payment records with dual-approval workflow'",

        "CREATE INDEX idx_blocks_deleted_at ON blocks(deleted_at)",
        "CREATE INDEX idx_graves_block_id ON graves(block_id)",
        "CREATE INDEX idx_graves_status ON graves(status)",
        "CREATE INDEX idx_graves_block_status ON graves(block_id, status)",
        "CREATE INDEX idx_graves_deleted_at ON graves(deleted_at)",
        "CREATE INDEX idx_interments_current_grave_id ON interments(current_grave_id)",
        "CREATE INDEX idx_interments_status ON interments(status)",
        "CREATE INDEX idx_interments_deceased_name ON interments(deceased_name(100))",
        "CREATE INDEX idx_interments_lease_expiration ON interments(lease_expiration_date)",
        "CREATE INDEX idx_interments_status_grave ON interments(status, current_grave_id)",
        "CREATE INDEX idx_interments_date_buried ON interments(date_buried)",
        "CREATE INDEX idx_interments_deleted_at ON interments(deleted_at)",
        "CREATE INDEX idx_reservation_details_target_grave ON reservation_details(target_grave_id)",
        "CREATE INDEX idx_reservation_details_old_interment ON reservation_details(old_interment_id)",
        "CREATE INDEX idx_reservation_details_old_new_grave ON reservation_details(old_new_grave_id)",
        "CREATE INDEX idx_reservation_details_deleted_at ON reservation_details(deleted_at)",
        "CREATE INDEX idx_transfer_log_interment_id ON transfer_log(interment_id)",
        "CREATE INDEX idx_transfer_log_transfer_date ON transfer_log(transfer_date)",
        "CREATE INDEX idx_transfer_log_interment_date ON transfer_log(interment_id, transfer_date)",
        "CREATE INDEX idx_transfer_log_deleted_at ON transfer_log(deleted_at)",
        "CREATE INDEX idx_settings_deleted_at ON settings(deleted_at)",
        "CREATE INDEX idx_users_deleted_at ON users(deleted_at)",
        "CREATE INDEX idx_users_session_token ON users(session_token(100))",
        "CREATE INDEX idx_payments_deleted_at ON payments(deleted_at)",
        "CREATE INDEX idx_payments_confirmation ON payments(confirmed_office_staff, confirmed_ground_staff)",
    ];

    foreach ($ddl as $sql) {
        $pdo->exec($sql);
    }
    echo "Tables, trigger, comments, and indexes created.\n";

    // -----------------------------------------------------------------
    // 3. Insert the single admin user
    // -----------------------------------------------------------------
    $pdo->beginTransaction();

    $adminPasswordHash = password_hash('Admin@123', PASSWORD_DEFAULT);

    $stmtAdmin = $pdo->prepare("
        INSERT INTO users (username, role, status, email, phone_number, password_hash, name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ");
    $stmtAdmin->execute([
        'admin',
        'Administrator',
        'Verified',
        'admin@example.com',
        '0000000000',
        $adminPasswordHash,
        'Administrator'
    ]);

    $adminId = (int)$pdo->lastInsertId();
    echo "Admin user inserted (username: admin, password: Admin@123).\n";

    // -----------------------------------------------------------------
    // 4. Seed helper data
    // -----------------------------------------------------------------
    $firstNames = ['Jose', 'Maria', 'Antonio', 'Teresita', 'Eduardo', 'Carmen', 'Juan', 'Rosario', 'Manuel', 'Lourdes', 'Arthur', 'Elena', 'Ricardo', 'Sofia', 'Miguel'];
    $lastNames  = ['Garcia', 'Reyes', 'Cruz', 'Bautista', 'Ocampo', 'Aquino', 'Mendoza', 'Santos', 'Navarro', 'Torres', 'Villanueva', 'Lim', 'Tan', 'Dela Cruz'];
    $streets    = ['Mabini St', 'Rizal Ave', 'Quezon Blvd', 'Luna St', 'Bonifacio Way', 'MacArthur Highway', 'Taft Ave'];
    $barangays  = [
        'Alang-alang',
        'Bakilid',
        'Banilad',
        'Basak',
        'Cabancalan',
        'Cambaro',
        'Canduman',
        'Casuntingan',
        'Casili',
        'Centro',
        'Cubacub',
        'Guizo',
        'Ibabao-Estancia',
        'Jagobiao',
        'Labogon',
        'Looc',
        'Maguikay',
        'Mantuyong',
        'Opao',
        'Pakna-an',
        'Pagsabungan',
        'Subangdaku',
        'Tabok',
        'Tingub',
        'Tipolo',
        'Umapad'
    ];

    function getRandomName(array $first, array $last): string
    {
        return $first[array_rand($first)] . ' ' . $last[array_rand($last)];
    }

    function getRandomDate(string $start, string $end): string
    {
        $timestamp = mt_rand(strtotime($start), strtotime($end));
        return date('Y-m-d', $timestamp);
    }

    // -----------------------------------------------------------------
    // 5. Seed blocks
    // -----------------------------------------------------------------
    echo "Seeding blocks...\n";

    $blocksData = [
        ['name' => 'St. Peter Niche A',          'type' => 'Niche',         'rows' => 4, 'cols' => 10],
        ['name' => 'St. John Lawn',              'type' => 'Lawn/Grounds',  'rows' => 5, 'cols' => 20],
        ['name' => 'Holy Family Mausoleum',      'type' => 'Mausoleum',     'rows' => 2, 'cols' => 5],
        ['name' => 'San Antonio Bone Chamber',   'type' => 'Bone Chamber',  'rows' => 3, 'cols' => 8],
        ['name' => 'St. Mary Lawn',              'type' => 'Lawn/Grounds',  'rows' => 4, 'cols' => 15],
        ['name' => 'Cluster A',                  'type' => 'Cluster',       'rows' => 6, 'cols' => 6],
    ];

    $blockIds = [];
    $stmtBlock = $pdo->prepare("
        INSERT INTO blocks (block_name, block_type, coordinates, remarks, created_at, updated_at)
        VALUES (?, ?, ?, ?, NOW(), NOW())
    ");

    foreach ($blocksData as &$b) {
        $coords = json_encode([
            ['lat' => 10.3157 + (mt_rand(-100, 100) / 10000), 'lng' => 123.8854 + (mt_rand(-100, 100) / 10000)]
        ]);

        $stmtBlock->execute([$b['name'], $b['type'], $coords, 'Initial block setup']);
        $b['id'] = (int)$pdo->lastInsertId();
        $blockIds[] = $b['id'];
    }
    unset($b);

    // -----------------------------------------------------------------
    // 6. Seed graves
    // -----------------------------------------------------------------
    echo "Seeding graves...\n";

    $vacantGraveIds = [];
    $allGraveIds    = [];

    $stmtGrave = $pdo->prepare("
        INSERT INTO graves (block_id, grave_code, row_num, col_num, status, remarks, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
    ");

    foreach ($blocksData as $b) {
        for ($r = 1; $r <= $b['rows']; $r++) {
            for ($c = 1; $c <= $b['cols']; $c++) {
                $code = sprintf('%s-%02d-%02d', $b['name'], $r, $c);
                $stmtGrave->execute([$b['id'], $code, $r, $c, 'Vacant', '']);

                $graveId = (int)$pdo->lastInsertId();
                $allGraveIds[] = $graveId;
                $vacantGraveIds[] = $graveId;
            }
        }
    }

    // -----------------------------------------------------------------
    // 7. Seed interments
    //
    //    NOTE: transfer_to_grave no longer exists. For Pending rows we
    //    remember the intended target grave and write a reservation_details
    //    row immediately after the interment insert.
    // -----------------------------------------------------------------
    echo "Seeding interments...\n";

    $stmtInterment = $pdo->prepare("
        INSERT INTO interments (
            control_number, deceased_name, last_known_address, death_certificate,
            deceased_date_of_birth, deceased_date_of_death, current_grave_id,
            contact_person_name, contact_person_phone_number, contact_person_email,
            contact_person_address_barangay, contact_person_address,
            assistance_type, burial_permit_number, burial_permit_date,
            date_buried, date_exhumed, burial_clearance_date, lease_expiration_date,
            status, remarks, deceased_sex,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ");

    $stmtReservation = $pdo->prepare("
        INSERT INTO reservation_details (
            pending_interment_id, target_grave_id,
            old_interment_id,
            old_new_grave_id, old_new_status, old_new_assistance_type, old_new_remarks,
            created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NOW(), NOW(), ?, ?)
    ");

    $stmtUpdateGrave = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");

    $stmtUpdateInterment = $pdo->prepare("
        UPDATE interments
        SET current_grave_id = ?, status = 'Active', date_buried = ?, updated_at = NOW()
        WHERE interment_id = ?
    ");

    $graveOccupants = [];
    $intermentIds   = [];
    $pendingCount   = 0;

    for ($i = 1; $i <= 60; $i++) {
        $controlNum = 'CTRL-' . date('Y') . '-' . str_pad((string)$i, 4, '0', STR_PAD_LEFT);
        $decName    = getRandomName($firstNames, $lastNames);

        $address = mt_rand(1, 999) . ' ' . $streets[array_rand($streets)] . ', ' . $barangays[array_rand($barangays)];

        $dob = getRandomDate('1930-01-01', '1995-12-31');
        $dod = getRandomDate('2018-01-01', '2026-08-30');
        $dateBuried = date('Y-m-d', strtotime($dod . ' + ' . mt_rand(3, 7) . ' days'));

        $contactName  = getRandomName($firstNames, $lastNames);
        $contactPhone = '09' . mt_rand(100000000, 999999999);
        $contactEmail = strtolower(str_replace(' ', '.', $contactName)) . mt_rand(1, 99) . '@example.com';

        $contactBarangay = $barangays[array_rand($barangays)];
        $contactAddress  = mt_rand(1, 999) . ' ' . $streets[array_rand($streets)];

        $permit = 'BP-' . mt_rand(10000, 99999);
        $dc     = 'DC-' . mt_rand(10000, 99999);
        $sex    = ['Male', 'Female', 'Unknown'][array_rand(['Male', 'Female', 'Unknown'])];

        // 40% Active, 30% Pending, 30% Inactive
        $statusRoll = mt_rand(1, 10);
        if ($statusRoll <= 4) {
            $status = 'Active';
        } elseif ($statusRoll <= 7) {
            $status = 'Pending';
        } else {
            $status = 'Inactive';
        }

        $currentGraveId  = null;
        $reservedGrave   = null;   // target grave for Pending rows
        $leaseExp        = null;
        $dateExhumed     = null;
        $burialClearance = null;
        $remarks         = '';

        if ($status === 'Active' && !empty($vacantGraveIds)) {
            $graveIndex = array_rand($vacantGraveIds);
            $currentGraveId = $vacantGraveIds[$graveIndex];
            unset($vacantGraveIds[$graveIndex]);
            $vacantGraveIds = array_values($vacantGraveIds);

            $stmtUpdateGrave->execute([$currentGraveId]);
            $graveOccupants[$currentGraveId] = $i;

            if (mt_rand(1, 10) <= 6) {
                $leaseRoll = mt_rand(1, 10);
                if ($leaseRoll <= 3) {
                    $leaseExp = date('Y-m-d', strtotime('-' . mt_rand(1, 12) . ' months'));
                } elseif ($leaseRoll <= 6) {
                    $leaseExp = date('Y-m-d', strtotime('+' . mt_rand(1, 28) . ' days'));
                } else {
                    $leaseExp = date('Y-m-d', strtotime('+' . mt_rand(2, 60) . ' months'));
                }
            }
            $remarks = "Active burial in grave " . $currentGraveId;
        } elseif ($status === 'Pending' && !empty($vacantGraveIds)) {
            // Pick the target grave now; write the reservation AFTER the insert
            // so we have the new interment_id.
            $graveIndex = array_rand($vacantGraveIds);
            $reservedGrave = $vacantGraveIds[$graveIndex];
            unset($vacantGraveIds[$graveIndex]);
            $vacantGraveIds = array_values($vacantGraveIds);

            $remarks = "Pending reservation for grave " . $reservedGrave . ". Awaiting execution.";
        } elseif ($status === 'Inactive') {
            $currentGraveId  = null;
            $dateExhumed     = $dod;
            $remarks         = "Remains transferred/exhumed. No longer in cemetery.";
        }

        $stmtInterment->execute([
            $controlNum,
            $decName,
            $address,
            $dc,
            $dob,
            $dod,
            $currentGraveId,
            $contactName,
            $contactPhone,
            $contactEmail,
            $contactBarangay,
            $contactAddress,
            'Burial',
            $permit,
            $dod,
            ($status === 'Active' ? $dateBuried : null),
            $dateExhumed,
            ($status === 'Active' ? date('Y-m-d', strtotime($dod . ' + 3 days')) : null),
            $leaseExp,
            $status,
            $remarks,
            $sex
        ]);

        $newIntermentId = (int)$pdo->lastInsertId();
        $intermentIds[] = $newIntermentId;

        // Pending rows get a reservation_details entry immediately
        if ($status === 'Pending' && $reservedGrave) {
            $stmtReservation->execute([
                $newIntermentId,
                $reservedGrave,
                $adminId,
                $adminId,
            ]);
            $pendingCount++;
        }
    }

    echo "  - Created " . count($intermentIds) . " interments, $pendingCount with active reservations.\n";

    // -----------------------------------------------------------------
    // 8. Create transfer history for some active interments
    // -----------------------------------------------------------------
    echo "Creating transfer history for some interments...\n";

    $activeInterments = $pdo->query("
        SELECT interment_id, current_grave_id
        FROM interments
        WHERE status = 'Active'
          AND current_grave_id IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY RAND()
        LIMIT 10
    ")->fetchAll();

    foreach ($activeInterments as $active) {
        if (empty($vacantGraveIds)) {
            break;
        }

        $oldGraveId  = $active['current_grave_id'];
        $intermentId = $active['interment_id'];

        $graveIndex = array_rand($vacantGraveIds);
        $newGraveId = $vacantGraveIds[$graveIndex];
        unset($vacantGraveIds[$graveIndex]);
        $vacantGraveIds = array_values($vacantGraveIds);

        $stmtUpdateGrave->execute([$newGraveId]);

        $moveReason = "Transferred from grave " . $oldGraveId . " to " . $newGraveId . " for family plot consolidation.";

        // NOTE: transfer_to_grave removed from the UPDATE.
        $stmtUpdateInterment->execute([
            $newGraveId,
            date('Y-m-d'),
            $intermentId
        ]);

        // Free old grave if no other active interment is there
        $checkOther = $pdo->prepare("
            SELECT COUNT(*)
            FROM interments
            WHERE current_grave_id = ?
              AND status = 'Active'
              AND interment_id != ?
              AND deleted_at IS NULL
        ");
        $checkOther->execute([$oldGraveId, $intermentId]);

        if ((int)$checkOther->fetchColumn() === 0) {
            $pdo->prepare("UPDATE graves SET status = 'Vacant' WHERE grave_id = ?")->execute([$oldGraveId]);
        }

        $pdo->prepare("
            UPDATE interments
            SET remarks = CONCAT(COALESCE(remarks, ''), ' ', ?), updated_at = NOW()
            WHERE interment_id = ?
        ")->execute([$moveReason, $intermentId]);

        echo "  - Moved interment #$intermentId from grave $oldGraveId to $newGraveId\n";
    }

    // -----------------------------------------------------------------
    // 9. Seed payments
    // -----------------------------------------------------------------
    echo "Seeding payments...\n";

    $paymentChannels = [
        'GCash',
        'Maya',
        'Bank Transfer',
        'Cash',
        'Credit Card',
        'Over the Counter',
    ];

    $paymentPurposes = [
        'Burial Fee'         => [5000, 15000],
        'Lease/Renewal Fee'  => [2000, 5000],
        'Exhumation Fee'     => [3000, 8000],
        'Transfer Fee'       => [2500, 6000],
        'Maintenance Fee'    => [1000, 3000],
        'Grave Lot Purchase' => [20000, 80000],
        'Niche Purchase'     => [15000, 40000],
    ];

    $deceasedNamesPool = $pdo->query("
        SELECT deceased_name
        FROM interments
        WHERE deleted_at IS NULL
        ORDER BY RAND()
        LIMIT 100
    ")->fetchAll(PDO::FETCH_COLUMN);

    $payerRemarkTemplates = [
        'Please confirm my payment.',
        'Paid via {channel}. Reference on receipt.',
        'Kindly verify the transaction.',
        'Urgent processing please.',
        'Payment sent, awaiting confirmation.',
        null,
        null,
    ];

    $stmtPayment = $pdo->prepare("
        INSERT INTO payments (
            reference_number, payment_channel, amount,
            deceased_name, payers_phone_number, payers_email, payers_name,
            purpose, image_link,
            confirmed_office_staff, confirmed_ground_staff,
            remarks_payer, remarks_office, remarks_grounds,
            created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?)
    ");

    $paymentIds    = [];
    $totalPayments = 40;

    for ($i = 1; $i <= $totalPayments; $i++) {
        $refNum  = 'PAY-' . date('Y') . '-' . str_pad((string)$i, 5, '0', STR_PAD_LEFT);
        $channel = $paymentChannels[array_rand($paymentChannels)];

        $purposeKeys = array_keys($paymentPurposes);
        $purpose     = $purposeKeys[array_rand($purposeKeys)];
        [$minAmt, $maxAmt] = $paymentPurposes[$purpose];

        $amount = round(mt_rand($minAmt, $maxAmt) / 50) * 50;

        $deceasedName = (mt_rand(1, 10) <= 7 && !empty($deceasedNamesPool))
            ? $deceasedNamesPool[array_rand($deceasedNamesPool)]
            : null;

        $payerName  = getRandomName($firstNames, $lastNames);
        $payerPhone = '09' . mt_rand(100000000, 999999999);
        $payerEmail = strtolower(str_replace(' ', '.', $payerName)) . mt_rand(1, 99) . '@example.com';

        $imageLink = (mt_rand(1, 10) <= 8)
            ? '/uploads/payments/' . strtolower($refNum) . '.jpg'
            : null;

        $confirmRoll      = mt_rand(1, 100);
        $confirmedOffice  = null;
        $confirmedGrounds = null;
        $remarksOffice    = null;
        $remarksGrounds   = null;

        if ($confirmRoll <= 40) {
            $confirmedOffice  = $adminId;
            $confirmedGrounds = $adminId;
            $remarksOffice    = 'Payment verified against receipt.';
            $remarksGrounds   = 'Services/goods rendered confirmed.';
        } elseif ($confirmRoll <= 65) {
            $confirmedOffice = $adminId;
            $remarksOffice   = 'Payment verified against receipt. Awaiting grounds confirmation.';
        } elseif ($confirmRoll <= 85) {
            $confirmedGrounds = $adminId;
            $remarksGrounds   = 'Services rendered confirmed. Awaiting office confirmation.';
        } else {
            $remarksOffice = 'Pending verification.';
        }

        $remarkTemplate = $payerRemarkTemplates[array_rand($payerRemarkTemplates)];
        $remarksPayer   = $remarkTemplate !== null
            ? str_replace('{channel}', $remarkTemplate, $remarkTemplate)
            : null;

        $stmtPayment->execute([
            $refNum,
            $channel,
            $amount,
            $deceasedName,
            $payerPhone,
            $payerEmail,
            $payerName,
            $purpose,
            $imageLink,
            $confirmedOffice,
            $confirmedGrounds,
            $remarksPayer,
            $remarksOffice,
            $remarksGrounds,
            $adminId,
            $adminId,
        ]);

        $paymentIds[] = (int)$pdo->lastInsertId();
    }

    echo "  - Inserted " . count($paymentIds) . " payment records.\n";

    // -----------------------------------------------------------------
    // 10. Seed settings (key/value config, featured people, etc.)
    // -----------------------------------------------------------------
    echo "Seeding settings...\n";

    $settingsData = [
        ['people_name_1',   'Tsunayoshi Sawada',            'Featured person 1 - name'],
        ['people_title_1',  '10th Vongola Boss',            'Featured person 1 - title'],
        ['people_name_2',   'Kyoya Hibari',                 'Featured person 2 - name'],
        ['people_title_2',  '10th Vongola Cloud Guardian',  'Featured person 2 - title'],
        ['people_name_3',   'Chrome Dokuro',                'Featured person 3 - name'],
        ['people_title_3',  '10th Vongola Mist Guardian',   'Featured person 3 - title'],
        ['people_name_4',   'Lambo',                        'Featured person 4 - name'],
        ['people_title_4',  '10th Vongola Thunder Guardian', 'Featured person 4 - title'],

        ['cemetery_name',   'Cementeryo sa Patay HAHAHAHA', 'Displayed cemetery name'],
    ];

    $stmtSetting = $pdo->prepare("
        INSERT INTO settings (setting_key, setting_value, description, created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, NOW(), NOW(), ?, ?)
    ");

    foreach ($settingsData as $s) {
        $stmtSetting->execute([
            $s[0],
            $s[1],
            $s[2],
            $adminId,
            $adminId,
        ]);
    }

    echo "  - Inserted " . count($settingsData) . " setting rows.\n";

    // -----------------------------------------------------------------
    // 11. Soft-delete a few inactive interments + unconfirmed payments
    // -----------------------------------------------------------------
    echo "Soft-deleting some inactive interments...\n";

    $softDeleteStmt = $pdo->prepare("
        UPDATE interments
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE interment_id = ? AND status = 'Inactive'
    ");

    $inactiveIds = $pdo->query("
        SELECT interment_id
        FROM interments
        WHERE status = 'Inactive'
          AND deleted_at IS NULL
        LIMIT 3
    ")->fetchAll(PDO::FETCH_COLUMN);

    foreach ($inactiveIds as $id) {
        $softDeleteStmt->execute([$id]);
        echo "  - Soft-deleted interment #$id\n";
    }

    echo "Soft-deleting some unconfirmed payments...\n";

    $softDeletePaymentStmt = $pdo->prepare("
        UPDATE payments
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE payment_id = ?
          AND confirmed_office_staff IS NULL
          AND confirmed_ground_staff IS NULL
    ");

    $stalePaymentIds = $pdo->query("
        SELECT payment_id
        FROM payments
        WHERE confirmed_office_staff IS NULL
          AND confirmed_ground_staff IS NULL
          AND deleted_at IS NULL
        LIMIT 2
    ")->fetchAll(PDO::FETCH_COLUMN);

    foreach ($stalePaymentIds as $pid) {
        $softDeletePaymentStmt->execute([$pid]);
        echo "  - Soft-deleted payment #$pid\n";
    }

    $pdo->commit();

    // -----------------------------------------------------------------
    // 12. Summary
    // -----------------------------------------------------------------
    echo "\n✅ Successfully seeded realistic dummy data!\n";
    echo "   - Database: $db\n";
    echo "   - Users: "                 . $pdo->query("SELECT COUNT(*) FROM users")->fetchColumn()                 . "\n";
    echo "   - Blocks: "                . $pdo->query("SELECT COUNT(*) FROM blocks")->fetchColumn()                . "\n";
    echo "   - Graves: "                . $pdo->query("SELECT COUNT(*) FROM graves")->fetchColumn()                . "\n";
    echo "   - Interments: "            . $pdo->query("SELECT COUNT(*) FROM interments")->fetchColumn()            . "\n";
    echo "   - Reservations: "          . $pdo->query("SELECT COUNT(*) FROM reservation_details")->fetchColumn()  . "\n";
    echo "   - Transfer logs: "         . $pdo->query("SELECT COUNT(*) FROM transfer_log")->fetchColumn()         . "\n";
    echo "   - Payments: "              . $pdo->query("SELECT COUNT(*) FROM payments")->fetchColumn()             . "\n";
    echo "   - Settings: "              . $pdo->query("SELECT COUNT(*) FROM settings")->fetchColumn()             . "\n";
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }

    echo "❌ Failed to seed data: " . $e->getMessage() . "\n";
    exit(1);
}
