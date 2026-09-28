<?php
/**
 * Base test case: Brain Monkey plus the WordPress functions every test needs.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase as PHPUnitTestCase;

abstract class TestCase extends PHPUnitTestCase {
	/**
	 * Transients set during the test, keyed by name.
	 *
	 * @var array<string, mixed>
	 */
	protected $transients = array();

	/**
	 * Capabilities the current user has.
	 *
	 * @var string[]
	 */
	protected $capabilities = array( 'edit_posts' );

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();

		$this->transients   = array();
		$this->capabilities = array( 'edit_posts' );

		Functions\stubTranslationFunctions();
		Functions\stubs(
			array(
				'absint'                => static function ( $value ) {
					return abs( (int) $value );
				},
				'wp_json_encode'        => static function ( $value, $flags = 0 ) {
					return json_encode( $value, $flags );
				},
				'is_wp_error'           => static function ( $value ) {
					return $value instanceof \WP_Error;
				},
				'sanitize_text_field'   => static function ( $value ) {
					return trim( strip_tags( (string) $value ) );
				},
				'wp_strip_all_tags'     => static function ( $value ) {
					return trim( strip_tags( (string) $value ) );
				},
				'wp_specialchars_decode' => static function ( $value ) {
					return htmlspecialchars_decode( (string) $value, ENT_QUOTES );
				},
				'get_bloginfo'          => 'Test Site',
				'get_current_user_id'   => 7,
				'admin_url'             => static function ( $path = '' ) {
					return 'https://example.test/wp-admin/' . $path;
				},
				'rest_ensure_response'  => static function ( $data ) {
					return $data instanceof \WP_REST_Response ? $data : new \WP_REST_Response( $data );
				},
				'rest_convert_error_to_response' => static function ( \WP_Error $error ) {
					$data = $error->get_error_data();
					return new \WP_REST_Response(
						array(
							'code'    => $error->get_error_code(),
							'message' => $error->get_error_message(),
						),
						is_array( $data ) && isset( $data['status'] ) ? $data['status'] : 500
					);
				},
				'current_user_can'      => function ( $capability ) {
					return in_array( $capability, $this->capabilities, true );
				},
				'get_transient'         => function ( $key ) {
					return array_key_exists( $key, $this->transients ) ? $this->transients[ $key ] : false;
				},
				'set_transient'         => function ( $key, $value ) {
					$this->transients[ $key ] = $value;
					return true;
				},
			)
		);

		require_once AGENTIC_EDITOR_PLUGIN_DIR . 'includes/chat-rest.php';
		require_once AGENTIC_EDITOR_PLUGIN_DIR . 'includes/image-rest.php';
	}

	protected function tearDown(): void {
		Monkey\tearDown();
		parent::tearDown();
	}
}
