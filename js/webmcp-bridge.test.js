import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAbility, getAbility } from '@wordpress/abilities';
import { rememberLocalTool } from '@agentic-editor/webmcp-tools';
import { bridgeAbilitiesToWebMCP, toToolName } from './webmcp-bridge.js';

vi.mock( '@wordpress/abilities', () => ( {
	getAbility: vi.fn(),
	executeAbility: vi.fn(),
} ) );

vi.mock( '@agentic-editor/webmcp-tools', () => ( {
	rememberLocalTool: vi.fn(),
} ) );

const mockedGetAbility = /** @type {import('vitest').Mock} */ (
	/** @type {unknown} */ ( getAbility )
);
const mockedExecuteAbility = /** @type {import('vitest').Mock} */ (
	/** @type {unknown} */ ( executeAbility )
);
const mockedRemember = /** @type {import('vitest').Mock} */ (
	/** @type {unknown} */ ( rememberLocalTool )
);

/** @type {Record<string, Object>} */
let abilities = {};

/** @type {Array<Object>} */
let registered = [];

/**
 * A model context that records every registerTool call.
 *
 * @param {(tool: Object) => void} [check] Throws to reject a registration.
 * @return {Object} Fake model context.
 */
function modelContext( check = () => {} ) {
	return {
		registerTool: vi.fn( async ( tool ) => {
			check( tool );
			registered.push( tool );
		} ),
	};
}

/**
 * Bridge one ability and return the tool descriptor it registered.
 *
 * @param {Object} ability Ability definition.
 * @return {Promise<Object>} Registered descriptor.
 */
async function bridgeOne( ability ) {
	abilities = { [ ability.name ]: ability };
	vi.stubGlobal( 'document', { modelContext: modelContext() } );
	await bridgeAbilitiesToWebMCP( [ ability.name ] );
	return registered[ 0 ];
}

describe( 'webmcp-bridge', () => {
	beforeEach( () => {
		abilities = {};
		registered = [];
		vi.clearAllMocks();
		mockedGetAbility.mockImplementation( ( name ) => abilities[ name ] );
		vi.stubGlobal( 'window', globalThis );
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	it( 'turns ability names into WebMCP tool names', () => {
		expect( toToolName( 'editor/get-editor-tree' ) ).toBe(
			'editor_get-editor-tree'
		);
		expect( toToolName( 'a/b/c' ) ).toBe( 'a_b_c' );
	} );

	it( 'registers a descriptor with no AbortSignal', async () => {
		const tool = await bridgeOne( {
			name: 'editor/get-editor-tree',
			label: 'Get tree',
			description: 'Read the block tree.',
			input_schema: {
				type: 'object',
				properties: { depth: { type: [ 'integer', 'null' ] } },
			},
		} );

		expect( tool.name ).toBe( 'editor_get-editor-tree' );
		expect( tool.description ).toBe( 'Read the block tree.' );
		expect( tool.signal ).toBeUndefined();
		// Union types collapse to their concrete type for function calling.
		expect( tool.inputSchema.properties.depth.type ).toBe( 'integer' );
	} );

	it( 'falls back to the label, then the name, for a description', async () => {
		expect(
			( await bridgeOne( { name: 'x/labelled', label: 'Label' } ) )
				.description
		).toBe( 'Label' );

		registered = [];
		expect( ( await bridgeOne( { name: 'x/bare' } ) ).description ).toBe(
			'x/bare'
		);
	} );

	it.each( [
		[ 'missing', undefined ],
		[ 'not an object', { type: 'string' } ],
	] )(
		'gives an input schema that is %s an empty object schema',
		async ( _label, inputSchema ) => {
			const tool = await bridgeOne( {
				name: 'x/y',
				input_schema: inputSchema,
			} );

			expect( tool.inputSchema ).toEqual( {
				type: 'object',
				properties: {},
			} );
		}
	);

	it( 'normalizes nested properties and items', async () => {
		const tool = await bridgeOne( {
			name: 'x/y',
			input_schema: {
				type: 'object',
				properties: {
					rows: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								note: { type: [ 'null', 'string' ] },
							},
						},
					},
				},
			},
		} );

		expect(
			tool.inputSchema.properties.rows.items.properties.note.type
		).toBe( 'string' );
	} );

	it( 'keeps nullable unions in the output schema', async () => {
		const tool = await bridgeOne( {
			name: 'x/y',
			output_schema: {
				type: 'object',
				properties: { clientId: { type: [ 'string', 'null' ] } },
			},
		} );

		expect( tool.outputSchema.properties.clientId.type ).toEqual( [
			'string',
			'null',
		] );
	} );

	it( 'omits an output schema that is not an object', async () => {
		const tool = await bridgeOne( {
			name: 'x/y',
			output_schema: { type: 'array' },
		} );

		expect( tool.outputSchema ).toBeUndefined();
	} );

	it( 'maps only WebMCP annotation keys', async () => {
		const tool = await bridgeOne( {
			name: 'x/y',
			meta: {
				annotations: {
					readonly: true,
					destructive: false,
					idempotent: true,
				},
				agenticEditor: { untrustedContent: true },
			},
		} );

		expect( tool.annotations ).toEqual( {
			readOnlyHint: true,
			untrustedContentHint: true,
		} );
	} );

	it( 'sends no annotations for an ability without them', async () => {
		const tool = await bridgeOne( { name: 'x/y' } );

		expect( tool.annotations ).toBeUndefined();
	} );

	it( 'keeps the approval reason out of WebMCP but hands it to local consumers', async () => {
		const tool = await bridgeOne( {
			name: 'x/y',
			meta: { agenticEditor: { approval: 'Saves a post.' } },
		} );

		expect( tool.approval ).toBeUndefined();
		expect( mockedRemember ).toHaveBeenCalledWith(
			expect.objectContaining( {
				name: 'x_y',
				approval: 'Saves a post.',
			} )
		);
	} );

	it( 'hands a tool timeout to local consumers only when it is a positive number', async () => {
		const tool = await bridgeOne( {
			name: 'x/y',
			meta: { agenticEditor: { timeoutMs: 120000 } },
		} );

		expect( tool.timeoutMs ).toBeUndefined();
		expect( mockedRemember ).toHaveBeenCalledWith(
			expect.objectContaining( { name: 'x_y', timeoutMs: 120000 } )
		);

		mockedRemember.mockClear();
		await bridgeOne( {
			name: 'x/z',
			meta: { agenticEditor: { timeoutMs: -1 } },
		} );
		expect( mockedRemember.mock.calls[ 0 ][ 0 ] ).not.toHaveProperty(
			'timeoutMs'
		);
	} );

	describe( 'execute', () => {
		it( 'returns an object result as text and structured content', async () => {
			mockedExecuteAbility.mockResolvedValue( { count: 2 } );
			const tool = await bridgeOne( { name: 'x/y' } );

			const result = await tool.execute( { a: 1 } );

			expect( mockedExecuteAbility ).toHaveBeenCalledWith( 'x/y', {
				a: 1,
			} );
			expect( result.structuredContent ).toEqual( { count: 2 } );
			expect( JSON.parse( result.content[ 0 ].text ) ).toEqual( {
				count: 2,
			} );
		} );

		it.each( [
			[ 'an array', [ 1, 2 ] ],
			[ 'a number', 3 ],
			[ 'null', null ],
		] )( 'returns %s as text only', async ( _label, value ) => {
			mockedExecuteAbility.mockResolvedValue( value );
			const tool = await bridgeOne( { name: 'x/y' } );

			const result = await tool.execute();

			expect( result.structuredContent ).toBeUndefined();
			expect( JSON.parse( result.content[ 0 ].text ) ).toEqual( value );
		} );

		it( 'returns a string result as is', async () => {
			mockedExecuteAbility.mockResolvedValue( 'Done.' );
			const tool = await bridgeOne( { name: 'x/y' } );

			expect( await tool.execute() ).toEqual( {
				content: [ { type: 'text', text: 'Done.' } ],
			} );
		} );

		it( 'returns an empty text block for undefined', async () => {
			mockedExecuteAbility.mockResolvedValue( undefined );
			const tool = await bridgeOne( { name: 'x/y' } );

			expect( await tool.execute() ).toEqual( {
				content: [ { type: 'text', text: '' } ],
			} );
		} );

		it( 'turns a failure into an error result the model can read', async () => {
			vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			mockedExecuteAbility.mockRejectedValue(
				new Error( 'Block not found.' )
			);
			const tool = await bridgeOne( { name: 'x/y' } );

			expect( await tool.execute( {} ) ).toEqual( {
				content: [ { type: 'text', text: 'Block not found.' } ],
				isError: true,
			} );
		} );
	} );

	describe( 'bridgeAbilitiesToWebMCP', () => {
		it( 'reports each ability as registered, already registered, or failed', async () => {
			vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			abilities = {
				'x/new': { name: 'x/new' },
				'x/again': { name: 'x/again' },
				'x/broken': { name: 'x/broken' },
			};
			vi.stubGlobal( 'document', {
				modelContext: modelContext( ( tool ) => {
					if ( tool.name === 'x_again' ) {
						const error = new Error( 'Tool exists' );
						error.name = 'InvalidStateError';
						throw error;
					}
					if ( tool.name === 'x_broken' ) {
						throw new TypeError( 'Bad descriptor' );
					}
				} ),
			} );

			const result = await bridgeAbilitiesToWebMCP( [
				'x/new',
				'x/again',
				'x/broken',
				'x/missing',
			] );

			expect( result.supported ).toBe( true );
			expect( result.registered ).toEqual( [ 'x/new', 'x/again' ] );
			expect( result.skipped ).toEqual( [ 'x/broken', 'x/missing' ] );
			expect( result.errors ).toEqual( [
				{ name: 'x/broken', message: 'Bad descriptor' },
				{ name: 'x/missing', message: 'Ability not found: x/missing' },
			] );
		} );

		it( 'still hands an already registered tool to local consumers', async () => {
			abilities = { 'x/again': { name: 'x/again' } };
			vi.stubGlobal( 'document', {
				modelContext: modelContext( () => {
					throw new Error( 'Tool "x_again" is already registered.' );
				} ),
			} );

			const result = await bridgeAbilitiesToWebMCP( [ 'x/again' ] );

			expect( result.registered ).toEqual( [ 'x/again' ] );
			expect( mockedRemember ).toHaveBeenCalledWith(
				expect.objectContaining( { name: 'x_again' } )
			);
		} );

		it( 'does not mistake another failure mentioning “already” for success', async () => {
			vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			abilities = { 'x/y': { name: 'x/y' } };
			vi.stubGlobal( 'document', {
				modelContext: modelContext( () => {
					throw new TypeError(
						'Schema already uses an unsupported keyword.'
					);
				} ),
			} );

			const result = await bridgeAbilitiesToWebMCP( [ 'x/y' ] );

			expect( result.registered ).toEqual( [] );
			expect( result.errors ).toEqual( [
				{
					name: 'x/y',
					message: 'Schema already uses an unsupported keyword.',
				},
			] );
			expect( mockedRemember ).not.toHaveBeenCalled();
		} );

		it( 'retries without hints when a registration rejects them', async () => {
			abilities = {
				'x/y': {
					name: 'x/y',
					meta: { annotations: { readonly: true } },
				},
			};
			vi.stubGlobal( 'document', {
				modelContext: modelContext( ( tool ) => {
					if ( tool.annotations ) {
						throw new TypeError( 'Unknown key: annotations' );
					}
				} ),
			} );

			const result = await bridgeAbilitiesToWebMCP( [ 'x/y' ] );

			expect( result.registered ).toEqual( [ 'x/y' ] );
			expect( registered ).toHaveLength( 1 );
			expect( registered[ 0 ].annotations ).toBeUndefined();
		} );

		it( 'skips everything without WebMCP', async () => {
			vi.stubGlobal( 'document', { readyState: 'complete' } );
			vi.stubGlobal( 'navigator', {} );

			const result = await bridgeAbilitiesToWebMCP( [ 'x/y' ] );

			expect( result ).toEqual( {
				supported: false,
				registered: [],
				skipped: [ 'x/y' ],
				errors: [],
			} );
		} );
	} );
} );
