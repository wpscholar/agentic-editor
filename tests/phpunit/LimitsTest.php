<?php
/**
 * Tests for the request limits and the per-user rate limit.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

use Brain\Monkey\Filters;

class LimitsTest extends TestCase {

	/**
	 * A request whose raw body matches the decoded body.
	 *
	 * @param array<string, mixed> $body Body.
	 * @return array{0: \WP_REST_Request, 1: array<string, mixed>}
	 */
	private function request( array $body ) {
		return array( new \WP_REST_Request( $body ), $body );
	}

	/**
	 * Messages for one user turn followed by some rounds of tool calls.
	 *
	 * @param int $rounds Rounds of tool calls.
	 * @return array<int, array<string, mixed>>
	 */
	private function messages_with_rounds( $rounds ) {
		$messages = array(
			array(
				'role'    => 'tool',
				'content' => 'From an earlier turn, not counted.',
			),
			array(
				'role'    => 'user',
				'content' => 'Go.',
			),
		);

		for ( $round = 0; $round < $rounds; $round++ ) {
			$messages[] = array( 'role' => 'assistant' );
			$messages[] = array( 'role' => 'tool' );
		}

		return $messages;
	}

	public function test_default_limits() {
		$this->assertSame(
			array(
				'max_body_bytes'       => MB_IN_BYTES,
				'max_messages'         => 500,
				'max_tools'            => 128,
				'max_context_chars'    => 2000,
				'max_attachment_chars' => 8000,
				'requests_per_minute'  => 60,
			),
			agentic_editor_chat_limits()
		);
		$this->assertSame( 25, agentic_editor_chat_max_tool_rounds() );
	}

	public function test_filtered_limits_are_integers_with_defaults_for_missing_keys() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn(
			array(
				'max_messages' => '10',
				'max_tools'    => -3,
			)
		);

		$limits = agentic_editor_chat_limits();

		$this->assertSame( 10, $limits['max_messages'] );
		$this->assertSame( 3, $limits['max_tools'] );
		$this->assertSame( 60, $limits['requests_per_minute'] );
	}

	public function test_a_filter_returning_a_non_array_keeps_the_defaults() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( 'nope' );

		$this->assertSame( 500, agentic_editor_chat_limits()['max_messages'] );
	}

	public function test_tool_rounds_never_drop_below_one() {
		Filters\expectApplied( 'agentic_editor_chat_max_tool_rounds' )->andReturn( 0 );

		$this->assertSame( 1, agentic_editor_chat_max_tool_rounds() );
	}

	public function test_a_request_within_limits_passes() {
		list( $request, $body ) = $this->request(
			array(
				'messages' => $this->messages_with_rounds( 25 ),
				'tools'    => array_fill( 0, 128, array( 'name' => 'x' ) ),
			)
		);

		$this->assertTrue( agentic_editor_chat_check_limits( $request, $body ) );
	}

	public function test_a_large_body_is_rejected() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'max_body_bytes' => 10 ) );
		list( $request, $body ) = $this->request( array( 'messages' => array( 'x' ) ) );

		$result = agentic_editor_chat_check_limits( $request, $body );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'agentic_editor_request_too_large', $result->get_error_code() );
		$this->assertSame( 413, $result->get_error_data()['status'] );
	}

	public function test_too_many_messages_are_rejected() {
		list( $request, $body ) = $this->request( array( 'messages' => array_fill( 0, 501, 'x' ) ) );

		$result = agentic_editor_chat_check_limits( $request, $body );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'agentic_editor_too_many_messages', $result->get_error_code() );
	}

	public function test_too_many_tools_are_rejected() {
		list( $request, $body ) = $this->request( array( 'tools' => array_fill( 0, 129, array() ) ) );

		$result = agentic_editor_chat_check_limits( $request, $body );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'agentic_editor_too_many_tools', $result->get_error_code() );
	}

	public function test_too_many_rounds_since_the_last_user_message_are_rejected() {
		list( $request, $body ) = $this->request( array( 'messages' => $this->messages_with_rounds( 26 ) ) );

		$result = agentic_editor_chat_check_limits( $request, $body );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'agentic_editor_too_many_rounds', $result->get_error_code() );
	}

	public function test_a_zero_limit_turns_it_off() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn(
			array(
				'max_body_bytes' => 0,
				'max_messages'   => 0,
				'max_tools'      => 0,
			)
		);
		list( $request, $body ) = $this->request(
			array(
				'messages' => array_fill( 0, 600, 'x' ),
				'tools'    => array_fill( 0, 200, array() ),
			)
		);

		$this->assertTrue( agentic_editor_chat_check_limits( $request, $body ) );
	}

	public function test_rate_limit_allows_up_to_the_limit_then_rejects() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'requests_per_minute' => 3 ) );

		for ( $request = 0; $request < 3; $request++ ) {
			$this->assertTrue( agentic_editor_chat_check_rate_limit() );
		}

		$result = agentic_editor_chat_check_rate_limit();

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'agentic_editor_rate_limited', $result->get_error_code() );
		$this->assertSame( 429, $result->get_error_data()['status'] );
		$this->assertGreaterThanOrEqual( 1, $result->get_error_data()['retryAfter'] );
		$this->assertLessThanOrEqual( 60, $result->get_error_data()['retryAfter'] );
	}

	public function test_rate_limit_is_per_user() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'requests_per_minute' => 1 ) );

		agentic_editor_chat_check_rate_limit();

		$this->assertArrayHasKey( 'agentic_editor_chat_rate_7', $this->transients );
	}

	public function test_rate_limit_window_resets_after_a_minute() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'requests_per_minute' => 1 ) );
		$this->transients['agentic_editor_chat_rate_7'] = array(
			'start' => time() - 61,
			'count' => 1,
		);

		$this->assertTrue( agentic_editor_chat_check_rate_limit() );
		$this->assertSame( 1, $this->transients['agentic_editor_chat_rate_7']['count'] );
	}

	public function test_a_corrupt_rate_window_is_replaced() {
		$this->transients['agentic_editor_chat_rate_7'] = 'garbage';

		$this->assertTrue( agentic_editor_chat_check_rate_limit() );
		$this->assertSame( 1, $this->transients['agentic_editor_chat_rate_7']['count'] );
	}

	public function test_a_zero_rate_limit_turns_it_off() {
		Filters\expectApplied( 'agentic_editor_chat_limits' )->andReturn( array( 'requests_per_minute' => 0 ) );

		for ( $request = 0; $request < 100; $request++ ) {
			$this->assertTrue( agentic_editor_chat_check_rate_limit() );
		}
		$this->assertSame( array(), $this->transients );
	}
}
