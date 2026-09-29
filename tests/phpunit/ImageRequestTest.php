<?php
/**
 * Tests for the image endpoint, against a fake AI Client and Media Library.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

use Brain\Monkey\Filters;
use Brain\Monkey\Functions;
use WordPress\AiClient\Files\DTO\File;
use WordPress\AiClient\Files\Enums\MediaOrientationEnum;

/**
 * Records what the handler asks of the prompt builder and plays back one image.
 */
class FakeImageBuilder {
	/** @var bool Whether the fake connector can generate images. */
	public static $supported = true;

	/** @var mixed What generate_image() returns. */
	public static $result;

	/** @var array<int, array<string, mixed>> Every builder, in order. */
	public static $builders = array();

	/** @var int Generations run. */
	public static $generations = 0;

	/** @var array<string, mixed> */
	public $call;

	/**
	 * @param mixed $prompt Prompt.
	 */
	public function __construct( $prompt ) {
		$this->call       = array( 'prompt' => $prompt );
		self::$builders[] = &$this->call;
	}

	public function as_output_media_orientation( MediaOrientationEnum $orientation ) {
		$this->call['orientation'] = $orientation;
		return $this;
	}

	public function using_model_preference( ...$models ) {
		$this->call['models'] = $models;
		return $this;
	}

	public function is_supported_for_image_generation() {
		return self::$supported;
	}

	public function generate_image() {
		++self::$generations;
		return self::$result;
	}
}

class ImageRequestTest extends TestCase {

	/** A 1×1 transparent PNG. */
	const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

	/** @var array<int, array<string, mixed>> Sideloads, in order. */
	private $sideloads = array();

	/** @var array<string, mixed> Post meta written, keyed by "id:key". */
	private $meta = array();

	/** @var string[] Temporary files created. */
	private $temp_files = array();

	protected function setUp(): void {
		parent::setUp();

		FakeImageBuilder::$supported   = true;
		FakeImageBuilder::$result      = new File( self::PNG, 'image/png' );
		FakeImageBuilder::$builders    = array();
		FakeImageBuilder::$generations = 0;

		$this->sideloads    = array();
		$this->meta         = array();
		$this->temp_files   = array();
		$this->capabilities = array( 'edit_posts', 'upload_files' );

		Functions\when( 'wp_ai_client_prompt' )->alias(
			static function ( $prompt ) {
				return new FakeImageBuilder( $prompt );
			}
		);

		Functions\stubs(
			array(
				'wp_trim_words'               => static function ( $text, $num_words = 55, $more = null ) {
					return implode( ' ', array_slice( preg_split( '/\s+/', trim( (string) $text ) ), 0, $num_words ) );
				},
				'sanitize_title'              => static function ( $title ) {
					return trim( (string) preg_replace( '/[^a-z0-9]+/', '-', strtolower( (string) $title ) ), '-' );
				},
				'sanitize_file_name'          => static function ( $name ) {
					return (string) $name;
				},
				'get_allowed_mime_types'      => array(
					'jpg|jpeg|jpe' => 'image/jpeg',
					'png'          => 'image/png',
					'pdf'          => 'application/pdf',
				),
				'wp_tempnam'                  => function () {
					$name               = (string) tempnam( sys_get_temp_dir(), 'agentic-editor-test' );
					$this->temp_files[] = $name;
					return $name;
				},
				'download_url'                => function ( $url ) {
					$name               = (string) tempnam( sys_get_temp_dir(), 'agentic-editor-test' );
					$this->temp_files[] = $name;
					file_put_contents( $name, base64_decode( self::PNG ) );
					return $name;
				},
				'media_handle_sideload'       => function ( $file_array, $post_id, $desc = null, $post_data = array() ) {
					$this->sideloads[] = array(
						'file'      => $file_array,
						'post_id'   => $post_id,
						'desc'      => $desc,
						'post_data' => $post_data,
						'bytes'     => (string) file_get_contents( $file_array['tmp_name'] ),
					);
					return 42;
				},
				'wp_generate_attachment_metadata' => null,
				'wp_delete_file'              => static function ( $file ) {
					if ( file_exists( $file ) ) {
						unlink( $file );
					}
				},
				'update_post_meta'            => function ( $id, $key, $value ) {
					$this->meta[ $id . ':' . $key ] = $value;
					return true;
				},
				'get_post_meta'               => function ( $id, $key ) {
					return $this->meta[ $id . ':' . $key ] ?? '';
				},
				'wp_get_attachment_url'       => 'https://example.test/wp-content/uploads/2026/09/lighthouse.png',
				'wp_get_attachment_metadata'  => array(
					'width'  => 1536,
					'height' => 1024,
					'sizes'  => array(
						'large' => array(
							'file'   => 'lighthouse-1024x683.png',
							'width'  => 1024,
							'height' => 683,
						),
					),
				),
				'get_the_title'               => 'Lighthouse',
				'get_post_mime_type'          => 'image/png',
				'trailingslashit'             => static function ( $value ) {
					return rtrim( (string) $value, '/\\' ) . '/';
				},
			)
		);
	}

	protected function tearDown(): void {
		foreach ( $this->temp_files as $file ) {
			if ( file_exists( $file ) ) {
				unlink( $file );
			}
		}
		parent::tearDown();
	}

	/**
	 * @param array<string, mixed> $body Body.
	 * @return mixed
	 */
	private function send( array $body ) {
		return agentic_editor_handle_image_request( new \WP_REST_Request( $body ) );
	}

	public function test_an_image_is_generated_and_added_to_the_media_library() {
		$response = $this->send(
			array(
				'prompt'      => 'A lighthouse at dusk with waves breaking on the rocks',
				'orientation' => 'portrait',
				'alt'         => 'A lighthouse at dusk',
				'title'       => 'Lighthouse',
			)
		);

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$data = $response->get_data();

		$this->assertSame( 42, $data['id'] );
		$this->assertSame( 'https://example.test/wp-content/uploads/2026/09/lighthouse.png', $data['url'] );
		$this->assertSame( 'A lighthouse at dusk', $data['alt'] );
		$this->assertSame( 1536, $data['width'] );
		$this->assertSame( 'https://example.test/wp-content/uploads/2026/09/lighthouse-1024x683.png', $data['sizes']['large']['url'] );

		$this->assertCount( 1, $this->sideloads );
		$this->assertSame( 'lighthouse.png', $this->sideloads[0]['file']['name'] );
		$this->assertSame( base64_decode( self::PNG ), $this->sideloads[0]['bytes'] );
		$this->assertSame( 0, $this->sideloads[0]['post_id'] );
		$this->assertStringContainsString( 'A lighthouse at dusk with waves', $this->sideloads[0]['post_data']['post_content'] );

		$this->assertSame( 'A lighthouse at dusk with waves breaking on the rocks', $this->meta['42:_agentic_editor_image_prompt'] );
		$this->assertTrue( MediaOrientationEnum::portrait()->equals( end( FakeImageBuilder::$builders )['orientation'] ) );
		$this->assertArrayNotHasKey( 'models', end( FakeImageBuilder::$builders ) );
	}

	public function test_alt_text_and_title_default_to_the_prompt() {
		$this->send( array( 'prompt' => 'A red bicycle leaning on a wall' ) );

		$this->assertSame( 'A red bicycle leaning on a wall', $this->meta['42:_wp_attachment_image_alt'] );
		$this->assertSame( 'a-red-bicycle-leaning-on-a-wall.png', $this->sideloads[0]['file']['name'] );
		$this->assertTrue( MediaOrientationEnum::landscape()->equals( end( FakeImageBuilder::$builders )['orientation'] ) );
	}

	public function test_a_remote_image_is_downloaded() {
		FakeImageBuilder::$result = new File( 'https://provider.example/image.png', 'image/png' );

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( base64_decode( self::PNG ), $this->sideloads[0]['bytes'] );
	}

	public function test_the_image_is_attached_only_to_a_post_the_user_can_edit() {
		$this->send(
			array(
				'prompt' => 'A cat',
				'postId' => 9,
			)
		);
		$this->assertSame( 0, $this->sideloads[0]['post_id'] );

		$this->capabilities[] = 'edit_post';
		$this->send(
			array(
				'prompt' => 'A cat',
				'postId' => 9,
			)
		);
		$this->assertSame( 9, $this->sideloads[1]['post_id'] );
	}

	public function test_a_site_without_an_image_model_is_told_so() {
		FakeImageBuilder::$supported = false;

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_image_unsupported', $response->get_error_code() );
		$this->assertSame( 501, $response->get_error_data()['status'] );
		$this->assertSame( 0, FakeImageBuilder::$generations );
		$this->assertSame( array(), $this->transients );
	}

	public function test_a_provider_failure_hides_its_details_from_non_admins() {
		FakeImageBuilder::$result = new \WP_Error( 'prompt_client_error', 'Quota exceeded for key sk-123' );

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_generation_failed', $response->get_error_code() );
		$this->assertStringNotContainsString( 'sk-123', $response->get_error_message() );
		$this->assertSame( array(), $this->sideloads );
	}

	public function test_something_other_than_an_image_is_rejected() {
		FakeImageBuilder::$result = new File( base64_encode( '%PDF-1.4' ), 'application/pdf' );

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_image_not_an_image', $response->get_error_code() );
		$this->assertSame( array(), $this->sideloads );
	}

	public function test_an_image_type_the_site_does_not_accept_is_rejected() {
		FakeImageBuilder::$result = new File( self::PNG, 'image/webp' );

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_image_type_not_allowed', $response->get_error_code() );
	}

	public function test_a_failed_sideload_removes_the_temporary_file() {
		Functions\when( 'media_handle_sideload' )->justReturn( new \WP_Error( 'upload_error', 'Disk full' ) );

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_image_upload_failed', $response->get_error_code() );
		$this->assertStringContainsString( 'Disk full', $response->get_error_message() );
		foreach ( $this->temp_files as $file ) {
			$this->assertFileDoesNotExist( $file );
		}
	}

	public function test_image_generation_counts_against_the_rate_limit() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'requests_per_minute' => 1 ) );
		$this->transients['agentic_editor_chat_rate_7'] = array(
			'start' => time(),
			'count' => 1,
		);

		$response = $this->send( array( 'prompt' => 'A cat' ) );

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 429, $response->status );
		$this->assertSame( 0, FakeImageBuilder::$generations );
	}

	public function test_a_model_preference_is_applied_when_a_site_sets_one() {
		Filters\expectApplied( 'agentic_editor_image_model_preference' )->andReturn( array( 'imagen-4' ) );

		$this->send( array( 'prompt' => 'A cat' ) );

		$this->assertSame( array( 'imagen-4' ), end( FakeImageBuilder::$builders )['models'] );
	}

	public function test_generating_images_needs_upload_rights() {
		$this->assertTrue( agentic_editor_user_can_generate_images() );

		$this->capabilities = array( 'edit_posts' );
		$this->assertFalse( agentic_editor_user_can_generate_images() );
	}

	public function test_availability_follows_the_connector() {
		$this->assertTrue( agentic_editor_image_is_available() );

		FakeImageBuilder::$supported = false;
		$this->assertFalse( agentic_editor_image_is_available() );
	}
}
