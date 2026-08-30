<?php

require_once 'notallowed.php';

function formatPhNumber($number, $strict = true)
{
    $clean = preg_replace('/[^0-9]/', '', $number);
    if (strlen($clean) == 11 && substr($clean, 0, 2) == '09') {
        $clean = '63' . substr($clean, 1);
    } elseif (strlen($clean) == 10 && substr($clean, 0, 1) == '9') {
        $clean = '63' . $clean;
    }
    if (substr($clean, 0, 3) == '639' && strlen($clean) == 12) {
        return '+' . $clean;
    }
    if (!$strict) return $number;
    return false;
}
