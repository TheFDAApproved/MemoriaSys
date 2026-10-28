<?php

// Dynamic stylesheet endpoint
// Reads main color and background image from settings and emits CSS variables
// Uses root-relative URLs so it works unchanged on any server or subfolder

define('ITS_ME_JUSTTOVERIFY', true);

// A stray notice or warning would corrupt the CSS, so never print errors
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
error_reporting(E_ALL);

// Escape a value for use inside a quoted CSS string or url()
function its_css_escape(string $value): string
{
    return addcslashes($value, "\\'\"\n\r\f");
}

// Return the root-relative URL prefix of the folder this file lives in
// Prefers realpath(__DIR__) minus DOCUMENT_ROOT, falls back to SCRIPT_NAME
function its_url_prefix(): string
{
    $docRoot = !empty($_SERVER['DOCUMENT_ROOT']) ? realpath($_SERVER['DOCUMENT_ROOT']) : false;
    $selfDir = realpath(__DIR__);

    if ($docRoot !== false && $selfDir !== false) {
        $docRoot = rtrim(str_replace('\\', '/', $docRoot), '/');
        $selfDir = str_replace('\\', '/', $selfDir);

        // Windows paths are case-insensitive, *nix paths are not
        $isUnderDocRoot = DIRECTORY_SEPARATOR === '\\'
            ? stripos($selfDir . '/', $docRoot . '/') === 0
            : strpos($selfDir . '/', $docRoot . '/') === 0;

        if ($isUnderDocRoot) {
            return substr($selfDir, strlen($docRoot));
        }
    }

    if (!empty($_SERVER['SCRIPT_NAME'])) {
        $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
        return ($dir === '.' || $dir === '/') ? '' : $dir;
    }

    return '.';
}

// Parse a CSS color into an [r, g, b] array, or null if not understood
function its_color_to_rgb(string $color): ?array
{
    $color = strtolower(trim($color));

    // Named colors so that "red" or "blue" still works
    static $named = [
        'black' => '000000',
        'silver' => 'c0c0c0',
        'gray' => '808080',
        'grey' => '808080',
        'white' => 'ffffff',
        'maroon' => '800000',
        'red' => 'ff0000',
        'purple' => '800080',
        'fuchsia' => 'ff00ff',
        'magenta' => 'ff00ff',
        'green' => '008000',
        'lime' => '00ff00',
        'olive' => '808000',
        'yellow' => 'ffff00',
        'navy' => '000080',
        'blue' => '0000ff',
        'teal' => '008080',
        'aqua' => '00ffff',
        'cyan' => '00ffff',
        'orange' => 'ffa500',
        'pink' => 'ffc0cb',
        'brown' => 'a52a2a',
        'gold' => 'ffd700',
        'indigo' => '4b0082',
        'violet' => 'ee82ee',
        'beige' => 'f5f5dc',
        'ivory' => 'fffff0',
        'khaki' => 'f0e68c',
        'salmon' => 'fa8072',
        'tomato' => 'ff6347',
        'coral' => 'ff7f50',
        'crimson' => 'dc143c',
        'darkgray' => 'a9a9a9',
        'darkgrey' => 'a9a9a9',
        'lightgray' => 'd3d3d3',
        'lightgrey' => 'd3d3d3',
        'dimgray' => '696969',
        'dimgrey' => '696969',
        'slategray' => '708090',
        'slategrey' => '708090',
        'rebeccapurple' => '663399',
    ];
    if (isset($named[$color])) {
        $color = '#' . $named[$color];
    }

    // Hex forms: #rgb, #rgba, #rrggbb, #rrggbbaa
    if (preg_match('/^#([0-9a-f]{3,8})$/i', $color, $m)) {
        $h = $m[1];
        $n = strlen($h);
        if ($n === 3 || $n === 4) {
            return [
                hexdec(str_repeat($h[0], 2)),
                hexdec(str_repeat($h[1], 2)),
                hexdec(str_repeat($h[2], 2)),
            ];
        }
        if ($n === 6 || $n === 8) {
            return [
                hexdec(substr($h, 0, 2)),
                hexdec(substr($h, 2, 2)),
                hexdec(substr($h, 4, 2)),
            ];
        }
        return null;
    }

    // rgb() and rgba()
    if (preg_match('/^rgba?\(\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*(?:[,;\/]\s*[0-9.]+%?\s*)?\)$/i', $color, $m)) {
        $chan = static function (string $v): int {
            $v = trim($v);
            $f = (float) $v;
            if (substr($v, -1) === '%') {
                $f = $f * 255 / 100;
            }
            return (int) max(0, min(255, round($f)));
        };
        return [$chan($m[1]), $chan($m[2]), $chan($m[3])];
    }

    // hsl() and hsla()
    if (preg_match('/^hsla?\(\s*([0-9.]+)(?:deg)?\s*[,\s]\s*([0-9.]+)%\s*[,\s]\s*([0-9.]+)%\s*(?:[,;\/]\s*[0-9.]+%?\s*)?\)$/i', $color, $m)) {
        return its_hsl_to_rgb((float) $m[1], (float) $m[2], (float) $m[3]);
    }

    return null;
}

// Convert HSL to RGB, all inputs in their normal CSS ranges
function its_hsl_to_rgb(float $h, float $s, float $l): array
{
    $h = fmod(fmod($h, 360) + 360, 360) / 360;
    $s = max(0, min(100, $s)) / 100;
    $l = max(0, min(100, $l)) / 100;

    if ($s == 0.0) {
        $v = (int) round($l * 255);
        return [$v, $v, $v];
    }

    $q = $l < 0.5 ? $l * (1 + $s) : $l + $s - $l * $s;
    $p = 2 * $l - $q;

    $conv = static function (float $t) use ($p, $q): float {
        if ($t < 0) {
            $t += 1;
        }
        if ($t > 1) {
            $t -= 1;
        }
        if ($t < 1 / 6) {
            return $p + ($q - $p) * 6 * $t;
        }
        if ($t < 1 / 2) {
            return $q;
        }
        if ($t < 2 / 3) {
            return $p + ($q - $p) * (2 / 3 - $t) * 6;
        }
        return $p;
    };

    return [
        (int) round($conv($h + 1 / 3) * 255),
        (int) round($conv($h) * 255),
        (int) round($conv($h - 1 / 3) * 255),
    ];
}

// Return the WCAG relative luminance of an RGB triplet
function its_luminance(array $rgb): float
{
    $lin = static function (float $c): float {
        $c /= 255;
        return $c <= 0.03928 ? $c / 12.92 : (($c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * $lin($rgb[0]) + 0.7152 * $lin($rgb[1]) + 0.0722 * $lin($rgb[2]);
}

// Return the WCAG contrast ratio between two RGB triplets
function its_contrast(array $a, array $b): float
{
    $la = its_luminance($a);
    $lb = its_luminance($b);
    return (max($la, $lb) + 0.05) / (min($la, $lb) + 0.05);
}

// Mix an RGB triplet with white and return a hex string
function its_lighten(array $rgb, float $amount): string
{
    $out = [];
    foreach ($rgb as $c) {
        $out[] = (int) round($c + (255 - $c) * $amount);
    }
    return sprintf('#%02x%02x%02x', $out[0], $out[1], $out[2]);
}

// Build an rgba() string from an RGB triplet and alpha
function its_rgba(array $rgb, float $alpha): string
{
    $a = rtrim(rtrim(number_format($alpha, 3, '.', ''), '0'), '.');
    return sprintf('rgba(%d, %d, %d, %s)', $rgb[0], $rgb[1], $rgb[2], $a === '' ? '0' : $a);
}

// Read main_color from settings, swallow any DB error so the CSS still loads
$mainColor = '';

$dbFile = __DIR__ . '/database.php';
if (is_file($dbFile)) {
    require_once $dbFile;
}

if (isset($pdo)) {
    try {
        $stmt = $pdo->prepare(
            "SELECT setting_value FROM settings
              WHERE setting_key = 'main_color' AND deleted_at IS NULL
              LIMIT 1"
        );
        $stmt->execute();
        $fetched = $stmt->fetchColumn();
        if (is_string($fetched)) {
            $mainColor = trim($fetched);
        }
    } catch (Throwable $e) {
        error_log('[style.php] settings query failed: ' . $e->getMessage());
    }
}

// Validate the color, then derive the readable sidebar text color in PHP
$isValidColor = $mainColor !== '' && (bool) preg_match(
    '/^(?:[a-z]+|#[0-9a-f]{3,8}|rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)|hsla?\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\))$/i',
    $mainColor
);

if (!$isValidColor) {
    $mainColor = '';
}
$hasColor = $isValidColor;
$mainRgb  = $hasColor ? its_color_to_rgb($mainColor) : null;

// Pick black or white for sidebar text, whichever contrasts more with the main color
$sidebarText    = '#ffffff';
$sidebarTextRgb = [255, 255, 255];

if ($mainRgb !== null) {
    if (its_contrast($mainRgb, [0, 0, 0]) > its_contrast($mainRgb, [255, 255, 255])) {
        $sidebarText    = '#000000';
        $sidebarTextRgb = [0, 0, 0];
    }
}

// Background image path, relative to this PHP file
$bgRelativePath = 'images/cemetery_background.png';

// Resolve against __DIR__, not the current working directory
$bgFsPath = __DIR__ . DIRECTORY_SEPARATOR
    . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $bgRelativePath);

$hasImage = is_file($bgFsPath);

// Root-relative URL keeps behaviour identical on Laragon, XAMPP, and live
$bgUrl = $hasImage
    ? its_url_prefix() . '/' . ltrim(str_replace('\\', '/', $bgRelativePath), '/')
    : null;

// Serve CSS with an ETag so repeat visits get a 304 and skip the body
header('Content-Type: text/css; charset=UTF-8');
header('X-Content-Type-Options: nosniff');
header('Vary: Accept-Encoding');

$etag = '"' . substr(hash('sha256', $mainColor . '|' . ($bgUrl ?? '') . '|' . ($hasColor ? 1 : 0)), 0, 32) . '"';
header('ETag: ' . $etag);
header('Cache-Control: no-cache');

if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
    http_response_code(304);
    exit;
}
?>
:root {

<?php if ($bgUrl !== null): ?>
    --backgroundImage: url('<?= its_css_escape($bgUrl) ?>');
<?php endif; ?>

<?php if ($hasColor): ?>
    --mainColor: <?= $mainColor ?>;

    /* Precomputed in PHP since contrast-color() isn't supported everywhere yet */
    --sidebarText: <?= $sidebarText ?>;

    <?php if ($mainRgb !== null): ?>
        /* Static fallbacks for browsers without color-mix() */
        --sidebar-hover: <?= its_lighten($mainRgb, 0.12) ?>;
        --sidebar-border: <?= its_lighten($mainRgb, 0.18) ?>;
        --sidebar-accent: <?= its_lighten($mainRgb, 0.40) ?>;
        --sidebarText-muted: <?= its_rgba($sidebarTextRgb, 0.70) ?>;
    <?php endif; ?>

<?php endif; ?>
}

<?php if ($hasColor): ?>
    /* Modern browsers: live color-mix() overrides the fallbacks above */
    @supports (color: color-mix(in srgb, red, white)) {
    :root {
    --sidebar-hover: color-mix(in srgb, var(--mainColor), white 12%);
    --sidebar-border: color-mix(in srgb, var(--mainColor), white 18%);
    --sidebar-accent: color-mix(in srgb, var(--mainColor), white 40%);
    --sidebarText-muted: color-mix(in srgb, var(--sidebarText), transparent 30%);
    }
    }
<?php endif; ?>

/* Disabled state */

/* Native disabled controls */
button:disabled,
input:disabled,
select:disabled,
textarea:disabled,
optgroup:disabled,
option:disabled,
fieldset:disabled {
cursor: not-allowed !important;
pointer-events: auto !important;
}

/* ARIA-disabled, works on <a>, <div>, wrappers, etc. */
        [aria-disabled="true"],
        [aria-disabled="true"] * {
        cursor: not-allowed !important;
        pointer-events: auto !important;
        }

        /* Class-based disabled, common in component libraries */
        .is-disabled,
        .is-disabled *,
        .disabled,
        .disabled * {
        cursor: not-allowed !important;
        pointer-events: auto !important;
        }