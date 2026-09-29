import type { Page } from '@playwright/test';

/**
 * Open a fresh post in the block editor and wait until abilities can be
 * exercised against it.
 */
export async function openEditor( page: Page, timeout = 15_000 ) {
	// A fresh auto-draft per call keeps abilities from stepping on each other.
	await page.goto( '/wp-admin/post-new.php', { timeout } );

	// A brand-new site shows the welcome guide as a modal on first load.
	// Global setup turns it off for good; this only covers that first load.
	await page.keyboard.press( 'Escape' );

	// The abilities bridge registers tools one at a time after the editor
	// mounts, and each registerTool() resolves only after its toolchange
	// notification. Seeing one tool listed says nothing about the rest, so
	// wait for the bridge to publish its result, which it does once every
	// registration has settled.
	await page.waitForFunction(
		() => !! ( window as any ).agenticEditorAbilities?.webmcp,
		null,
		{ timeout }
	);

	// Tools register before the editor finishes booting. Until core/editor
	// is ready, an insert records no undo step; until the canvas renders,
	// containers have no block-list settings. Tests must not race either.
	await page.waitForFunction(
		() => {
			const w = window as any;
			const editorReady = w.wp?.data
				?.select( 'core/editor' )
				?.__unstableIsEditorReady?.();
			const canvas = document.querySelector(
				'iframe[name="editor-canvas"]'
			) as HTMLIFrameElement | null;
			const root = ( canvas?.contentDocument ?? document ).querySelector(
				'.is-root-container'
			);
			return !! editorReady && !! root;
		},
		null,
		{ timeout }
	);
}
