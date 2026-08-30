<?php

if (!defined('ITS_ME_JUSTTOVERIFY')) {
    http_response_code(404);
    require $_SERVER['DOCUMENT_ROOT'] . '/404.html'; // Load a custom 404 page '/memoria/404.html If not in rootest root folder LOL'
    exit();
}

?>