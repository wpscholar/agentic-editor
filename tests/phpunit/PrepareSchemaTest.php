<?php
/**
 * Tests for making client tool schemas safe to send to a provider.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

class PrepareSchemaTest extends TestCase {

	/**
	 * Encode a prepared schema the way the provider request will.
	 *
	 * @param mixed $schema Prepared schema.
	 * @return string
	 */
	private function encode( $schema ) {
		return (string) json_encode( $schema );
	}

	public function test_empty_schema_encodes_as_an_object() {
		$this->assertSame( '{}', $this->encode( agentic_editor_chat_prepare_schema( array() ) ) );
	}

	public function test_scalars_pass_through() {
		$this->assertSame( 'string', agentic_editor_chat_prepare_schema( 'string' ) );
		$this->assertTrue( agentic_editor_chat_prepare_schema( true ) );
	}

	/**
	 * @dataProvider provide_empty_sub_schemas
	 *
	 * @param array<string, mixed> $schema   Schema as decoded from client JSON.
	 * @param string               $expected Expected JSON once prepared.
	 */
	public function test_empty_sub_schemas_encode_as_objects( array $schema, $expected ) {
		$this->assertSame( $expected, $this->encode( agentic_editor_chat_prepare_schema( $schema ) ) );
	}

	/**
	 * @return array<string, array{0: array<string, mixed>, 1: string}>
	 */
	public function provide_empty_sub_schemas() {
		return array(
			'properties'           => array(
				array(
					'type'       => 'object',
					'properties' => array(),
				),
				'{"type":"object","properties":{}}',
			),
			'a property'           => array(
				array(
					'type'       => 'object',
					'properties' => array( 'value' => array() ),
				),
				'{"type":"object","properties":{"value":{}}}',
			),
			'additionalProperties' => array(
				array(
					'type'                 => 'object',
					'additionalProperties' => array(),
				),
				'{"type":"object","additionalProperties":{}}',
			),
			'patternProperties'    => array(
				array( 'patternProperties' => array() ),
				'{"patternProperties":{}}',
			),
			'$defs'                => array(
				array( '$defs' => array( 'thing' => array() ) ),
				'{"$defs":{"thing":{}}}',
			),
			'definitions'          => array(
				array( 'definitions' => array() ),
				'{"definitions":{}}',
			),
			'not'                  => array(
				array( 'not' => array() ),
				'{"not":{}}',
			),
			'if/then/else'         => array(
				array(
					'if'   => array(),
					'then' => array(),
					'else' => array(),
				),
				'{"if":{},"then":{},"else":{}}',
			),
			'oneOf member'         => array(
				array( 'oneOf' => array( array(), array( 'type' => 'string' ) ) ),
				'{"oneOf":[{},{"type":"string"}]}',
			),
			'anyOf member'         => array(
				array( 'anyOf' => array( array() ) ),
				'{"anyOf":[{}]}',
			),
			'allOf member'         => array(
				array( 'allOf' => array( array() ) ),
				'{"allOf":[{}]}',
			),
			'prefixItems member'   => array(
				array(
					'type'        => 'array',
					'prefixItems' => array( array() ),
					'items'       => array( 'type' => 'number' ),
				),
				'{"type":"array","prefixItems":[{}],"items":{"type":"number"}}',
			),
		);
	}

	public function test_array_without_items_gets_string_items() {
		$prepared = agentic_editor_chat_prepare_schema( array( 'type' => 'array' ) );

		$this->assertSame(
			array(
				'type'  => 'array',
				'items' => array( 'type' => 'string' ),
			),
			$prepared
		);
	}

	public function test_empty_items_is_treated_as_missing() {
		$prepared = agentic_editor_chat_prepare_schema(
			array(
				'type'  => 'array',
				'items' => array(),
			)
		);

		$this->assertSame( array( 'type' => 'string' ), $prepared['items'] );
	}

	public function test_array_items_are_added_at_every_depth() {
		$prepared = agentic_editor_chat_prepare_schema(
			array(
				'type'       => 'object',
				'properties' => array(
					'rows' => array(
						'type'  => 'array',
						'items' => array(
							'type'       => 'object',
							'properties' => array(
								'cells' => array( 'type' => 'array' ),
							),
						),
					),
				),
				'anyOf'      => array(
					array( 'type' => 'array' ),
				),
			)
		);

		$this->assertSame(
			array( 'type' => 'string' ),
			$prepared['properties']['rows']['items']['properties']['cells']['items']
		);
		$this->assertSame( array( 'type' => 'string' ), $prepared['anyOf'][0]['items'] );
	}

	public function test_existing_items_are_kept() {
		$schema = array(
			'type'  => 'array',
			'items' => array( 'type' => 'integer' ),
		);

		$this->assertSame( $schema, agentic_editor_chat_prepare_schema( $schema ) );
	}

	public function test_nullable_type_collapses_to_the_concrete_type() {
		$prepared = agentic_editor_chat_prepare_schema( array( 'type' => array( 'null', 'integer' ) ) );

		$this->assertSame( 'integer', $prepared['type'] );
	}

	public function test_union_keeps_the_first_concrete_type() {
		$prepared = agentic_editor_chat_prepare_schema( array( 'type' => array( 'string', 'number' ) ) );

		$this->assertSame( 'string', $prepared['type'] );
	}

	public function test_null_only_union_falls_back_to_string() {
		$prepared = agentic_editor_chat_prepare_schema( array( 'type' => array( 'null' ) ) );

		$this->assertSame( 'string', $prepared['type'] );
	}

	public function test_nullable_array_union_gets_items() {
		$prepared = agentic_editor_chat_prepare_schema( array( 'type' => array( 'array', 'null' ) ) );

		$this->assertSame(
			array(
				'type'  => 'array',
				'items' => array( 'type' => 'string' ),
			),
			$prepared
		);
	}

	public function test_nested_one_of_is_prepared() {
		$prepared = agentic_editor_chat_prepare_schema(
			array(
				'oneOf' => array(
					array(
						'type'       => 'object',
						'properties' => array(
							'ids' => array(
								'oneOf' => array(
									array( 'type' => array( 'array', 'null' ) ),
									array( 'type' => 'string' ),
								),
							),
						),
					),
				),
			)
		);

		$this->assertSame(
			array(
				'type'  => 'array',
				'items' => array( 'type' => 'string' ),
			),
			$prepared['oneOf'][0]['properties']['ids']['oneOf'][0]
		);
	}

	public function test_parameters_are_omitted_for_a_tool_without_properties() {
		$this->assertNull( agentic_editor_chat_prepare_parameters( array( 'type' => 'object' ) ) );
		$this->assertNull(
			agentic_editor_chat_prepare_parameters(
				array(
					'type'       => 'object',
					'properties' => array(),
				)
			)
		);
		$this->assertNull(
			agentic_editor_chat_prepare_parameters(
				array(
					'type'       => 'object',
					'properties' => 'nope',
				)
			)
		);
	}

	public function test_parameters_are_prepared() {
		$parameters = agentic_editor_chat_prepare_parameters(
			array(
				'type'       => 'object',
				'properties' => array( 'ids' => array( 'type' => 'array' ) ),
			)
		);

		$this->assertSame( array( 'type' => 'string' ), $parameters['properties']['ids']['items'] );
	}
}
