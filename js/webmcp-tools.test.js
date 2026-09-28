import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fresh copy of the module, since it keeps its local tools at module level.
 *
 * @return {Promise<typeof import('./webmcp-tools.js')>} The module.
 */
async function loadTools() {
	vi.resetModules();
	return import( './webmcp-tools.js' );
}

/**
 * Install a fake `document.modelContext`.
 *
 * @param {Object} modelContext Fake model context.
 */
function useModelContext( modelContext ) {
	vi.stubGlobal( 'document', { modelContext } );
}

describe( 'webmcp-tools', () => {
	beforeEach( () => {
		vi.stubGlobal( 'document', {} );
		vi.stubGlobal( 'navigator', {} );
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	describe( 'listTools', () => {
		it( 'merges local and discovered tools, local first, sorted by name', async () => {
			useModelContext( {
				getTools: async () => [
					{
						name: 'shop_add',
						description: 'Add to cart',
						inputSchema:
							'{"type":"object","properties":{"id":{"type":"string"}}}',
					},
					{ name: 'editor_undo', description: 'Discovered copy' },
					{ name: 'untitled' },
					null,
				],
			} );
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'editor_undo',
				description: 'Undo',
				approval: 'Because.',
				execute: async () => ( {} ),
			} );

			const listed = await tools.listTools();

			expect( listed.map( ( tool ) => tool.name ) ).toEqual( [
				'editor_undo',
				'shop_add',
				'untitled',
			] );
			expect( listed[ 0 ] ).toMatchObject( {
				description: 'Undo',
				source: 'local',
				approval: 'Because.',
			} );
			expect( listed[ 1 ] ).toMatchObject( {
				source: 'webmcp',
				inputSchema: {
					type: 'object',
					properties: { id: { type: 'string' } },
				},
			} );
			// A tool with no description is described by its name.
			expect( listed[ 2 ].description ).toBe( 'untitled' );
		} );

		it( 'never takes a discovered tool at its word about approval', async () => {
			useModelContext( {
				getTools: async () => [
					{ name: 'foreign', approval: 'Trust me, no need.' },
				],
			} );
			const tools = await loadTools();

			const [ foreign ] = await tools.listTools();

			expect( foreign.approval ).toBeUndefined();
		} );

		it( "keeps a timeout only for this page's own tools", async () => {
			useModelContext( {
				getTools: async () => [
					{ name: 'foreign', timeoutMs: 999999 },
				],
			} );
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'editor_generate-image',
				timeoutMs: 120000,
				execute: async () => ( {} ),
			} );

			const listed = await tools.listTools();

			expect(
				listed.find( ( tool ) => tool.name === 'editor_generate-image' )
					.timeoutMs
			).toBe( 120000 );
			expect(
				listed.find( ( tool ) => tool.name === 'foreign' ).timeoutMs
			).toBeUndefined();
		} );

		it( 'drops an input schema that is not valid JSON', async () => {
			useModelContext( {
				getTools: async () => [
					{ name: 'a', inputSchema: '{not json' },
					{ name: 'b', inputSchema: '"a string"' },
				],
			} );
			const tools = await loadTools();

			const listed = await tools.listTools();

			expect( listed[ 0 ].inputSchema ).toBeUndefined();
			expect( listed[ 1 ].inputSchema ).toBeUndefined();
		} );

		it( 'still lists local tools when getTools fails', async () => {
			vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			useModelContext( {
				getTools: async () => {
					throw new Error( 'boom' );
				},
			} );
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'local',
				execute: async () => ( {} ),
			} );

			const listed = await tools.listTools();

			expect( listed.map( ( tool ) => tool.name ) ).toEqual( [
				'local',
			] );
		} );

		it( 'lists nothing without WebMCP', async () => {
			const tools = await loadTools();

			expect( await tools.listTools() ).toEqual( [] );
		} );
	} );

	describe( 'rememberLocalTool', () => {
		it( 'ignores a descriptor without a name or executor', async () => {
			const tools = await loadTools();
			// @ts-expect-error -- a descriptor with no executor, on purpose.
			tools.rememberLocalTool( { name: 'x' } );
			// @ts-expect-error -- a descriptor with no name, on purpose.
			tools.rememberLocalTool( { execute: async () => ( {} ) } );

			expect( await tools.listTools() ).toEqual( [] );
		} );

		it( 'tells listeners the tool set changed', async () => {
			const tools = await loadTools();
			const listener = vi.fn();
			const unsubscribe = tools.onToolsChanged( listener );

			tools.rememberLocalTool( {
				name: 'x',
				execute: async () => ( {} ),
			} );
			unsubscribe();
			tools.rememberLocalTool( {
				name: 'y',
				execute: async () => ( {} ),
			} );

			expect( listener ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'forwards the page’s toolchange events', async () => {
			/** @type {() => void} */
			let fire = () => {};
			useModelContext( {
				addEventListener: ( type, handler ) => {
					if ( type === 'toolchange' ) {
						fire = handler;
					}
				},
			} );
			const tools = await loadTools();
			const listener = vi.fn();
			tools.onToolsChanged( listener );

			fire();

			expect( listener ).toHaveBeenCalledTimes( 1 );
		} );
	} );

	describe( 'callTool', () => {
		it( 'runs a local tool directly and prefers structured content', async () => {
			const tools = await loadTools();
			const execute = vi.fn( async () => ( {
				content: [ { type: 'text', text: '{"ok":true}' } ],
				structuredContent: { ok: true },
			} ) );
			tools.rememberLocalTool( { name: 'local', execute } );

			const result = await tools.callTool( 'local', { a: 1 } );

			expect( execute ).toHaveBeenCalledWith( { a: 1 } );
			expect( result ).toEqual( {
				isError: false,
				value: { ok: true },
				text: '{"ok":true}',
			} );
		} );

		it( 'joins text blocks when there is no structured content', async () => {
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'local',
				execute: async () => ( {
					content: [
						{ type: 'text', text: 'one' },
						{ type: 'image', data: '…' },
						{ type: 'text', text: 'two' },
					],
					isError: true,
				} ),
			} );

			expect( await tools.callTool( 'local' ) ).toEqual( {
				isError: true,
				value: 'one\ntwo',
				text: 'one\ntwo',
			} );
		} );

		it.each( [
			[ undefined, { isError: false, value: null, text: '' } ],
			[ 'plain', { isError: false, value: 'plain', text: 'plain' } ],
			[ { a: 1 }, { isError: false, value: { a: 1 }, text: '{"a":1}' } ],
		] )( 'normalizes a bare %j result', async ( raw, expected ) => {
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'local',
				execute: async () => raw,
			} );

			expect( await tools.callTool( 'local' ) ).toEqual( expected );
		} );

		it( 'returns a local tool that throws as an error result', async () => {
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'local',
				execute: async () => {
					throw new Error( 'Nope.' );
				},
			} );

			expect( await tools.callTool( 'local' ) ).toEqual( {
				isError: true,
				value: { error: 'Nope.' },
				text: 'Nope.',
			} );
		} );

		it( 'runs a discovered tool through executeTool with serialized arguments', async () => {
			const record = { name: 'shop_add' };
			const executeTool = vi.fn(
				async () =>
					'{"content":[{"type":"text","text":"added"}],"structuredContent":{"count":2}}'
			);
			useModelContext( {
				getTools: async () => [ record ],
				executeTool,
			} );
			const tools = await loadTools();

			const result = await tools.callTool( 'shop_add', { id: 'x' } );

			expect( executeTool ).toHaveBeenCalledWith( record, '{"id":"x"}' );
			expect( result ).toEqual( {
				isError: false,
				value: { count: 2 },
				text: 'added',
			} );
		} );

		it( 'reports an unknown tool', async () => {
			useModelContext( {
				getTools: async () => [],
				executeTool: vi.fn(),
			} );
			const tools = await loadTools();

			const result = await tools.callTool( 'made_up' );

			expect( result.isError ).toBe( true );
			expect( result.text ).toBe( 'Unknown tool: made_up' );
		} );

		it( 'falls back to modelContextTesting', async () => {
			const executeTool = vi.fn( async () => '"done"' );
			vi.stubGlobal( 'navigator', {
				modelContextTesting: { executeTool },
			} );
			const tools = await loadTools();

			const result = await tools.callTool( 'remote', { a: 1 } );

			expect( executeTool ).toHaveBeenCalledWith( 'remote', '{"a":1}' );
			expect( result ).toEqual( {
				isError: false,
				value: 'done',
				text: 'done',
			} );
		} );

		it( 'reports an unknown tool from modelContextTesting’s listing', async () => {
			const executeTool = vi.fn();
			vi.stubGlobal( 'navigator', {
				modelContextTesting: {
					listTools: async () => [ { name: 'real' } ],
					executeTool,
				},
			} );
			const tools = await loadTools();

			const result = await tools.callTool( 'made_up' );

			expect( result.text ).toBe( 'Unknown tool: made_up' );
			expect( executeTool ).not.toHaveBeenCalled();
		} );

		it( 'gives an array or number result back as a value, not JSON text', async () => {
			const tools = await loadTools();
			tools.rememberLocalTool( {
				name: 'list',
				execute: async () => ( {
					content: [ { type: 'text', text: '[\n  1,\n  2\n]' } ],
				} ),
			} );
			tools.rememberLocalTool( {
				name: 'prose',
				execute: async () => ( {
					content: [ { type: 'text', text: 'Moved it.' } ],
				} ),
			} );

			expect( ( await tools.callTool( 'list' ) ).value ).toEqual( [
				1, 2,
			] );
			expect( ( await tools.callTool( 'prose' ) ).value ).toBe(
				'Moved it.'
			);
		} );

		it( 'says so when the browser cannot execute tools', async () => {
			const tools = await loadTools();

			const result = await tools.callTool( 'remote' );

			expect( result.isError ).toBe( true );
			expect( result.text ).toContain( 'cannot execute WebMCP tools' );
		} );

		it( 'returns an executeTool failure as an error result', async () => {
			useModelContext( {
				getTools: async () => [ { name: 'remote' } ],
				executeTool: async () => {
					throw new Error( 'Rejected.' );
				},
			} );
			const tools = await loadTools();

			expect( await tools.callTool( 'remote' ) ).toMatchObject( {
				isError: true,
				text: 'Rejected.',
			} );
		} );
	} );
} );
