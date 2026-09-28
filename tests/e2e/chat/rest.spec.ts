import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';

type ChatError = { code: string; message: string; status: number };

/**
 * POST one chat request and return the error it was answered with, if any.
 */
async function postChat(
	page: Page,
	data: Record< string, unknown >
): Promise< ChatError | null > {
	return page.evaluate( async ( data ) => {
		try {
			await ( window as any ).wp.apiFetch( {
				path: '/agentic-editor/v1/chat',
				method: 'POST',
				data,
			} );
			return null;
		} catch ( error: any ) {
			return {
				code: error?.code,
				message: error?.message,
				status: error?.data?.status,
			};
		}
	}, data );
}

/**
 * POST one chat turn with a replayed assistant message and return the error.
 *
 * Every case here is rejected while the conversation is rebuilt, before any
 * provider is called, so the spec needs no AI connector.
 */
async function postAssistantParts(
	page: Page,
	parts: unknown[]
): Promise< ChatError | null > {
	return postChat( page, {
		messages: [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', parts },
			{ role: 'user', content: 'Repeat that back to me.' },
		],
	} );
}

/**
 * A conversation that ends in the given number of tool-call rounds.
 *
 * Its assistant turns carry a file part, so a request that gets past the round
 * limit is still rejected before it reaches a provider.
 */
function toolRounds( rounds: number ) {
	const messages: unknown[] = [ { role: 'user', content: 'Hello' } ];
	for ( let round = 0; round < rounds; round += 1 ) {
		messages.push(
			{ role: 'assistant', parts: [ { type: 'file', file: {} } ] },
			{
				role: 'tool',
				responses: [
					{ id: `call_${ round }`, name: 'x', response: {} },
				],
			}
		);
	}
	return messages;
}

test.describe( 'chat REST replay', () => {
	test( 'rejects a file part instead of reading a local path', async ( {
		editor,
	} ) => {
		const error = await postAssistantParts( editor, [
			{
				type: 'file',
				file: {
					fileType: 'inline',
					mimeType: 'text/plain',
					base64Data: '/wordpress/wp-config.php',
				},
			},
		] );

		expect( error?.code ).toBe( 'agentic_editor_invalid_message' );
		expect( error?.status ).toBe( 400 );
		expect( error?.message ).not.toContain( 'wp-config' );
		expect( error?.message ).not.toContain( 'Unable to read file' );
	} );

	test( 'rejects a remote file part', async ( { editor } ) => {
		const error = await postAssistantParts( editor, [
			{
				type: 'file',
				file: {
					fileType: 'remote',
					mimeType: 'text/plain',
					url: 'http://127.0.0.1/',
				},
			},
		] );

		expect( error?.code ).toBe( 'agentic_editor_invalid_message' );
		expect( error?.status ).toBe( 400 );
	} );

	test( 'rejects a function response in an assistant turn', async ( {
		editor,
	} ) => {
		const error = await postAssistantParts( editor, [
			{
				type: 'function_response',
				functionResponse: { id: 'call_1', name: 'x', response: {} },
			},
		] );

		expect( error?.code ).toBe( 'agentic_editor_invalid_message' );
		expect( error?.status ).toBe( 400 );
	} );

	test( 'answers malformed parts with a 400, not a fatal', async ( {
		editor,
	} ) => {
		for ( const part of [
			{ type: 'text', text: [ 'not', 'a', 'string' ] },
			{ type: 'text', text: 'hi', channel: 'nonsense' },
			{ type: 'text', text: 'hi', thoughtSignature: 42 },
			{ type: 'function_call', functionCall: { name: 7 } },
			{ type: 'function_call', functionCall: {} },
			{ type: 'mystery' },
		] ) {
			const error = await postAssistantParts( editor, [ part ] );
			expect( error, JSON.stringify( part ) ).toMatchObject( {
				code: 'agentic_editor_invalid_message',
				status: 400,
			} );
		}
	} );
} );

test.describe( 'chat REST limits', () => {
	test( 'rejects a body over the size limit', async ( { editor } ) => {
		const error = await postChat( editor, {
			messages: [
				{ role: 'user', content: 'x'.repeat( 1024 * 1024 + 1 ) },
			],
		} );

		expect( error ).toMatchObject( {
			code: 'agentic_editor_request_too_large',
			status: 413,
		} );
	} );

	test( 'rejects too many messages', async ( { editor } ) => {
		const error = await postChat( editor, {
			messages: Array.from( { length: 501 }, () => ( {
				role: 'user',
				content: 'Hi',
			} ) ),
		} );

		expect( error ).toMatchObject( {
			code: 'agentic_editor_too_many_messages',
			status: 400,
		} );
	} );

	test( 'rejects too many tools', async ( { editor } ) => {
		const error = await postChat( editor, {
			messages: [ { role: 'user', content: 'Hi' } ],
			tools: Array.from( { length: 129 }, ( _, index ) => ( {
				name: `tool_${ index }`,
			} ) ),
		} );

		expect( error ).toMatchObject( {
			code: 'agentic_editor_too_many_tools',
			status: 400,
		} );
	} );

	test( 'enforces the tool round limit server-side', async ( { editor } ) => {
		const over = await postChat( editor, { messages: toolRounds( 26 ) } );
		expect( over ).toMatchObject( {
			code: 'agentic_editor_too_many_rounds',
			status: 400,
		} );

		// 25 rounds is within the limit, so it fails later, on the file part.
		const within = await postChat( editor, { messages: toolRounds( 25 ) } );
		expect( within ).toMatchObject( {
			code: 'agentic_editor_invalid_message',
			status: 400,
		} );

		// Rounds before the latest user message belong to earlier messages.
		const earlier = await postChat( editor, {
			messages: [
				...toolRounds( 26 ),
				{ role: 'user', content: 'Next question' },
			],
		} );
		expect( earlier ).toMatchObject( {
			code: 'agentic_editor_invalid_message',
			status: 400,
		} );
	} );
} );

test.describe( 'image REST', () => {
	// Nothing here may reach a provider, so the first case only runs on a
	// site whose connectors cannot generate images.
	test( 'says when no connector can generate images', async ( {
		editor,
	} ) => {
		const supported = await editor.evaluate(
			async () =>
				(
					await ( window as any ).wp.apiFetch( {
						path: '/agentic-editor/v1/chat/status',
					} )
				).imageGeneration
		);
		// eslint-disable-next-line playwright/no-skipped-test -- Generating would bill the site's connector.
		test.skip(
			supported,
			'This site has a connector that can generate images.'
		);

		const result = await editor.evaluate( async () => {
			const wp = ( window as any ).wp;
			const status = await wp.apiFetch( {
				path: '/agentic-editor/v1/chat/status',
			} );
			try {
				await wp.apiFetch( {
					path: '/agentic-editor/v1/image',
					method: 'POST',
					data: { prompt: 'A lighthouse at dusk' },
				} );
				return { status, error: null };
			} catch ( error: any ) {
				return {
					status,
					error: { code: error?.code, status: error?.data?.status },
				};
			}
		} );

		expect( result.status.imageGeneration ).toBe( false );
		expect( result.error ).toEqual( {
			code: 'agentic_editor_image_unsupported',
			status: 501,
		} );
	} );

	test( 'rejects a request without a prompt', async ( { editor } ) => {
		const error = await editor.evaluate( async () => {
			try {
				await ( window as any ).wp.apiFetch( {
					path: '/agentic-editor/v1/image',
					method: 'POST',
					data: {},
				} );
				return null;
			} catch ( caught: any ) {
				return { code: caught?.code, status: caught?.data?.status };
			}
		} );

		expect( error ).toEqual( {
			code: 'rest_missing_callback_param',
			status: 400,
		} );
	} );
} );
