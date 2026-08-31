<?php
define('ITS_ME_JUSTTOVERIFY', true);
require_once 'database.php';

header("Content-type: text/css; charset: UTF-8");

// --- Fetch main color ---
$stmt = $pdo->prepare("SELECT setting_value FROM settings WHERE setting_key = 'main_color' LIMIT 1");
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
$bgCssPath = "../../api/" . $bgRelativePath;   //change this if the path to the image is different and maybe on deployment on the webserver i guess

$hasImage = file_exists($bgRelativePath);
?>

:root {

<?php if ($hasImage): ?>
    --backgroundImage: url('<?= $bgCssPath ?>');
<?php endif; ?>

<?php if ($hasColor): ?>
    --mainColor: <?= $mainColor ?>;

    --sidebarText: contrast-color(var(--mainColor));

    --sidebar-hover: color-mix(in srgb, var(--mainColor), white 12%);
    --sidebar-border: color-mix(in srgb, var(--mainColor), white 18%);
    --sidebar-accent: color-mix(in srgb, var(--mainColor), white 40%);
    --sidebarText-muted: color-mix(in srgb, var(--sidebarText), transparent 30%);
<?php endif; ?>

<?php if (!$hasColor && !$hasImage): ?>
    /* Nothing set, no image no main color */
<?php endif; ?>

}