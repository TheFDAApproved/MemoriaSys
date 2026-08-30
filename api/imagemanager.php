<?php

require_once 'notallowed.php';

class ImageManager {
    private $uploadDir;
    private $baseUrl;
    private $maxFileSize;

    // Allowed strict MIME types
    private $allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    // Max filename length (leave room for added suffixes and extension)
    private $maxFilenameLength = 150;

    public function __construct($uploadDirPath = null, $baseUrlPath = null, $maxFileSize = 10485760) {
        $this->uploadDir = $uploadDirPath ?? __DIR__ . '/images/';
        $this->maxFileSize = $maxFileSize;

        // 1. Determine the correct protocol (http vs https)
        $protocol = 'http';
        if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
            $protocol = 'https';
        } elseif (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') {
            $protocol = 'https';
        }

        // 2. Determine the correct host (Ngrok URL vs Local URL)
        $host = $_SERVER['HTTP_HOST'];
        if (isset($_SERVER['HTTP_X_FORWARDED_HOST'])) {
            $host = $_SERVER['HTTP_X_FORWARDED_HOST'];
            if (strpos($host, ',') !== false) {
                $host = explode(',', $host)[0];
            }
        }

        // 3. Build the final URL
        $scriptDir = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
        $this->baseUrl = $baseUrlPath ?? $protocol . '://' . $host . $scriptDir . '/images/';

        if (!is_dir($this->uploadDir)) {
            // 0755 is usually fine; adjust if your environment requires it
            if (!mkdir($this->uploadDir, 0755, true)) {
                // Log this internally if you have a logger
            }
        }
    }

    private function getExtensionFromMime($mimeType) {
        $map = [
            'image/jpeg' => 'jpg',
            'image/png'  => 'png',
            'image/gif'  => 'gif',
            'image/webp' => 'webp'
        ];
        return $map[$mimeType] ?? false;
    }

    private function getSafeFilename($filename) {
        // Prevent null deprecation errors
        if (empty($filename)) {
            return false;
        }
        
        // Cast to string just to be absolutely safe
        $safe = preg_replace('/[^a-zA-Z0-9_\.-]/', '', basename((string)$filename));
        if ($safe === '' || $safe === '.' || $safe === '..') {
            return false;
        }
        return $safe;
    }

    private function validateImage($filePath, $originalName) {
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
        finfo_close($finfo);

        if ($mime === false || !in_array($mime, $this->allowedMimeTypes, true)) {
            return 'Invalid file content. Only standard images are allowed.';
        }

        if (@getimagesize($filePath) === false) {
            return 'File is corrupted or is not a valid image.';
        }

        return ['success' => true, 'mime' => $mime];
    }

    /**
     * Get an exclusive lock on a .lock file for a given target path.
     * Returns an array with handle and path on success, false on failure.
     */
    private function acquireLock($targetPath) {
        $lockFile = $targetPath . '.lock';
        $fp = fopen($lockFile, 'c+');
        if (!$fp) {
            return false;
        }

        // Try to get exclusive lock
        if (!flock($fp, LOCK_EX)) {
            fclose($fp);
            @unlink($lockFile);
            return false;
        }

        // Return both the file pointer and the lock file path as an array
        return [
            'handle' => $fp,
            'lock_file' => $lockFile
        ];
    }

    private function releaseLock($lock) {
        // Ensure we received the correct lock array structure
        if (!is_array($lock) || !isset($lock['handle'])) {
            return;
        }
        
        $lockHandle = $lock['handle'];
        $lockFile = $lock['lock_file'];

        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);

        if ($lockFile && file_exists($lockFile)) {
            @unlink($lockFile);
        }
    }

    public function getAllImages($page = 1, $limit = 20, $search = '') {
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

    /**
     * Upload image with optional "replace if exists" behavior and file locking.
     *
     * @param string $tmpFilePath     Path to uploaded temp file
     * @param string $originalName    Original filename from form
     * @param string $requestedName   Optional custom base name
     * @param bool   $replaceIfExists If true and file exists, replace it; otherwise add uniqid.
     */
    public function uploadImage($tmpFilePath, $originalName, $requestedName = '', $replaceIfExists = false) {
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

        $baseName = trim($requestedName) !== '' ? trim($requestedName) : pathinfo($originalName, PATHINFO_FILENAME);
        $cleanName = preg_replace('/[^A-Za-z0-9_-]/', '', $baseName);

        if (empty($cleanName)) {
            $cleanName = 'img_' . bin2hex(random_bytes(5));
        }

        // Limit filename length
        if (strlen($cleanName) > $this->maxFilenameLength - strlen($trueExt) - 1) {
            $cleanName = substr($cleanName, 0, $this->maxFilenameLength - strlen($trueExt) - 1);
        }

        $newName = $cleanName . '.' . $trueExt;
        $destination = $this->uploadDir . $newName;

        // Acquire lock on the target file
        $lock = $this->acquireLock($destination);
        if (!$lock) {
            return [
                'success' => false,
                'error' => 'Could not obtain file lock. Please try again.',
                'status_code' => 503
            ];
        }

        try {
            // Handle existing file
            if (file_exists($destination)) {
                if ($replaceIfExists) {
                    // We will overwrite this file; nothing to change in name
                } else {
                    // Default behavior: make unique name
                    $suffix = '_' . uniqid('', true);
                    $newName = $cleanName . $suffix . '.' . $trueExt;

                    // Ensure we don't exceed max length again
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

    public function replaceImage($targetFilename, $sourceStreamOrFile) {
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

            // Lock the new destination (or old if same)
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
                // Collision prevention: if new name differs from old and exists, make unique
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

                // Cleanup: if the filename changed, delete the old file
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

    public function deleteImage($targetFilename) {
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

    /**
     * Rename image with optional "replace if exists" behavior and file locking.
     *
     * @param string $oldFilename     Current filename
     * @param string $newRequestedName New base name (without extension)
     * @param bool   $replaceIfExists If true and target exists, replace it; otherwise add uniqid.
     */
    public function renameImage($oldFilename, $newRequestedName, $replaceIfExists = false) {
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

        // Lock both old and new to avoid races
        $lockOld = $this->acquireLock($oldDestination);
        $lockNew = $this->acquireLock($newDestination);

        if (!$lockOld || !$lockNew) {
            if ($lockOld) $this->releaseLock($lockOld);
            if ($lockNew) $this->releaseLock($lockNew);
            return [
                'success' => false,
                'error' => 'Could not obtain file lock. Please try again.',
                'status_code' => 503
            ];
        }

        try {
            if (file_exists($newDestination)) {
                if ($replaceIfExists) {
                    // Remove existing target so rename can succeed
                    if (!unlink($newDestination)) {
                        $error = error_get_last();
                        $msg = 'Failed to remove existing file with new name.';
                        if ($error && stripos($error['message'] ?? '', 'Permission denied') !== false) {
                            $msg = 'Server configuration error. Please contact support.';
                        }
                        return ['success' => false, 'error' => $msg, 'status_code' => 500];
                    }
                } else {
                    // Default: make unique name
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
            $this->releaseLock($lockOld);
            $this->releaseLock($lockNew);
        }
    }
}
?>