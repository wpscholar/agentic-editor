import { test as base, expect, type Page } from '@playwright/test';
import { openEditor } from './open-editor';

/**
 * What js/webmcp-tools.js#callTool returns: the shape the chat panel sees.
 */
export type ToolResult = {
	isError: boolean;
	value: any;
	text: string;
};

/**
 * Records a test creates outside the post, deleted when the test ends.
 */
export type Cleanup = {
	/** A `wp_block` post, by ID. */
	pattern: ( id: number ) => void;
	/** A `wp_pattern_category` term, by slug. */
	category: ( slug: string ) => void;
	/** An attachment, by ID. */
	media: ( id: number ) => void;
};

type Fixtures = {
	editor: Page;
	cleanup: Cleanup;
	callTool: (
		name: string,
		args?: Record< string, unknown >
	) => Promise< ToolResult >;
};

export const test = base.extend< Fixtures >( {
	editor: async ( { page }, use, testInfo ) => {
		// Half the test's budget, so a slow load fails here with a clear
		// error and still leaves the test time to run. It scales with the
		// longer CI timeout, where the editor can take over 15s to load.
		await openEditor( page, testInfo.timeout / 2 );
		await use( page );
	},

	callTool: async ( { editor }, use ) => {
		const callTool = async (
			name: string,
			args: Record< string, unknown > = {}
		): Promise< ToolResult > =>
			editor.evaluate(
				async ( { name, args } ) => {
					// The chat's own consumer module, resolved through the
					// page's import map, so tests call tools exactly the way
					// the chat does. A variable keeps the bundler and
					// TypeScript from resolving the bare specifier here.
					const specifier = '@agentic-editor/webmcp-tools';
					const tools = await import( specifier );
					return tools.callTool( name, args );
				},
				{ name, args }
			);

		await use( callTool );
	},

	// The dev site is shared with manual testing, so nothing a test publishes
	// is left on it, whether the test passed or not.
	cleanup: async ( { editor }, use ) => {
		const patternIds = new Set< number >();
		const categorySlugs = new Set< string >();
		const mediaIds = new Set< number >();

		await use( {
			pattern: ( id ) => patternIds.add( id ),
			category: ( slug ) => categorySlugs.add( slug ),
			media: ( id ) => mediaIds.add( id ),
		} );

		await editor.evaluate(
			async ( { ids, slugs, media } ) => {
				const apiFetch = ( window as any ).wp.apiFetch;
				for ( const id of media ) {
					await apiFetch( {
						path: `/wp/v2/media/${ id }?force=true`,
						method: 'DELETE',
					} ).catch( () => {} );
				}
				for ( const id of ids ) {
					await apiFetch( {
						path: `/wp/v2/blocks/${ id }?force=true`,
						method: 'DELETE',
					} ).catch( () => {} );
				}
				for ( const slug of slugs ) {
					const terms = await apiFetch( {
						path: `/wp/v2/wp_pattern_category?slug=${ encodeURIComponent(
							slug
						) }`,
					} ).catch( () => [] );
					for ( const term of terms ) {
						await apiFetch( {
							path: `/wp/v2/wp_pattern_category/${ term.id }?force=true`,
							method: 'DELETE',
						} ).catch( () => {} );
					}
				}
			},
			{
				ids: [ ...patternIds ],
				slugs: [ ...categorySlugs ],
				media: [ ...mediaIds ],
			}
		);
	},
} );

export { expect };
