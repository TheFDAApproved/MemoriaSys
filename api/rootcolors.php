<?php
define('ITS_ME_JUSTTOVERIFY', true);
require_once 'database.php';

header("Content-type: text/css; charset: UTF-8");

// --- Fetch main color ---
$stmt = $pdo->prepare("SELECT setting_value FROM settings WHERE setting_key = 'main_color' AND deleted_at is NULL LIMIT 1");
$stmt->execute();
$mainColor = $stmt->fetchColumn();

// Validate: only allow safe CSS color formats
$isValidColor = false;
if (!empty($mainColor)) {
    $color = trim($mainColor);
    $isValidColor = preg_match('/^(?:[a-z]+|#[0-9a-f]{3,8}|rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)|hsla?\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\))$/i', $color);
    if ($isValidColor) {
        $mainColor = $color; // sanitized
    }
}

$hasColor = $isValidColor;

// --- Background image ---
$bgRelativePath = 'images/cemetery_background.png';

$protocol = isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? "https" : "http";
$domain = $_SERVER['HTTP_HOST'];
// Fix: Strip trailing slashes to prevent double-slash bugs on live servers
$folder = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');

$bgCssPath = $protocol . "://" . $domain . $folder . "/" . $bgRelativePath;

// Note: This checks the server's hard drive relative to THIS PHP file. 
// If this PHP file is in the "api" folder, the "images" folder MUST be inside the "api" folder too.
$hasImage = file_exists($bgRelativePath);
?>

:root {

<?php if ($hasImage): ?>
    --backgroundImage: url('<?= $bgCssPath ?>');
<?php endif; ?>

<?php if ($hasColor): ?>
    --mainColor: <?= $mainColor ?>;

    /* Replaced contrast-color() with a solid fallback until browsers support it */
    --sidebarText: #ffffff; /* Or calculate this in PHP based on $mainColor brightness */

    --sidebar-hover: color-mix(in srgb, var(--mainColor), white 12%);
    --sidebar-border: color-mix(in srgb, var(--mainColor), white 18%);
    --sidebar-accent: color-mix(in srgb, var(--mainColor), white 40%);
    --sidebarText-muted: color-mix(in srgb, var(--sidebarText), transparent 30%);
<?php endif; ?>

<?php if (!$hasColor && !$hasImage): ?>
    /* Nothing set, no image no main color */
<?php endif; ?>

}