import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { openEditor } from './open-editor';

const EXPECTED_TOOLS = [
	'editor_get-editor-tree',
	'editor_find-editor-blocks',
	'editor_get-block-location',
	'editor_insert-block',
	'editor_move-block',
	'editor_update-block',
	'editor_remove-block',
	'editor_get-editor-selection',
	'editor_can-insert-block',
	'editor_get-block-types',
	'editor_get-block-type',
	'editor_transform-block',
	'editor_select-block',
	'editor_undo',
	'editor_redo',
	'editor_get-patterns',
	'editor_get-pattern',
	'editor_get-pattern-categories',
	'editor_insert-pattern',
	'editor_create-pattern',
	'editor_search-media',
];

/**
 * `editor_generate-image` is registered only when the site's connector can
 * generate images, which a site started with `npm run start:ai` can.
 */
const IMAGE_TOOL = 'editor_generate-image';

/**
 * Every tool this site should list, sorted.
 */
async function expectedToolNames( editor: Page ): Promise< string[] > {
	const imageGeneration = await editor.evaluate( () => {
		const element = document.getElementById(
			'wp-script-module-data-@agentic-editor/abilities/media'
		);
		return (
			JSON.parse( element?.textContent || '{}' ).imageGeneration === true
		);
	} );

	return [
		...EXPECTED_TOOLS,
		...( imageGeneration ? [ IMAGE_TOOL ] : [] ),
	].sort();
}

/**
 * Names of the tools WebMCP lists on the page, sorted.
 */
async function listedToolNames( editor: Page ): Promise< string[] > {
	return editor.evaluate( async () => {
		const tools = await ( document as any ).modelContext.getTools();
		return tools.map( ( tool: { name: string } ) => tool.name ).sort();
	} );
}

test( 'registers exactly the editor abilities as WebMCP tools', async ( {
	editor,
} ) => {
	const status = await editor.evaluate(
		() => ( window as any ).agenticEditorAbilities
	);

	expect( status.isWebMCPSupported ).toBe( true );
	expect( status.webmcp.supported ).toBe( true );
	expect( status.webmcp.errors ).toEqual( [] );
	expect( status.webmcp.skipped ).toEqual( [] );
	const expected = await expectedToolNames( editor );
	expect( status.webmcp.registered ).toHaveLength( expected.length );
	expect( status.webmcp.registered ).toEqual( status.abilityNames );

	expect( await listedToolNames( editor ) ).toEqual( expected );
} );

test( 'tools stay registered after load', async ( { editor } ) => {
	// Tools registered with an AbortSignal that later fires vanish a moment
	// after they appear, which is the regression this guards against.
	await editor.waitForTimeout( 2_000 );

	expect( await listedToolNames( editor ) ).toEqual(
		await expectedToolNames( editor )
	);
} );

test( 'bootstrapping again changes nothing', async ( { editor } ) => {
	const rerun = await editor.evaluate( async () => {
		// Variables keep TypeScript from resolving the import-map IDs.
		const abilitiesId = '@agentic-editor/abilities';
		const bridgeId = '@agentic-editor/webmcp-bridge';
		const { registerEditorAbilities } = await import( abilitiesId );
		const { bridgeAbilitiesToWebMCP } = await import( bridgeId );

		const abilityNames = registerEditorAbilities();
		return {
			abilityNames,
			result: await bridgeAbilitiesToWebMCP( abilityNames ),
		};
	} );

	expect( rerun.abilityNames ).toHaveLength(
		( await expectedToolNames( editor ) ).length
	);
	expect( rerun.result.errors ).toEqual( [] );
	expect( rerun.result.registered ).toEqual( rerun.abilityNames );
	expect( await listedToolNames( editor ) ).toEqual(
		await expectedToolNames( editor )
	);
} );

test( 'an unknown tool is reported, not thrown', async ( { callTool } ) => {
	const result = await callTool( 'editor_does-not-exist' );

	expect( result.isError ).toBe( true );
	expect( result.text ).toContain( 'Unknown tool' );
} );

test( 'discovers and runs a tool registered by another script', async ( {
	editor,
} ) => {
	const result = await editor.evaluate( async () => {
		const context = ( document as any ).modelContext;
		await context.registerTool( {
			name: 'external_echo',
			description: 'Echo an argument',
			inputSchema: { type: 'object' },
			execute: ( input: { message: string } ) => ( {
				content: [ { type: 'text', text: input.message } ],
			} ),
		} );
		const toolsId = '@agentic-editor/webmcp-tools';
		const { listTools, callTool } = await import( toolsId );
		return {
			listed: ( await listTools() ).some(
				( tool: { name: string } ) => tool.name === 'external_echo'
			),
			result: await callTool( 'external_echo', { message: 'hello' } ),
		};
	} );

	expect( result.listed ).toBe( true );
	expect( result.result ).toMatchObject( { isError: false, text: 'hello' } );
} );

test( 'uses a partial native context and keeps local tools callable', async ( {
	page,
}, testInfo ) => {
	await page.addInitScript( () => {
		const context = { registerTool: async () => {} };
		Object.defineProperty( document, 'modelContext', { value: context } );
	} );
	await openEditor( page, testInfo.timeout / 2 );
	const result = await page.evaluate( async () => {
		const id = '@agentic-editor/webmcp-tools';
		const { listTools, callTool } = await import( id );
		return {
			status: ( window as any ).agenticEditorAbilities.webmcp,
			tools: await listTools(),
			result: await callTool( 'editor_get-editor-tree' ),
			context: Object.keys( ( document as any ).modelContext ),
		};
	} );
	expect( result.context ).toEqual( [ 'registerTool' ] );
	expect( result.status.errors ).toEqual( [] );
	expect( result.tools.length ).toBeGreaterThan( 0 );
	expect( result.result.isError ).toBe( false );
} );
