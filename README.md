# Memoria: Mandaue City Public Cemetery Management System

**Memoria** is a comprehensive web-based cemetery management and spatial locator system developed for the **Mandaue City Public Cemetery** under the **Mandaue City Department of General Services (DGS) – Cemetery Affairs Section**. 

Built with lightweight, dependency-free frontend technologies and a modular PHP backend, Memoria streamlines burial record management, plot reservations, lease expiration monitoring, payment tracking, and public grave searching.

## Key Features

* **Interactive 2D Map**: Visualizes cemetery blocks and grave plots in real time for both administrative allocation and public grave searching.
* **Role-Based Portals**: Provides tailored dashboards and permissions for System Administrators, Office Staff, Grounds Personnel, and Public Visitors.
* **Burial Records**: Manages deceased profiles, interment details, plot assignments, and printable official certificates.
* **Reservation Workflows**: Supports online and walk-in plot reservations across office and grounds operations.
* **Lease Monitoring**: Tracks burial lease statuses and expirations with automated color-coded indicators.
* **SMS Notifications**: Sends automated lease reminders and system alerts via the TextBee SMS gateway integration.
* **Payment Processing**: Logs burial fees, reservation payments, and transaction histories with exportable financial reports.
* **CMS & Theming**: Allows administrators to customize site content, imagery, and root color palettes dynamically.
* **Security & Backups**: Protects endpoints with JWT authentication, rate limiting, activity audit logs, CSV exports, and one-click SQL backups.

## Tech Stack

* **Frontend**: HTML5, CSS3 (Custom Glassmorphic UI & CSS Variables), Vanilla JavaScript (ES6+)
* **Backend**: PHP 8.x (Modular API Architecture)
* **Database**: MySQL / MariaDB
* **Authentication**: Firebase PHP-JWT (JSON Web Tokens)
* **SMS Gateway**: TextBee API Integration
* **Server Environment**: Apache (Pre-configured for Laragon, XAMPP, and production hosting)

## Repository Structure

```text
memoria/
├── api/                        # Backend PHP API endpoints
│   ├── jwt/                    # PHP-JWT authentication library
│   ├── auth.php                # Login, signup, and token verification
│   ├── backup.php              # Database backup and restore handler
│   ├── blocks.php              # Cemetery block management API
│   ├── checkuser.php           # Session and user validation
│   ├── config.example.php      # Environment configuration template
│   ├── csv.php                 # Bulk CSV import and export utility
│   ├── dashboard.php           # Summary metrics and KPI aggregation
│   ├── database.php            # PDO/MySQLi database connection
│   ├── graves.php              # Grave plot CRUD and status API
│   ├── imagemanager.php        # Media upload and asset handler
│   ├── logger.php              # Internal system event logger
│   ├── logs.php                # Audit log retrieval endpoint
│   ├── monitor.php             # Lease expiration tracking engine
│   ├── notallowed.laragon.php  # Laragon access restriction template
│   ├── notallowed.xampp.php    # XAMPP access restriction template
│   ├── payments.php            # Financial transaction processing
│   ├── ratelimit.php           # Request throttling middleware
│   ├── records.php             # Deceased and burial record API
│   ├── reports.php             # Analytical and financial reporting
│   ├── reserve.php             # Plot reservation management
│   ├── responses.php           # Standardized JSON response helper
│   ├── reusable_functions.php  # Shared backend utility functions
│   ├── rootcolors.php          # Dynamic CSS theme variable API
│   ├── search.php              # Public and admin grave search
│   ├── settings.php            # System configuration endpoint
│   ├── sms.php                 # Notification dispatch controller
│   ├── textbee.php             # TextBee SMS gateway wrapper
│   └── users.php               # User account and role management
├── assets/
│   ├── css/                    # Modular page and component stylesheets
│   ├── images/                 # Logos, map assets, and UI graphics
│   └── js/                     # Frontend controllers and UI modules
├── .htaccess.laragon           # Apache rewrite rules for root/virtual hosts
├── .htaccess.xampp             # Apache rewrite rules for subdirectories
├── index.html                  # Public landing page and grave locator
├── login.html                  # User authentication portal
├── admin.html                  # Administrator portal shell
├── office.html                 # Office staff portal shell
├── grounds.html                # Grounds personnel portal shell
├── dashboard.html              # Analytics dashboard view
├── map.html                    # Interactive 2D cemetery map view
├── records.html                # Burial records management view
├── reserve.html                # Office plot reservation view
├── grounds_reserve.html        # Grounds plot reservation view
├── payments.html               # Master payment management view
├── office_payments.html        # Office payment processing view
├── grounds_payments.html       # Grounds payment processing view
├── monitor.html                # Lease expiration monitoring view
├── reports.html                # Printable and exportable reports view
├── accounts.html               # User account administration view
├── logs.html                   # System audit logs view
├── settings.html               # System and SMS configuration view
├── site_content.html           # Public website CMS editor
├── user_profile.html           # Personal account settings view
├── sql.txt                     # Core MySQL database schema
└── sql_dummy_data.txt          # Sample dataset for testing
```

## Installation & Local Setup

1. **Clone the Repository**
   Place the project folder inside your local web server directory (such as **C:/laragon/www/memoria** for Laragon or **C:/xampp/htdocs/memoria** for XAMPP).

2. **Set Up the Database**
   * Open **phpMyAdmin** or your preferred MySQL client and create a new database.
   * Import the schema from **sql.txt**.
   * *(Optional)* Import **sql_dummy_data.txt** to populate the system with sample blocks, plots, and burial records for testing.

3. **Configure Environment Credentials & Routing**
   * **API Credentials**: Navigate to the **api/** directory and duplicate **config.example.php** as **config.php**. Update **api/config.php** with your MySQL database credentials, JWT secret key, and TextBee SMS API key and device ID.
   * **Access Restriction Handler**: In the **api/** directory, create **notallowed.php** (by duplicating **notallowed.laragon.php** or **notallowed.xampp.php** as **notallowed.php**) and update its redirect path to point to your **404.html** URL.
   * **Apache Routing (.htaccess)**: Copy or rename **.htaccess.laragon** or **.htaccess.xampp** to **.htaccess** in the project root, then modify the rewrite and error document paths based on your URL structure:
     * **Subdirectory Setup** (e.g., **http://localhost/project_name**): Prepend your folder name to the paths (such as **/project_name/404.html** and **/project_name/api/notallowed.php**).
     * **Root Domain or Virtual Host Setup** (e.g., **http://project_name.test** or **https://project_name.com**): Use root-relative paths without a subfolder prefix (such as **/404.html** and **/api/notallowed.php**).

4. **Launch the Application**
   * Start Apache and MySQL in Laragon, XAMPP, or your hosting control panel.
   * Open your browser and navigate to your configured URL (such as **http://localhost/memoria/** or **http://memoria.test**).

## Development Team

Developed by **Team DND** from the Bachelor of Science in Information Technology (BSIT) program at **Mandaue City College (MCC)** in partnership with the **Mandaue City Department of General Services (DGS)**:
