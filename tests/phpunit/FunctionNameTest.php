<?php
/**
 * Tests for rewriting WebMCP tool names into provider function names.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

class FunctionNameTest extends TestCase {

	/**
	 * Whether every provider accepts a function name.
	 *
	 * @param string $name Function name.
	 * @return bool
	 */
	private function is_valid( $name ) {
		return 1 === preg_match( '/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/', $name );
	}

	/**
	 * @dataProvider provide_names
	 *
	 * @param string $tool_name Tool name.
	 * @param string $expected  Function name.
	 */
	public function test_names_are_rewritten( $tool_name, $expected ) {
		$this->assertSame( $expected, agentic_editor_chat_function_name( $tool_name, array() ) );
	}

	/**
	 * @return array<string, array{0: string, 1: string}>
	 */
	public function provide_names() {
		return array(
			'already valid'    => array( 'editor_get-editor-tree', 'editor_get-editor-tree' ),
			'dots'             => array( 'shop.cart.add', 'shop_cart_add' ),
			'other characters' => array( 'a b/c:d', 'a_b_c_d' ),
			'edge hyphens'     => array( '-tool-', 'tool' ),
			'empty'            => array( '', 'tool' ),
			'only hyphens'     => array( '---', 'tool' ),
			'leading digit'    => array( '3d-view', '_3d-view' ),
			'exactly 64'       => array( str_repeat( 'a', 64 ), str_repeat( 'a', 64 ) ),
		);
	}

	public function test_a_long_name_is_cut_to_64_with_a_hash() {
		$name = agentic_editor_chat_function_name( str_repeat( 'a', 100 ), array() );

		$this->assertSame( 64, strlen( $name ) );
		$this->assertTrue( $this->is_valid( $name ) );
		$this->assertStringStartsWith( str_repeat( 'a', 55 ) . '_', $name );
	}

	public function test_long_names_that_share_a_prefix_stay_distinct() {
		$prefix = str_repeat( 'a', 70 );

		$this->assertNotSame(
			agentic_editor_chat_function_name( $prefix . '_one', array() ),
			agentic_editor_chat_function_name( $prefix . '_two', array() )
		);
	}

	public function test_a_colliding_name_gets_a_stable_suffix() {
		$taken = array( 'shop_cart' => 'shop_cart' );

		$first  = agentic_editor_chat_function_name( 'shop.cart', $taken );
		$second = agentic_editor_chat_function_name(
			'shop.cart',
			$taken + array( 'unrelated' => 'unrelated' )
		);

		$this->assertNotSame( 'shop_cart', $first );
		$this->assertSame( $first, $second );
		$this->assertTrue( $this->is_valid( $first ) );
	}

	public function test_many_collisions_all_get_distinct_valid_names() {
		$taken = array();

		for ( $index = 0; $index < 1500; $index++ ) {
			// All of these rewrite to the same base name.
			$tool_name = 'tool' . str_repeat( '.', $index % 3 + 1 ) . str_repeat( '/', intdiv( $index, 3 ) );
			$name      = agentic_editor_chat_function_name( $tool_name, $taken );

			$this->assertArrayNotHasKey( $name, $taken, "Collision at {$index}" );
			$this->assertTrue( $this->is_valid( $name ), "Invalid at {$index}: {$name}" );
			$taken[ $name ] = $tool_name;
		}
	}

	public function test_the_same_tool_twice_gets_two_names() {
		$taken = array();

		$first           = agentic_editor_chat_function_name( 'x.y', $taken );
		$taken[ $first ] = 'x.y';
		$second          = agentic_editor_chat_function_name( 'x.y', $taken );
		$taken[ $second ] = 'x.y';
		$third           = agentic_editor_chat_function_name( 'x.y', $taken );

		$this->assertCount( 3, array_unique( array( $first, $second, $third ) ) );
	}
}
