<?php
/**
 * Tests for one chat request, end to end, against a fake AI Client.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

use Brain\Monkey\Filters;
use Brain\Monkey\Functions;
use WordPress\AiClient\Messages\DTO\MessagePart;
use WordPress\AiClient\Messages\DTO\ModelMessage;
use WordPress\AiClient\Messages\Enums\MessagePartChannelEnum;
use WordPress\AiClient\Tools\DTO\FunctionCall;

/**
 * Records what the handler asks of the prompt builder and plays back results.
 */
class FakePromptBuilder {
	/** @var array<int, array<string, mixed>> Every generation, in order. */
	public static $calls = array();

	/** @var array<int, mixed> Results to return, in order. */
	public static $results = array();

	/** @var array<string, mixed> */
	private $call;

	/**
	 * @param mixed $messages Prompt.
	 */
	public function __construct( $messages ) {
		$this->call = array(
			'messages'     => $messages,
			'declarations' => array(),
		);
	}

	public function using_system_instruction( $instruction ) {
		$this->call['system'] = $instruction;
		return $this;
	}

	public function using_model_preference( ...$models ) {
		$this->call['models'] = $models;
		return $this;
	}

	public function using_function_declarations( ...$declarations ) {
		$this->call['declarations'] = $declarations;
		return $this;
	}

	public function is_supported_for_text_generation() {
		return true;
	}

	public function as_output_media_orientation( $orientation ) {
		return $this;
	}

	public function is_supported_for_image_generation() {
		return false;
	}

	public function generate_text_result() {
		self::$calls[] = $this->call;
		return array_shift( self::$results );
	}
}

/**
 * The parts of GenerativeAiResult the handler reads.
 */
class FakeResult {
	/** @var ModelMessage */
	private $message;

	public function __construct( ModelMessage $message ) {
		$this->message = $message;
	}

	public function toMessage() {
		return $this->message;
	}
}

class ChatRequestTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();

		FakePromptBuilder::$calls   = array();
		FakePromptBuilder::$results = array();

		Functions\when( 'wp_ai_client_prompt' )->alias(
			static function ( $messages ) {
				return new FakePromptBuilder( $messages );
			}
		);
	}

	/**
	 * Send a request body to the handler.
	 *
	 * @param array<string, mixed> $body Body.
	 * @return mixed
	 */
	private function send( array $body ) {
		return agentic_editor_handle_chat_request( new \WP_REST_Request( $body ) );
	}

	/**
	 * A result that calls one tool.
	 *
	 * @param string $function_name Function name the model used.
	 * @return FakeResult
	 */
	private function tool_call_result( $function_name ) {
		return new FakeResult(
			new ModelMessage(
				array(
					new MessagePart( 'Thinking it over.', MessagePartChannelEnum::thought() ),
					new MessagePart( 'Checking.' ),
					new MessagePart( new FunctionCall( 'call_1', $function_name, array( 'clientId' => 'abc' ) ) ),
				)
			)
		);
	}

	public function test_a_turn_returns_text_tool_calls_and_replayable_parts() {
		FakePromptBuilder::$results[] = $this->tool_call_result( 'plugin_do-thing' );

		$response = $this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Do the thing.',
					),
				),
				'tools'    => array(
					array(
						'name'        => 'plugin.do-thing',
						'description' => 'Does the thing.',
						'inputSchema' => array(
							'type'       => 'object',
							'properties' => array( 'ids' => array( 'type' => 'array' ) ),
						),
					),
				),
			)
		);

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$data = $response->get_data();

		$this->assertSame( 'Checking.', $data['text'] );
		$this->assertSame( 'Thinking it over.', $data['reasoning'] );
		$this->assertSame(
			array(
				array(
					'id'        => 'call_1',
					'name'      => 'plugin.do-thing',
					'arguments' => array( 'clientId' => 'abc' ),
				),
			),
			$data['toolCalls']
		);
		$this->assertSame( 'assistant', $data['message']['role'] );
		$this->assertCount( 3, $data['message']['parts'] );
		$this->assertSame( 'native', $data['historyMode'] );

		$declaration = FakePromptBuilder::$calls[0]['declarations'][0];
		$this->assertSame( 'plugin_do-thing', $declaration->getName() );
		$this->assertSame( 'Does the thing.', $declaration->getDescription() );
		$this->assertSame( array( 'type' => 'string' ), $declaration->getParameters()['properties']['ids']['items'] );
	}

	public function test_an_undeclared_function_name_passes_through() {
		FakePromptBuilder::$results[] = $this->tool_call_result( 'made_up' );

		$data = $this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
				),
				'tools'    => array( array( 'name' => 'plugin.do-thing' ) ),
			)
		)->get_data();

		$this->assertSame( 'made_up', $data['toolCalls'][0]['name'] );
	}

	public function test_invalid_tools_are_skipped_and_descriptions_default_to_the_name() {
		FakePromptBuilder::$results[] = $this->tool_call_result( 'x' );

		$this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
				),
				'tools'    => array(
					'not a tool',
					array( 'name' => '' ),
					array( 'name' => array( 'x' ) ),
					array(
						'name'        => 'editor_noop',
						'description' => '  ',
					),
				),
			)
		);

		$declarations = FakePromptBuilder::$calls[0]['declarations'];
		$this->assertCount( 1, $declarations );
		$this->assertSame( 'editor_noop', $declarations[0]->getDescription() );
		$this->assertNull( $declarations[0]->getParameters() );
	}

	public function test_page_context_rides_on_the_user_message() {
		FakePromptBuilder::$results[] = $this->tool_call_result( 'x' );

		$this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
				),
				'context'  => array( 'screen' => 'Edit Post' ),
			)
		);

		$call = FakePromptBuilder::$calls[0];
		$this->assertStringContainsString( '<page_context>', $call['messages'][0]->getParts()[0]->getText() );
		$this->assertStringNotContainsString( 'Edit Post', $call['system'] );
	}

	public function test_a_thought_signature_failure_retries_once_as_text() {
		FakePromptBuilder::$results[] = new \WP_Error( 'prompt_client_error', 'Missing thought_signature for function call.', array( 'status' => 400 ) );
		FakePromptBuilder::$results[] = $this->tool_call_result( 'x' );

		$response = $this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
					array(
						'role'  => 'assistant',
						'parts' => array(
							array(
								'functionCall' => array(
									'id'   => 'call_0',
									'name' => 'x',
								),
							),
						),
					),
					array(
						'role'      => 'tool',
						'responses' => array(
							array(
								'id'       => 'call_0',
								'name'     => 'x',
								'response' => 'ok',
							),
						),
					),
				),
			)
		);

		$this->assertCount( 2, FakePromptBuilder::$calls );
		$this->assertNotNull( FakePromptBuilder::$calls[0]['messages'][1]->getParts()[0]->getFunctionCall() );
		$this->assertSame( 'Called x with {}', FakePromptBuilder::$calls[1]['messages'][1]->getParts()[0]->getText() );
		$this->assertSame( 'text', $response->get_data()['historyMode'] );
	}

	public function test_text_mode_is_used_when_the_client_asks_for_it() {
		FakePromptBuilder::$results[] = new \WP_Error( 'prompt_client_error', 'Missing thought_signature.', array( 'status' => 400 ) );

		$response = $this->send(
			array(
				'messages'    => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
				),
				'historyMode' => 'text',
			)
		);

		// Already in text mode, so there is nothing to fall back to.
		$this->assertCount( 1, FakePromptBuilder::$calls );
		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_generation_failed', $response->get_error_code() );
	}

	public function test_other_failures_are_not_retried() {
		FakePromptBuilder::$results[] = new \WP_Error( 'prompt_failed', 'Quota exceeded.' );

		$response = $this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
				),
			)
		);

		$this->assertCount( 1, FakePromptBuilder::$calls );
		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 502, $response->get_error_data()['status'] );
	}

	public function test_a_non_object_body_is_rejected() {
		$response = agentic_editor_handle_chat_request( new \WP_REST_Request( '"hello"' ) );

		$this->assertInstanceOf( \WP_Error::class, $response );
		$this->assertSame( 'agentic_editor_invalid_body', $response->get_error_code() );
	}

	public function test_a_rejected_request_does_not_count_against_the_rate_limit() {
		$this->send( array( 'messages' => array() ) );

		$this->assertSame( array(), $this->transients );
		$this->assertSame( array(), FakePromptBuilder::$calls );
	}

	public function test_a_rate_limited_request_says_when_to_retry() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'requests_per_minute' => 1 ) );
		$this->transients['agentic_editor_chat_rate_7'] = array(
			'start' => time(),
			'count' => 1,
		);

		$response = $this->send(
			array(
				'messages' => array(
					array(
						'role'    => 'user',
						'content' => 'Go.',
					),
				),
			)
		);

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 429, $response->status );
		$this->assertArrayHasKey( 'Retry-After', $response->headers );
		$this->assertSame( array(), FakePromptBuilder::$calls );
	}

	public function test_status_reports_the_ai_client() {
		$this->capabilities = array( 'edit_posts', 'manage_options' );

		$data = agentic_editor_handle_chat_status_request()->get_data();

		$this->assertTrue( $data['hasAiClient'] );
		$this->assertTrue( $data['available'] );
		$this->assertFalse( $data['imageGeneration'] );
		$this->assertSame( 'https://example.test/wp-admin/options-connectors.php', $data['connectorsUrl'] );
	}

	public function test_status_hides_the_connectors_url_from_non_admins() {
		$this->assertNull( agentic_editor_handle_chat_status_request()->get_data()['connectorsUrl'] );
	}
}
