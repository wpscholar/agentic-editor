import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = ( path: string ) =>
	fileURLToPath( new URL( `./src/${ path }`, import.meta.url ) );

/*
 * Unit tests run in Node, without WordPress. Import-map IDs the code under test
 * reaches for are pointed at stubs that tests replace with `vi.mock`, except
 * the polyfill reporter, which is small enough to run for real. Nothing tested
 * here touches React, so the build's React shims and plugins stay out.
 */
export default defineConfig( {
	resolve: {
		alias: {
			'@agentic-editor/chat-config': src( 'test/stubs/chat-config.ts' ),
			'@agentic-editor/webmcp-tools': src( 'test/stubs/webmcp-tools.ts' ),
			'@agentic-editor/webmcp-polyfill': fileURLToPath(
				new URL( './js/webmcp-polyfill.js', import.meta.url )
			),
			'@agentic-editor/abilities/shared': fileURLToPath(
				new URL( './js/abilities/shared.js', import.meta.url )
			),
			'@wordpress/abilities': src( 'test/stubs/abilities.ts' ),
			'@': src( '' ).replace( /\/$/, '' ),
		},
	},
	test: {
		include: [ 'src/**/*.test.ts', 'js/**/*.test.js' ],
		environment: 'node',
	},
} );
