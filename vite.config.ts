import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const src = ( path: string ) =>
	fileURLToPath( new URL( `./src/${ path }`, import.meta.url ) );

export default defineConfig( ( { mode } ) => ( {
	plugins: [ react(), tailwindcss() ],

	resolve: {
		/*
		 * WordPress puts React on the page as classic scripts, and core asks
		 * plugins not to bundle their own. Each React specifier is redirected
		 * to a shim that re-exports the corresponding global. More specific
		 * specifiers come first: an alias key also matches `key + "/"`.
		 */
		alias: {
			'react/jsx-dev-runtime': src( 'lib/shims/jsx-runtime.ts' ),
			'react/jsx-runtime': src( 'lib/shims/jsx-runtime.ts' ),
			'react-dom/client': src( 'lib/shims/react-dom.ts' ),
			'react-dom': src( 'lib/shims/react-dom.ts' ),
			react: src( 'lib/shims/react.ts' ),
			'@': src( '' ).replace( /\/$/, '' ),
		},
	},

	define: {
		'process.env.NODE_ENV': JSON.stringify(
			mode === 'production' ? 'production' : 'development'
		),
	},

	build: {
		outDir: 'build',
		emptyOutDir: true,
		target: 'es2022',
		sourcemap: true,
		// One stylesheet for every entry keeps the PHP side to a single handle.
		cssCodeSplit: false,
		rollupOptions: {
			/*
			 * These stay plain script modules resolved through the WordPress
			 * import map. Bundling a copy of the tool layer would give the chat
			 * its own empty tool registry, since the bridge registers local
			 * tools into the module instance the editor loaded, and leaving the
			 * config module out keeps the `script_module_data_` filter that
			 * feeds it working untouched.
			 */
			external: [
				'@agentic-editor/webmcp-tools',
				'@agentic-editor/chat-config',
			],
			input: {
				'chat-editor-sidebar': src( 'entries/editor-sidebar.tsx' ),
			},
			output: {
				format: 'es',
				entryFileNames: '[name].js',
				chunkFileNames: 'chunk-[name]-[hash].js',
				assetFileNames: ( info ) =>
					info.names?.some( ( name ) => name.endsWith( '.css' ) )
						? 'chat.css'
						: '[name]-[hash][extname]',
			},
		},
	},
} ) );
