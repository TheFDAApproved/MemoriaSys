<?php

require_once 'notallowed.php';

// Image upload, resize, rename, and delete with per-file flock() locking
class ImageManager
{
    private $uploadDir;
    private $baseUrl;
    private $maxFileSize;
    private $lockDir;

    // Max ms to wait for a file lock before giving up
    // A timeout returns 503 to don't hang the worker
    private $lockTimeoutMs = 3000;

    // Strict MIME types to accept
    private $allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    // 150 leaves room for added suffixes and the extension
    private $maxFilenameLength = 150;

    public function __construct($uploadDirPath = null, $baseUrlPath = null, $maxFileSize = 10485760, $lockTimeoutMs = 3000)
    {
        $this->uploadDir = $uploadDirPath ?? __DIR__ . '/images/';
        $this->maxFileSize = $maxFileSize;
        $this->lockTimeoutMs = max(100, (int)$lockTimeoutMs);

        // Locks live in locks/ so images/ stays clean and cleanup can target one folder
        $baseForLocks = rtrim($this->uploadDir, '/\\') . DIRECTORY_SEPARATOR;
        $this->lockDir = $baseForLocks . 'locks' . DIRECTORY_SEPARATOR;
        if (!is_dir($this->lockDir)) {
            @mkdir($this->lockDir, 0755, true);
        }

        // Behind a proxy the real scheme is in X-Forwarded-Proto, not HTTPS
        $protocol = 'http';
        if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
            $protocol = 'https';
        } elseif (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') {
            $protocol = 'https';
        }

        // Same for host, but it may be a list so take the first
        $host = $_SERVER['HTTP_HOST'];
        if (isset($_SERVER['HTTP_X_FORWARDED_HOST'])) {
            $host = $_SERVER['HTTP_X_FORWARDED_HOST'];
            if (strpos($host, ',') !== false) {
                $host = explode(',', $host)[0];
            }
        }

        $scriptDir = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
        $this->baseUrl = $baseUrlPath ?? $protocol . '://' . $host . $scriptDir . '/images/';

        if (!is_dir($this->uploadDir)) {
            if (!mkdir($this->uploadDir, 0755, true)) {
                // Silent on failure, log here if you add a logger
            }
        }
    }

    private function getExtensionFromMime($mimeType)
    {
        $map = [
            'image/jpeg' => 'jpg',
            'image/png'  => 'png',
            'image/gif'  => 'gif',
            'image/webp' => 'webp'
        ];
        return $map[$mimeType] ?? false;
    }

    private function getSafeFilename($filename)
    {
        // Empty input would trip null warnings in preg_replace
        if (empty($filename)) {
            return false;
        }

        // Cast so the regex always gets a string
        $safe = preg_replace('/[^a-zA-Z0-9_\.-]/', '', basename((string)$filename));
        if ($safe === '' || $safe === '.' || $safe === '..') {
            return false;
        }
        return $safe;
    }

    private function validateImage($filePath, $originalName)
    {
        if (!file_exists($filePath)) {
            return 'Source file does not exist.';
        }

        $size = @filesize($filePath);
        if ($size === false || $size > $this->maxFileSize) {
            return 'File exceeds the maximum allowed size of ' . ($this->maxFileSize / 1024 / 1024) . 'MB.';
        }

        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if (!$finfo) {
            return 'Server configuration error: cannot verify file type.';
        }
        $mime = finfo_file($finfo, $filePath);
        // finfo_close() is deprecated in PHP 8.5+

        if ($mime === false || !in_array($mime, $this->allowedMimeTypes, true)) {
            return 'Invalid file content. Only standard images are allowed.';
        }

        if (@getimagesize($filePath) === false) {
            return 'File is corrupted or is not a valid image.';
        }

        return ['success' => true, 'mime' => $mime];
    }

    // Resize an image in place to exact target dimensions, stretching to fit
    // Keeps transparency for formats that support it
    private function resizeImage($sourcePath, $targetWidth, $targetHeight, $mimeType)
    {
        if (!extension_loaded('gd')) {
            return ['success' => false, 'error' => 'GD extension is required for image resizing.'];
        }

        $info = @getimagesize($sourcePath);
        if ($info === false) {
            return ['success' => false, 'error' => 'Could not read image dimensions.'];
        }

        $srcW = (int)$info[0];
        $srcH = (int)$info[1];

        // Refuse huge sources so imagecreatetruecolor can't blow up memory
        if ($srcW * $srcH > 25_000_000) {
            return ['success' => false, 'error' => 'Source image is too large to resize safely.'];
        }

        switch ($mimeType) {
            case 'image/png':
                $src = @imagecreatefrompng($sourcePath);
                break;
            case 'image/jpeg':
                $src = @imagecreatefromjpeg($sourcePath);
                break;
            case 'image/gif':
                $src = @imagecreatefromgif($sourcePath);
                break;
            case 'image/webp':
                $src = @imagecreatefromwebp($sourcePath);
                break;
            default:
                return ['success' => false, 'error' => 'Unsupported image type for resizing.'];
        }

        if (!$src) {
            return ['success' => false, 'error' => 'Failed to load image for resizing.'];
        }

        $dst = imagecreatetruecolor($targetWidth, $targetHeight);

        // Keep transparency for formats that support it
        if (in_array($mimeType, ['image/png', 'image/gif', 'image/webp'], true)) {
            imagealphablending($dst, false);
            imagesavealpha($dst, true);
            $transparent = imagecolorallocatealpha($dst, 0, 0, 0, 127);
            imagefilledrectangle($dst, 0, 0, $targetWidth, $targetHeight, $transparent);
        }

        // Stretch to fit, ignoring aspect ratio
        imagecopyresampled(
            $dst,
            $src,
            0,
            0,
            0,
            0,
            $targetWidth,
            $targetHeight,
            $srcW,
            $srcH
        );

        $saved = false;
        switch ($mimeType) {
            case 'image/png':
                $saved = imagepng($dst, $sourcePath, 9);
                break;
            case 'image/jpeg':
                $saved = imagejpeg($dst, $sourcePath, 90);
                break;
            case 'image/gif':
                $saved = imagegif($dst, $sourcePath);
                break;
            case 'image/webp':
                $saved = imagewebp($dst, $sourcePath, 90);
                break;
        }

        imagedestroy($src);
        imagedestroy($dst);

        if (!$saved) {
            return ['success' => false, 'error' => 'Failed to write resized image.'];
        }

        return ['success' => true];
    }

    // Wait up to lockTimeoutMs for an exclusive flock, return false on timeout
    // Never unlink the .lock file on release, doing so would break flock() for anyone still waiting
    private function acquireLock($targetPath, $timeoutMs = null)
    {
        if ($timeoutMs === null) {
            $timeoutMs = $this->lockTimeoutMs;
        }

        // In case the constructor was bypassed somehow
        if (!is_dir($this->lockDir)) {
            @mkdir($this->lockDir, 0755, true);
        }

        $lockFile = $this->lockDir . sha1($targetPath) . '.lock';
        $fp = fopen($lockFile, 'c+');
        if (!$fp) {
            return false;
        }

        $deadline = microtime(true) + ($timeoutMs / 1000);
        while (!flock($fp, LOCK_EX | LOCK_NB)) {
            if (microtime(true) >= $deadline) {
                fclose($fp);
                return false;
            }
            usleep(50000); // Sleep 50ms between attempts so it don't spin
        }

        return [
            'handle'    => $fp,
            'lock_file' => $lockFile
        ];
    }

    private function releaseLock($lock)
    {
        if (!is_array($lock) || !isset($lock['handle'])) {
            return;
        }

        $lockHandle = $lock['handle'];

        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);

        // Never unlink the lock file, a waiting process would end up locking a different inode
    }

    public function getAllImages($page = 1, $limit = 20, $search = '')
    {
        $allFiles = @scandir($this->uploadDir);
        if ($allFiles === false) {
            return [
                'success' => false,
                'error' => 'Unable to read image directory.',
                'status_code' => 500
            ];
        }

        $files = [];

        if (!empty($search)) {
            $searchTerm = trim($search);

            foreach ($allFiles as $file) {
                if ($file === '.' || $file === '..') {
                    continue;
                }
                // Skip the locks/ folder, it's not an image
                if ($file === 'locks') {
                    continue;
                }
                // Skip leftover .lock files from older versions
                if (substr($file, -5) === '.lock') {
                    continue;
                }
                if (stripos($file, $searchTerm) !== false) {
                    $files[] = $file;

                    if (count($files) >= 101) {
                        break;
                    }
                }
            }

            $images = [];
            foreach ($files as $file) {
                $fullPath = $this->uploadDir . $file;
                if (!is_file($fullPath)) {
                    continue;
                }
                $images[] = [
                    'filename' => $file,
                    'url' => $this->baseUrl . $file,
                    'size_in_bytes' => filesize($fullPath),
                    'type' => mime_content_type($fullPath)
                ];
            }

            return [
                'success' => true,
                'count' => count($images),
                'total_images' => count($images),
                'current_page' => 1,
                'total_pages' => 1,
                'search_term' => $search,
                'images' => $images,
                'per_page' => 101
            ];
        } else {
            foreach ($allFiles as $file) {
                if ($file === '.' || $file === '..') {
                    continue;
                }
                // Skip the locks/ folder, it's not an image
                if ($file === 'locks') {
                    continue;
                }
                // Skip leftover .lock files from older versions
                if (substr($file, -5) === '.lock') {
                    continue;
                }
                if (is_file($this->uploadDir . $file)) {
                    $files[] = $file;
                }
            }

            $limit = max(1, (int)$limit);
            $page = max(1, (int)$page);

            $totalImages = count($files);
            $totalPages = max(1, (int)ceil($totalImages / $limit));

            $page = max(1, min($page, $totalPages));

            $offset = ($page - 1) * $limit;

            $pagedFiles = array_slice($files, $offset, $limit);

            $images = [];
            foreach ($pagedFiles as $file) {
                $fullPath = $this->uploadDir . $file;
                $images[] = [
                    'filename' => $file,
                    'url' => $this->baseUrl . $file,
                    'size_in_bytes' => filesize($fullPath),
                    'type' => mime_content_type($fullPath)
                ];
            }

            return [
                'success' => true,
                'count' => count($images),
                'total_images' => $totalImages,
                'current_page' => $page,
                'total_pages' => $totalPages,
                'images' => $images,
                'per_page' => $limit
            ];
        }
    }

    // Save an uploaded image, optionally resizing, with uniqid suffix if the target exists
    // Returns the final filename and public URL
    public function uploadImage($tmpFilePath, $originalName, $requestedName = '', $replaceIfExists = false, $dimensions = null)
    {
        if (!file_exists($tmpFilePath)) {
            return ['success' => false, 'error' => 'Source file does not exist.'];
        }

        $validation = $this->validateImage($tmpFilePath, $originalName);
        if (!isset($validation['success'])) {
            return ['success' => false, 'error' => $validation];
        }

        $trueExt = $this->getExtensionFromMime($validation['mime']);
        if (!$trueExt) {
            return ['success' => false, 'error' => 'Unsupported image type.'];
        }

        // Resize first if the caller asked for specific dimensions
        if (
            is_array($dimensions)
            && !empty($dimensions['width'])
            && !empty($dimensions['height'])
        ) {
            $resizeResult = $this->resizeImage(
                $tmpFilePath,
                (int)$dimensions['width'],
                (int)$dimensions['height'],
                $validation['mime']
            );

            if (empty($resizeResult['success'])) {
                return [
                    'success' => false,
                    'error'   => $resizeResult['error'] ?? 'Image resize failed.',
                ];
            }
        }

        $baseName = trim($requestedName) !== '' ? trim($requestedName) : pathinfo($originalName, PATHINFO_FILENAME);
        $cleanName = preg_replace('/[^A-Za-z0-9_-]/', '', $baseName);

        if (empty($cleanName)) {
            $cleanName = 'img_' . bin2hex(random_bytes(5));
        }

        if (strlen($cleanName) > $this->maxFilenameLength - strlen($trueExt) - 1) {
            $cleanName = substr($cleanName, 0, $this->maxFilenameLength - strlen($trueExt) - 1);
        }

        $newName = $cleanName . '.' . $trueExt;
        $destination = $this->uploadDir . $newName;

        $lock = $this->acquireLock($destination);
        if (!$lock) {
            return [
                'success' => false,
                'error' => 'Could not obtain file lock. Please try again.',
                'status_code' => 503
            ];
        }

        try {
            if (file_exists($destination)) {
                if ($replaceIfExists) {
                    // Overwrite in place, nothing else to do
                } else {
                    // Append uniqid so it don't clobber the existing file
                    $suffix = '_' . uniqid('', true);
                    $newName = $cleanName . $suffix . '.' . $trueExt;

                    // Re-check length after the suffix was added
                    if (strlen($newName) > $this->maxFilenameLength) {
                        $baseLen = $this->maxFilenameLength - strlen($trueExt) - 1;
                        $newName = substr($cleanName, 0, $baseLen) . $suffix . '.' . $trueExt;
                    }

                    $destination = $this->uploadDir . $newName;
                }
            }

            if (is_uploaded_file($tmpFilePath)) {
                $saved = move_uploaded_file($tmpFilePath, $destination);
            } else {
                $saved = rename($tmpFilePath, $destination);
            }

            if (!$saved) {
                $error = error_get_last();
                $msg = 'Failed to save image on the server.';
                if ($error && stripos($error['message'] ?? '', 'No space left') !== false) {
                    $msg = 'Server storage is full. Please try again later.';
                    $code = 507;
                } elseif ($error && stripos($error['message'] ?? '', 'Permission denied') !== false) {
                    $msg = 'Server configuration error. Please contact support.';
                    $code = 500;
                } else {
                    $code = 500;
                }

                return ['success' => false, 'error' => $msg, 'status_code' => $code];
            }

            return [
                'success' => true,
                'message' => 'Image uploaded successfully.',
                'filename' => $newName,
                'url' => $this->baseUrl . $newName,
                'size_in_bytes' => filesize($destination),
                'type' => $validation['mime']
            ];
        } finally {
            $this->releaseLock($lock);
        }
    }

    public function replaceImage($targetFilename, $sourceStreamOrFile)
    {
        $safeOldFile = $this->getSafeFilename($targetFilename);
        if (!$safeOldFile) {
            return ['success' => false, 'error' => 'No target filename provided.'];
        }

        $oldDestination = $this->uploadDir . $safeOldFile;
        if (!file_exists($oldDestination)) {
            return ['success' => false, 'error' => 'Target image does not exist.', 'status_code' => 404];
        }

        $tempFile = tempnam(sys_get_temp_dir(), 'img_replace_');
        if ($tempFile === false) {
            return ['success' => false, 'error' => 'Server configuration error: cannot create temp file.'];
        }

        try {
            if (is_string($sourceStreamOrFile) && $sourceStreamOrFile === 'php://input') {
                $data = file_get_contents('php://input');
                if ($data === false) {
                    return ['success' => false, 'error' => 'Failed to read uploaded data.'];
                }
                if (file_put_contents($tempFile, $data) === false) {
                    return ['success' => false, 'error' => 'Failed to write temp file.'];
                }
            } else {
                if (!copy($sourceStreamOrFile, $tempFile)) {
                    return ['success' => false, 'error' => 'Failed to copy source file.'];
                }
            }

            $validation = $this->validateImage($tempFile, $safeOldFile);
            if (!isset($validation['success'])) {
                @unlink($tempFile);
                return ['success' => false, 'error' => $validation];
            }

            $trueExt = $this->getExtensionFromMime($validation['mime']);
            if (!$trueExt) {
                @unlink($tempFile);
                return ['success' => false, 'error' => 'Unsupported image type.'];
            }

            $oldExt = strtolower(pathinfo($safeOldFile, PATHINFO_EXTENSION));

            $baseName = pathinfo($safeOldFile, PATHINFO_FILENAME);
            $cleanName = preg_replace('/[^A-Za-z0-9_-]/', '', $baseName);
            if (empty($cleanName)) {
                $cleanName = 'img_' . bin2hex(random_bytes(5));
            }

            if (strlen($cleanName) > $this->maxFilenameLength - strlen($trueExt) - 1) {
                $cleanName = substr($cleanName, 0, $this->maxFilenameLength - strlen($trueExt) - 1);
            }

            $newFilename = $cleanName . '.' . $trueExt;
            $newDestination = $this->uploadDir . $newFilename;

            // Lock the new path, or the old one if the name didn't change
            $lockTarget = ($newDestination !== $oldDestination) ? $newDestination : $oldDestination;
            $lock = $this->acquireLock($lockTarget);
            if (!$lock) {
                @unlink($tempFile);
                return [
                    'success' => false,
                    'error' => 'Could not obtain file lock. Please try again.',
                    'status_code' => 503
                ];
            }

            try {
                // Collision prevention: if the new name differs and already exists, make it unique
                if ($newFilename !== $safeOldFile && file_exists($newDestination)) {
                    $suffix = '_' . uniqid('', true);
                    $baseLen = $this->maxFilenameLength - strlen($trueExt) - 1 - strlen($suffix);
                    $newFilename = substr($cleanName, 0, $baseLen) . $suffix . '.' . $trueExt;
                    $newDestination = $this->uploadDir . $newFilename;
                }

                if (!rename($tempFile, $newDestination)) {
                    @unlink($tempFile);
                    $error = error_get_last();
                    $msg = 'Failed to update image.';
                    if ($error && stripos($error['message'] ?? '', 'No space left') !== false) {
                        $msg = 'Server storage is full. Please try again later.';
                        $code = 507;
                    } elseif ($error && stripos($error['message'] ?? '', 'Permission denied') !== false) {
                        $msg = 'Server configuration error. Please contact support.';
                        $code = 500;
                    } else {
                        $code = 500;
                    }
                    return ['success' => false, 'error' => $msg, 'status_code' => $code];
                }

                // If the filename changed, remove the old file
                if ($newFilename !== $safeOldFile && file_exists($oldDestination)) {
                    @unlink($oldDestination);
                }

                $message = 'Image replaced successfully.';
                if ($oldExt !== $trueExt) {
                    $message = "Image replaced successfully from {$oldExt} to {$trueExt}.";
                }

                return [
                    'success' => true,
                    'message' => $message,
                    'filename' => $newFilename,
                    'url' => $this->baseUrl . $newFilename,
                    'size_in_bytes' => filesize($newDestination),
                    'type' => $validation['mime']
                ];
            } finally {
                $this->releaseLock($lock);
            }
        } finally {
            if (file_exists($tempFile)) {
                @unlink($tempFile);
            }
        }
    }

    public function deleteImage($targetFilename)
    {
        $safeFile = $this->getSafeFilename($targetFilename);

        if (!$safeFile) {
            return ['success' => false, 'error' => 'No filename provided.', 'status_code' => 400];
        }

        $destination = $this->uploadDir . $safeFile;

        $lock = $this->acquireLock($destination);
        if (!$lock) {
            return [
                'success' => false,
                'error' => 'Could not obtain file lock. Please try again.',
                'status_code' => 503
            ];
        }

        try {
            if (!file_exists($destination)) {
                return ['success' => false, 'error' => 'Image not found.', 'status_code' => 404];
            }

            if (!unlink($destination)) {
                $error = error_get_last();
                $msg = 'Failed to delete image.';
                if ($error && stripos($error['message'] ?? '', 'Permission denied') !== false) {
                    $msg = 'Server configuration error. Please contact support.';
                }
                return ['success' => false, 'error' => $msg, 'status_code' => 500];
            }

            return ['success' => true, 'message' => 'Image deleted successfully.'];
        } finally {
            $this->releaseLock($lock);
        }
    }

    // Rename an image, uniquifying if the target exists unless replaceIfExists is true
    // Keeps the original extension
    public function renameImage($oldFilename, $newRequestedName, $replaceIfExists = false)
    {
        $safeOldFile = $this->getSafeFilename($oldFilename);
        if (!$safeOldFile) {
            return ['success' => false, 'error' => 'No target filename provided.'];
        }

        $oldDestination = $this->uploadDir . $safeOldFile;
        if (!file_exists($oldDestination)) {
            return ['success' => false, 'error' => 'Target image does not exist.', 'status_code' => 404];
        }

        if (trim($newRequestedName) === '') {
            return ['success' => false, 'error' => 'New filename cannot be empty.'];
        }

        $ext = strtolower(pathinfo($safeOldFile, PATHINFO_EXTENSION));

        $cleanName = preg_replace('/[^A-Za-z0-9_-]/', '', trim($newRequestedName));
        if (empty($cleanName)) {
            $cleanName = 'img_' . bin2hex(random_bytes(5));
        }

        if (strlen($cleanName) > $this->maxFilenameLength - strlen($ext) - 1) {
            $cleanName = substr($cleanName, 0, $this->maxFilenameLength - strlen($ext) - 1);
        }

        $newFilename = $cleanName . '.' . $ext;
        $newDestination = $this->uploadDir . $newFilename;

        if ($newFilename === $safeOldFile) {
            return [
                'success' => true,
                'message' => 'Name is already unchanged.',
                'filename' => $safeOldFile,
                'url' => $this->baseUrl . $safeOldFile
            ];
        }

        // Lock both paths in sorted order so two opposite renames can't deadlock on each other
        $lockPaths = [$oldDestination, $newDestination];
        sort($lockPaths, SORT_STRING);

        $lockA = $this->acquireLock($lockPaths[0]);
        if (!$lockA) {
            return [
                'success' => false,
                'error' => 'Could not obtain file lock. Please try again.',
                'status_code' => 503
            ];
        }

        $lockB = $this->acquireLock($lockPaths[1]);
        if (!$lockB) {
            $this->releaseLock($lockA);
            return [
                'success' => false,
                'error' => 'Could not obtain file lock. Please try again.',
                'status_code' => 503
            ];
        }

        try {
            if (file_exists($newDestination)) {
                if ($replaceIfExists) {
                    // Delete the existing target so rename() can succeed
                    if (!unlink($newDestination)) {
                        $error = error_get_last();
                        $msg = 'Failed to remove existing file with new name.';
                        if ($error && stripos($error['message'] ?? '', 'Permission denied') !== false) {
                            $msg = 'Server configuration error. Please contact support.';
                        }
                        return ['success' => false, 'error' => $msg, 'status_code' => 500];
                    }
                } else {
                    // Append uniqid so it don't clobber the existing target
                    $suffix = '_' . uniqid('', true);
                    $baseLen = $this->maxFilenameLength - strlen($ext) - 1 - strlen($suffix);
                    $newFilename = substr($cleanName, 0, $baseLen) . $suffix . '.' . $ext;
                    $newDestination = $this->uploadDir . $newFilename;
                }
            }

            if (!rename($oldDestination, $newDestination)) {
                $error = error_get_last();
                $msg = 'Failed to rename image on the server.';
                if ($error && stripos($error['message'] ?? '', 'No space left') !== false) {
                    $msg = 'Server storage is full. Please try again later.';
                    $code = 507;
                } elseif ($error && stripos($error['message'] ?? '', 'Permission denied') !== false) {
                    $msg = 'Server configuration error. Please contact support.';
                    $code = 500;
                } else {
                    $code = 500;
                }
                return ['success' => false, 'error' => $msg, 'status_code' => $code];
            }

            return [
                'success' => true,
                'message' => 'Image renamed successfully.',
                'filename' => $newFilename,
                'url' => $this->baseUrl . $newFilename,
                'size_in_bytes' => filesize($newDestination),
                'type' => mime_content_type($newDestination)
            ];
        } finally {
            $this->releaseLock($lockA);
            $this->releaseLock($lockB);
        }
    }

    // Delete .lock files older than maxAgeSeconds that no one currently holds
    // Meant for cron, but if you don't want the theoretical unlink race, just don't call it
    // Skips any lock that flock() still reports as held
    public function cleanupStaleLocks($maxAgeSeconds = 86400)
    {
        $stats = ['deleted' => 0, 'skipped_active' => 0, 'skipped_recent' => 0, 'errors' => 0];

        // Where new-style locks live
        $this->cleanupLocksInDir($this->lockDir, $maxAgeSeconds, $stats);

        // Where old .jpg.lock files might still be hiding
        $this->cleanupLocksInDir($this->uploadDir, $maxAgeSeconds, $stats);

        return $stats;
    }

    private function cleanupLocksInDir($dir, $maxAgeSeconds, array &$stats)
    {
        if (!is_dir($dir)) {
            return;
        }

        $entries = @scandir($dir);
        if ($entries === false) {
            return;
        }

        $now = time();
        foreach ($entries as $file) {
            if ($file === '.' || $file === '..') {
                continue;
            }
            if (substr($file, -5) !== '.lock') {
                continue;
            }

            $path = $dir . $file;
            if (!is_file($path)) {
                continue;
            }

            $mtime = @filemtime($path);
            if ($mtime === false) {
                $stats['errors']++;
                continue;
            }
            if ($now - $mtime < $maxAgeSeconds) {
                $stats['skipped_recent']++;
                continue;
            }

            $fp = @fopen($path, 'c+');
            if (!$fp) {
                $stats['errors']++;
                continue;
            }

            if (!flock($fp, LOCK_EX | LOCK_NB)) {
                // Lock is held by a live process, leave it alone
                fclose($fp);
                $stats['skipped_active']++;
                continue;
            }

            $ok = @unlink($path);
            flock($fp, LOCK_UN);
            fclose($fp);

            if ($ok) {
                $stats['deleted']++;
            } else {
                $stats['errors']++;
            }
        }
    }
}
