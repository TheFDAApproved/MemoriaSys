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
    transfer_to_grave INT,

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
    FOREIGN KEY (transfer_to_grave) REFERENCES graves(grave_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
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
        "ALTER TABLE transfer_log COMMENT = 'Audit trail of grave location changes (auto-logged by trigger)'",
        "ALTER TABLE settings  COMMENT = 'System configuration key-value store'",
        "ALTER TABLE payments  COMMENT = 'Payment records with dual-approval workflow'",

        "CREATE INDEX idx_blocks_deleted_at ON blocks(deleted_at)",
        "CREATE INDEX idx_graves_block_id ON graves(block_id)",
        "CREATE INDEX idx_graves_status ON graves(status)",
        "CREATE INDEX idx_graves_block_status ON graves(block_id, status)",
        "CREATE INDEX idx_graves_deleted_at ON graves(deleted_at)",
        "CREATE INDEX idx_interments_current_grave_id ON interments(current_grave_id)",
        "CREATE INDEX idx_interments_transfer_to_grave ON interments(transfer_to_grave)",
        "CREATE INDEX idx_interments_status ON interments(status)",
        "CREATE INDEX idx_interments_deceased_name ON interments(deceased_name(100))",
        "CREATE INDEX idx_interments_lease_expiration ON interments(lease_expiration_date)",
        "CREATE INDEX idx_interments_status_grave ON interments(status, current_grave_id)",
        "CREATE INDEX idx_interments_date_buried ON interments(date_buried)",
        "CREATE INDEX idx_interments_deleted_at ON interments(deleted_at)",
        "CREATE INDEX idx_transfer_log_interment_id ON transfer_log(interment_id)",
        "CREATE INDEX idx_transfer_log_transfer_date ON transfer_log(transfer_date)",
        "CREATE INDEX idx_transfer_log_interment_date ON transfer_log(interment_id, transfer_date)",
        "CREATE INDEX idx_transfer_log_deleted_at ON transfer_log(deleted_at)",
        "CREATE INDEX idx_settings_deleted_at ON settings(deleted_at)",
        "CREATE INDEX idx_users_deleted_at ON users(deleted_at)",
        "CREATE INDEX idx_users_session_token ON users(session_token(100))",
        "CREATE INDEX idx_payments_deleted_at ON payments(deleted_at)",
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
        ['name' => 'St. Peter Niche A',          'type' => 'Niche',        'prefix' => 'SP-A', 'rows' => 4, 'cols' => 10],
        ['name' => 'St. John Lawn',              'type' => 'Lawn/Grounds', 'prefix' => 'SJL',  'rows' => 5, 'cols' => 20],
        ['name' => 'Holy Family Mausoleum',      'type' => 'Mausoleum',    'prefix' => 'HFM',  'rows' => 2, 'cols' => 5],
        ['name' => 'San Antonio Bone Chamber',   'type' => 'Bone Chamber', 'prefix' => 'SABC', 'rows' => 3, 'cols' => 8],
        ['name' => 'St. Mary Lawn',              'type' => 'Lawn/Grounds', 'prefix' => 'SML',  'rows' => 4, 'cols' => 15],
        ['name' => 'Cluster A',                  'type' => 'Cluster',      'prefix' => 'CA',   'rows' => 6, 'cols' => 6],
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
                $code = $b['prefix'] . "-R{$r}C{$c}";
                $stmtGrave->execute([$b['id'], $code, $r, $c, 'Vacant', '']);

                $graveId = (int)$pdo->lastInsertId();
                $allGraveIds[] = $graveId;
                $vacantGraveIds[] = $graveId;
            }
        }
    }

    // -----------------------------------------------------------------
    // 7. Seed interments
    // -----------------------------------------------------------------
    echo "Seeding interments...\n";

    $stmtInterment = $pdo->prepare("
        INSERT INTO interments (
            control_number, deceased_name, last_known_address, death_certificate,
            deceased_date_of_birth, deceased_date_of_death, current_grave_id, transfer_to_grave,
            contact_person_name, contact_person_phone_number, contact_person_email,
            contact_person_address_barangay, contact_person_address,
            assistance_type, burial_permit_number, burial_permit_date,
            date_buried, date_exhumed, burial_clearance_date, lease_expiration_date,
            status, remarks, deceased_sex,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ");

    $stmtUpdateGrave = $pdo->prepare("UPDATE graves SET status = 'Occupied' WHERE grave_id = ?");

    $stmtUpdateInterment = $pdo->prepare("
        UPDATE interments
        SET current_grave_id = ?, status = 'Active', transfer_to_grave = NULL, date_buried = ?, updated_at = NOW()
        WHERE interment_id = ?
    ");

    $graveOccupants = [];
    $intermentIds   = [];

    for ($i = 1; $i <= 60; $i++) {
        $controlNum = 'CTRL-' . date('Y') . '-' . str_pad((string)$i, 4, '0', STR_PAD_LEFT);
        $decName    = getRandomName($firstNames, $lastNames);

        // Deceased's last known address (barangay included as part of full address)
        $address = mt_rand(1, 999) . ' ' . $streets[array_rand($streets)] . ', ' . $barangays[array_rand($barangays)];

        $dob = getRandomDate('1930-01-01', '1995-12-31');
        $dod = getRandomDate('2018-01-01', '2026-08-30');
        $dateBuried = date('Y-m-d', strtotime($dod . ' + ' . mt_rand(3, 7) . ' days'));

        $contactName  = getRandomName($firstNames, $lastNames);
        $contactPhone = '09' . mt_rand(100000000, 999999999);
        $contactEmail = strtolower(str_replace(' ', '.', $contactName)) . mt_rand(1, 99) . '@example.com';

        // Barangay ONLY (matches contact_person_address_barangay column intent)
        $contactBarangay = $barangays[array_rand($barangays)];
        // Full street address (barangay included here as part of the address)
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
        $transferToGrave = null;
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
            $graveIndex = array_rand($vacantGraveIds);
            $transferToGrave = $vacantGraveIds[$graveIndex];
            unset($vacantGraveIds[$graveIndex]);
            $vacantGraveIds = array_values($vacantGraveIds);

            $remarks = "Pending reservation for grave " . $transferToGrave . ". Awaiting execution.";
        } elseif ($status === 'Inactive') {
            $currentGraveId  = null;
            $transferToGrave = null;
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
            $transferToGrave,
            $contactName,
            $contactPhone,
            $contactEmail,
            $contactBarangay,        // <- barangay only
            $contactAddress,         // <- full street address
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

        $intermentIds[] = (int)$pdo->lastInsertId();
    }

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
    // 9. Soft-delete a few inactive interments
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

    $pdo->commit();

    // -----------------------------------------------------------------
    // 10. Summary
    // -----------------------------------------------------------------
    echo "\n✅ Successfully seeded realistic dummy data!\n";
    echo "   - Database: $db\n";
    echo "   - Users: " . $pdo->query("SELECT COUNT(*) FROM users")->fetchColumn() . "\n";
    echo "   - Blocks: " . $pdo->query("SELECT COUNT(*) FROM blocks")->fetchColumn() . "\n";
    echo "   - Graves: " . $pdo->query("SELECT COUNT(*) FROM graves")->fetchColumn() . "\n";
    echo "   - Interments: " . $pdo->query("SELECT COUNT(*) FROM interments")->fetchColumn() . "\n";
    echo "   - Transfer logs: " . $pdo->query("SELECT COUNT(*) FROM transfer_log")->fetchColumn() . "\n";
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }

    echo "❌ Failed to seed data: " . $e->getMessage() . "\n";
    exit(1);
}
