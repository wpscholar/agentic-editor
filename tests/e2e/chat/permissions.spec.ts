import { test, expect } from '../fixtures';
import type { Browser, Page } from '@playwright/test';

type TestUser = { id: number; username: string; password: string };

/**
 * Create a user with the given role through the REST API, as the admin.
 */
async function createUser( admin: Page, role: string ): Promise< TestUser > {
	const suffix = `${ Date.now() }${ Math.floor( Math.random() * 1e6 ) }`;
	const username = `e2e-${ role }-${ suffix }`;
	const password = `pw-${ suffix }-${ role }`;

	const id = await admin.evaluate(
		async ( user ) => {
			const created = await ( window as any ).wp.apiFetch( {
				path: '/wp/v2/users',
				method: 'POST',
				data: user,
			} );
			return created.id as number;
		},
		{
			username,
			password,
			email: `${ username }@example.test`,
			roles: [ role ],
		}
	);

	return { id, username, password };
}

async function deleteUser( admin: Page, id: number ) {
	await admin.evaluate( async ( id ) => {
		await ( window as any ).wp.apiFetch( {
			path: `/wp/v2/users/${ id }?force=true&reassign=1`,
			method: 'DELETE',
		} );
	}, id );
}

/**
 * A page logged in as the given user, in a context of its own.
 */
async function logIn( browser: Browser, baseURL: string, user: TestUser ) {
	const context = await browser.newContext( {
		baseURL,
		storageState: { cookies: [], origins: [] },
	} );

	// Playground logs every new visitor in as the admin unless this is set.
	const { hostname } = new URL( baseURL );
	await context.addCookies( [
		{
			name: 'playground_auto_login_already_happened',
			value: '1',
			domain: hostname,
			path: '/',
		},
	] );

	// The tests only need the auth cookie, so log in straight to a static file
	// rather than the dashboard, which is slow to build on CI runners.
	const page = await context.newPage();
	await page.goto( '/wp-login.php?redirect_to=%2Freadme.html' );
	await page.locator( '#user_login' ).fill( user.username );
	await page.locator( '#user_pass' ).fill( user.password );
	await Promise.all( [
		page.waitForURL( /\/readme\.html$/ ),
		page.locator( '#wp-submit' ).click(),
	] );

	return page;
}

/**
 * Call a chat route with the logged-in user's cookie and REST nonce.
 */
async function chatRequest(
	page: Page,
	method: 'GET' | 'POST',
	route: string
): Promise< { status: number; code?: string } > {
	return page.evaluate(
		async ( { method, route } ) => {
			const nonce = await (
				await fetch( '/wp-admin/admin-ajax.php?action=rest-nonce' )
			).text();
			const response = await fetch(
				`/wp-json/agentic-editor/v1${ route }`,
				{
					method,
					headers: {
						'X-WP-Nonce': nonce,
						'Content-Type': 'application/json',
					},
					body:
						method === 'POST'
							? JSON.stringify( { messages: [] } )
							: undefined,
				}
			);
			const body = await response.json().catch( () => ( {} ) );
			return { status: response.status, code: body?.code };
		},
		{ method, route }
	);
}

test.describe( 'chat permissions', () => {
	test( 'a subscriber cannot use the chat', async ( {
		editor,
		browser,
		baseURL,
	} ) => {
		const user = await createUser( editor, 'subscriber' );
		try {
			const page = await logIn( browser, baseURL!, user );

			expect( await chatRequest( page, 'GET', '/chat/status' ) ).toEqual(
				{ status: 403, code: 'rest_forbidden' }
			);
			expect( await chatRequest( page, 'POST', '/chat' ) ).toEqual( {
				status: 403,
				code: 'rest_forbidden',
			} );

			// Nor see the screen.
			const response = await page.goto(
				'/wp-admin/tools.php?page=agentic-editor-chat'
			);
			expect( response?.status() ).toBe( 403 );

			await page.context().close();
		} finally {
			await deleteUser( editor, user.id );
		}
	} );

	test( 'a contributor can use the chat', async ( {
		editor,
		browser,
		baseURL,
	} ) => {
		const user = await createUser( editor, 'contributor' );
		try {
			const page = await logIn( browser, baseURL!, user );

			const status = await chatRequest( page, 'GET', '/chat/status' );
			expect( status.status ).toBe( 200 );

			// Passes the permission check and fails on the empty conversation,
			// before any provider is called.
			expect( await chatRequest( page, 'POST', '/chat' ) ).toEqual( {
				status: 400,
				code: 'agentic_editor_empty_conversation',
			} );

			await page.context().close();
		} finally {
			await deleteUser( editor, user.id );
		}
	} );
} );
