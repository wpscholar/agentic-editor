import { chromium, type FullConfig, type Page } from '@playwright/test';
import { openEditor } from './open-editor';

export const STORAGE_STATE = 'playwright/.auth/admin.json';

/**
 * Log in once and share the session with every test.
 *
 * Without this, each test's fresh context goes through Playground's
 * auto-login. WordPress keeps a user's sessions in one `session_tokens` meta
 * value, rewritten on every login, so concurrent logins from parallel workers
 * overwrite each other's token and the loser lands on wp-login.php?reauth=1.
 */
export default async function globalSetup( config: FullConfig ) {
	const { baseURL } = config.projects[ 0 ].use;
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext( { baseURL } );
		const page = await context.newPage();
		await openEditor( page, 60_000 );
		await disableWelcomeGuides( page );
		await context.storageState( { path: STORAGE_STATE } );
	} finally {
		await browser.close();
	}
}

/**
 * Turn off the editors' welcome guides for the admin, for good.
 *
 * A brand-new site opens the guide as a modal over the first editor load,
 * which would swallow a test's first keypress. Preferences are saved to user
 * meta in the background, so this waits until the server has them rather
 * than trusting the local copy.
 */
async function disableWelcomeGuides( page: Page ) {
	await page.evaluate( async () => {
		const wp = ( window as any ).wp;
		const preferences = wp.data.dispatch( 'core/preferences' );
		for ( const scope of [ 'core/edit-post', 'core/edit-site' ] ) {
			preferences.set( scope, 'welcomeGuide', false );
		}
	} );

	await page.waitForFunction(
		async () => {
			const user = await ( window as any ).wp.apiFetch( {
				path: '/wp/v2/users/me?context=edit',
			} );
			const saved = user?.meta?.persisted_preferences ?? {};
			return (
				saved[ 'core/edit-post' ]?.welcomeGuide === false &&
				saved[ 'core/edit-site' ]?.welcomeGuide === false
			);
		},
		null,
		{ timeout: 30_000, polling: 500 }
	);
}
