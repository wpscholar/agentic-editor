import wordpress from '@wordpress/eslint-plugin';
import globals from 'globals';

export default [
	{
		ignores: [
			'build/**',
			'dist/**',
			'node_modules/**',
			// Composer's PHP tooling.
			'vendor/**',
			'playwright-report/**',
			'test-results/**',
			// Vendored by bin/vendor-webmcp-polyfill.sh.
			'js/vendor/**',
			// shadcn output, regenerated with its CLI rather than edited.
			'src/components/ui/**',
		],
	},

	...wordpress.configs.recommended,

	{
		files: [ 'js/**/*.js', 'src/**/*.{ts,tsx}' ],
		languageOptions: {
			globals: globals.browser,
		},
		rules: {
			// The plugin reports what it registered, and why a registration
			// or tool failed, in the console on purpose; see AGENTS.md.
			'no-console': [ 'error', { allow: [ 'info', 'warn', 'error' ] } ],
		},
	},

	{
		rules: {
			// `@return {Type}` is enough when the summary already says what
			// comes back, which is the convention throughout this codebase.
			'jsdoc/require-returns-description': 'off',
		},
	},

	{
		files: [ '**/*.{ts,tsx}' ],
		rules: {
			// Types live in the signature. A doc block describes the
			// parameters worth describing rather than listing every one.
			'jsdoc/require-param': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
		},
	},

	{
		// The chat resolves these through the WordPress import map at runtime,
		// and the unit tests alias them to stubs, so nothing on disk matches.
		settings: {
			'import/core-modules': [
				'@agentic-editor/chat-config',
				'@agentic-editor/webmcp-tools',
				'@agentic-editor/webmcp-polyfill',
				'@agentic-editor/webmcp-bridge',
				'@agentic-editor/abilities',
				'@agentic-editor/abilities/shared',
				'@agentic-editor/abilities/block-editor',
				'@agentic-editor/abilities/patterns',
				'@agentic-editor/abilities/media',
				'@wordpress/abilities',
			],
		},
	},

	...wordpress.configs[ 'test-playwright' ].map( ( config ) => ( {
		...config,
		files: [ 'tests/e2e/**/*.ts' ],
	} ) ),

	{
		files: [ 'tests/e2e/**/*.ts' ],
		rules: {
			// Playwright fixtures call `use()`, which is not React's hook.
			'react-hooks/rules-of-hooks': 'off',
			// page.evaluate() callbacks take their arguments under the same
			// names as the values passed in, since they run in another realm.
			'@typescript-eslint/no-shadow': 'off',
		},
	},

	{
		files: [ '*.config.{ts,mjs,js}', 'tests/e2e/global-setup.ts' ],
		languageOptions: {
			globals: globals.node,
		},
	},
];
