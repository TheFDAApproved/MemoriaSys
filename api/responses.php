<?php

require_once 'notallowed.php';

class Response {
    
    public static function send($status, $success, $message, $data = null,) {
        
        http_response_code($status);
        header('Content-Type: application/json; charset=UTF-8');
        header('Access-Control-Allow-Origin: *'); // If needed for CORS

        $responseBody = [
            'success' => $success,
            'status'  => $status,
            'message' => $message
        ];

        if ($data !== null) {
            $responseBody['data'] = $data;
        }

        echo json_encode($responseBody, JSON_PRETTY_PRINT);
        exit();
    }


    public static function success($message, $data = null, $status = 200) {
        self::send($status, true, $message, $data);
    }

    public static function error($message, $status = 400) {
        self::send($status, false, $message);
    }

}
?>