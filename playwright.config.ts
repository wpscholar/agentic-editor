import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './tests/e2e/global-setup';

/*
 * WP_VERSION, PHP_VERSION and WP_PORT pick the site the suite runs against,
 * which is how CI covers its version matrix. Unset, the suite uses the same
 * site as `npm start`: the latest WordPress on port 9400.
 */
const WP_VERSION = process.env.WP_VERSION || 'latest';
const PHP_VERSION = process.env.PHP_VERSION || '8.3';
const PORT = Number( process.env.WP_PORT || 9400 );
const IS_DEFAULT_SITE =
	! process.env.WP_VERSION &&
	! process.env.PHP_VERSION &&
	! process.env.WP_PORT;

/**
 * Runs against a real WordPress editor served by wp-playground-cli (`npm start`),
 * the same instance used for manual local development — no Docker, no `@wordpress/env`.
 */
export default defineConfig( {
	testDir: './tests/e2e',
	globalSetup: './tests/e2e/global-setup.ts',
	fullyParallel: true,
	// Every worker shares the one wp-playground-cli backend below, so extra
	// workers stop paying off quickly: 4 workers halve the serial run time,
	// while 8 were only ~10% faster than 4.
	workers: 4,
	forbidOnly: !! process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// GitHub's runners are 4–5 times slower than a laptop here: the median
	// test takes ~14s there, so the default 30s leaves no headroom.
	timeout: process.env.CI ? 60_000 : 30_000,
	// CI annotates failures on the pull request and keeps an HTML report as
	// an artifact; locally, the list is enough.
	reporter: process.env.CI
		? [ [ 'github' ], [ 'list' ], [ 'html', { open: 'never' } ] ]
		: 'list',
	use: {
		baseURL: `http://127.0.0.1:${ PORT }`,
		storageState: STORAGE_STATE,
		trace: 'on-first-retry',
	},
	projects: [ { name: 'chromium', use: { ...devices[ 'Desktop Chrome' ] } } ],
	webServer: {
		command: IS_DEFAULT_SITE
			? 'npm start'
			: `npx wp-playground-cli start --skip-browser --port=${ PORT } --wp=${ WP_VERSION } --php=${ PHP_VERSION }`,
		// A static file, not /wp-admin/: WP Playground's auto-login flow answers
		// every authenticated URL with a self-redirecting 302 that sets a fresh
		// cookie each time. Playwright's readiness prober follows redirects but
		// doesn't persist cookies between hops, so it loops on that 302 forever.
		url: `http://127.0.0.1:${ PORT }/readme.html`,
		reuseExistingServer: ! process.env.CI,
		timeout: 120_000,
	},
} );
