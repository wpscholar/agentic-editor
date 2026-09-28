<?php
/**
 * Just enough of the WordPress core classes the chat endpoint touches.
 *
 * phpcs:disable Generic.Files.OneObjectPerFile, Squiz.Commenting
 *
 * @package AgenticEditor
 */

class WP_Error {
	/** @var array<string, string[]> */
	public $errors = array();

	/** @var array<string, mixed> */
	public $error_data = array();

	public function __construct( $code = '', $message = '', $data = '' ) {
		if ( '' === $code ) {
			return;
		}
		$this->errors[ $code ][] = $message;
		if ( '' !== $data ) {
			$this->error_data[ $code ] = $data;
		}
	}

	public function get_error_code() {
		$codes = array_keys( $this->errors );
		return $codes ? $codes[0] : '';
	}

	public function get_error_message() {
		$code = $this->get_error_code();
		return '' === $code ? '' : $this->errors[ $code ][0];
	}

	public function get_error_data() {
		$code = $this->get_error_code();
		return isset( $this->error_data[ $code ] ) ? $this->error_data[ $code ] : null;
	}
}

class WP_REST_Request {
	/** @var string */
	private $body;

	public function __construct( $body = '' ) {
		$this->body = is_string( $body ) ? $body : (string) json_encode( $body );
	}

	public function get_body() {
		return $this->body;
	}

	public function get_json_params() {
		return json_decode( $this->body, true );
	}

	public function get_param( $key ) {
		$params = $this->get_json_params();
		return is_array( $params ) && array_key_exists( $key, $params ) ? $params[ $key ] : null;
	}
}

class WP_REST_Response {
	/** @var mixed */
	public $data;

	/** @var int */
	public $status;

	/** @var array<string, string> */
	public $headers = array();

	public function __construct( $data = null, $status = 200 ) {
		$this->data   = $data;
		$this->status = $status;
	}

	public function header( $key, $value ) {
		$this->headers[ $key ] = $value;
	}

	public function get_data() {
		return $this->data;
	}
}

class WP_REST_Server {
	const READABLE  = 'GET';
	const CREATABLE = 'POST';
}
