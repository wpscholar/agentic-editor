import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUIMessageStream } from 'ai';
import { chatConfig } from '@agentic-editor/chat-config';
import { callTool, listTools } from '@agentic-editor/webmcp-tools';
import {
	MAX_TOOL_TIMEOUT_MS,
	TOOL_TIMEOUT_MS,
	WordPressAiTransport,
	type ChatUIMessage,
} from './transport';

vi.mock( '@agentic-editor/webmcp-tools', () => ( {
	listTools: vi.fn(),
	callTool: vi.fn(),
	onToolsChanged: vi.fn(),
} ) );

type Call = { id: string; name: string; args?: Record< string, unknown > };

/** An endpoint response in which the model answers with text. */
function textTurn( text: string, historyMode = 'native' ) {
	return {
		message: {
			role: 'assistant',
			parts: [ { channel: 'content', type: 'text', text } ],
		},
		text,
		toolCalls: [],
		meta: { provider: 'Test', model: 'Test Model' },
		historyMode,
	};
}

/** An endpoint response in which the model calls tools. */
function callTurn( ...calls: Call[] ) {
	return {
		message: {
			role: 'assistant',
			parts: calls.map( ( call ) => ( {
				channel: 'content',
				type: 'function_call',
				functionCall: {
					id: call.id,
					name: call.name,
					args: call.args ?? {},
				},
			} ) ),
		},
		text: '',
		toolCalls: calls.map( ( call ) => ( {
			id: call.id,
			name: call.name,
			arguments: call.args ?? {},
		} ) ),
		meta: { provider: 'Test', model: 'Test Model' },
		historyMode: 'native',
	};
}

function userMessage( text: string, id = `user-${ text }` ): ChatUIMessage {
	return { id, role: 'user', parts: [ { type: 'text', text } ] };
}

/** Answer each chat request with the next body, and record what was sent. */
function respondWith( ...bodies: Array< object | ( () => Response ) > ) {
	const fetchMock = vi.fn( async ( _url: string, _init: RequestInit ) => {
		const next = bodies.shift();
		if ( ! next ) {
			throw new Error( 'Unexpected chat request' );
		}
		return typeof next === 'function'
			? next()
			: new Response( JSON.stringify( next ), { status: 200 } );
	} );
	vi.stubGlobal( 'fetch', fetchMock );

	return {
		requests: () =>
			fetchMock.mock.calls.map( ( [ , init ] ) =>
				JSON.parse( String( init.body ) )
			),
	};
}

/** Run one send and fold the stream the way useChat does. */
async function send(
	transport: WordPressAiTransport,
	messages: ChatUIMessage[],
	abortSignal?: AbortSignal
) {
	const stream = await transport.sendMessages( {
		trigger: 'submit-message',
		chatId: 'chat',
		messageId: undefined,
		messages,
		abortSignal,
	} );

	const errors: string[] = [];
	let message: ChatUIMessage | undefined;
	for await ( const snapshot of readUIMessageStream< ChatUIMessage >( {
		stream,
		terminateOnError: false,
		onError: ( error ) =>
			errors.push( ( error as Error ).message ?? String( error ) ),
	} ) ) {
		message = snapshot;
	}

	return { message: message!, errors, wire: message?.metadata?.wire ?? [] };
}

/**
 * Every function call in the stored history must be answered by the next turn,
 * or providers reject the conversation when it is replayed.
 */
function expectEveryCallAnswered( wire: unknown[] ) {
	wire.forEach( ( turn: any, index ) => {
		if ( turn.role !== 'assistant' ) {
			return;
		}
		const ids = turn.parts
			.filter( ( part: any ) => part.functionCall )
			.map( ( part: any ) => part.functionCall.id );
		if ( ! ids.length ) {
			return;
		}
		const next: any = wire[ index + 1 ];
		expect( next?.role, `turn ${ index } has unanswered calls` ).toBe(
			'tool'
		);
		expect(
			next.responses.map( ( response: any ) => response.id )
		).toEqual( ids );
	} );
}

beforeEach( () => {
	chatConfig.maxToolRounds = 8;
	vi.mocked( listTools ).mockResolvedValue( [
		{
			name: 'editor_get-editor-tree',
			description: 'Tree',
			source: 'local',
		},
	] );
	vi.mocked( callTool ).mockResolvedValue( {
		isError: false,
		value: { blocks: [] },
		text: '',
	} );
} );

afterEach( () => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
} );

describe( 'WordPressAiTransport', () => {
	it( 'finishes on a text-only answer', async () => {
		const { requests } = respondWith( textTurn( 'Hello there.' ) );

		const { message, errors, wire } = await send(
			new WordPressAiTransport(),
			[ userMessage( 'Hi' ) ]
		);

		expect( errors ).toEqual( [] );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( { type: 'text', text: 'Hello there.' } )
		);
		expect( wire ).toEqual( [
			{
				role: 'assistant',
				parts: textTurn( 'Hello there.' ).message.parts,
			},
		] );
		expect( message.metadata?.model ).toBe( 'Test Model' );
		expect( requests()[ 0 ].messages ).toEqual( [
			{ role: 'user', content: 'Hi' },
		] );
		expect( requests()[ 0 ].tools ).toEqual( [
			{ name: 'editor_get-editor-tree', description: 'Tree' },
		] );
	} );

	it( 'shows the thinking ahead of the answer', async () => {
		respondWith( {
			...textTurn( 'Hello there.' ),
			reasoning: 'The user said hi.',
		} );

		const { message } = await send( new WordPressAiTransport(), [
			userMessage( 'Hi' ),
		] );

		const shown = message.parts.filter(
			( part ) => part.type === 'reasoning' || part.type === 'text'
		);
		expect( shown ).toEqual( [
			expect.objectContaining( {
				type: 'reasoning',
				text: 'The user said hi.',
			} ),
			expect.objectContaining( { type: 'text', text: 'Hello there.' } ),
		] );
	} );

	it( 'runs a tool round, sends the result back, then finishes', async () => {
		const { requests } = respondWith(
			callTurn( {
				id: 'call_1',
				name: 'editor_get-editor-tree',
				args: { depth: 1 },
			} ),
			textTurn( 'The post is empty.' )
		);

		const { errors, wire, message } = await send(
			new WordPressAiTransport(),
			[ userMessage( 'What is in the post?' ) ]
		);

		expect( errors ).toEqual( [] );
		expect( callTool ).toHaveBeenCalledWith( 'editor_get-editor-tree', {
			depth: 1,
		} );
		expect( wire.map( ( turn ) => turn.role ) ).toEqual( [
			'assistant',
			'tool',
			'assistant',
		] );
		expect( wire[ 1 ] ).toEqual( {
			role: 'tool',
			responses: [
				{
					id: 'call_1',
					name: 'editor_get-editor-tree',
					response: { blocks: [] },
				},
			],
		} );
		expect( requests()[ 1 ].messages.slice( 1 ) ).toEqual(
			wire.slice( 0, 2 )
		);
		expect( message.parts ).toContainEqual(
			expect.objectContaining( {
				type: 'dynamic-tool',
				state: 'output-available',
			} )
		);
		expectEveryCallAnswered( wire );
	} );

	it( 'reads the context on every round and keeps the attachment label out of the wire', async () => {
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			textTurn( 'Done.' )
		);

		let round = 0;
		const message = userMessage( 'Shorten this.' );
		message.metadata = { attachment: { label: 'Paragraph: Hello' } };

		await send(
			new WordPressAiTransport( {
				getContext: () => ( {
					attachedBlock: { clientId: 'abc', round: ++round },
				} ),
			} ),
			[ message ]
		);

		expect(
			requests().map( ( request ) => request.context.attachedBlock )
		).toEqual( [
			{ clientId: 'abc', round: 1 },
			{ clientId: 'abc', round: 2 },
		] );
		expect( requests()[ 0 ].messages ).toEqual( [
			{ role: 'user', content: 'Shorten this.' },
		] );
	} );

	it( 'answers the last round of calls when it hits the round limit', async () => {
		chatConfig.maxToolRounds = 2;
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			callTurn( { id: 'call_2', name: 'editor_get-editor-tree' } ),
			callTurn( { id: 'call_3', name: 'editor_get-editor-tree' } )
		);

		const { errors, wire } = await send( new WordPressAiTransport(), [
			userMessage( 'Loop' ),
		] );

		expect( requests() ).toHaveLength( 3 );
		expect( callTool ).toHaveBeenCalledTimes( 2 );
		expect( errors ).toEqual( [
			'The assistant stopped after 2 rounds of tool calls.',
		] );
		expectEveryCallAnswered( wire );
		expect( ( wire.at( -1 ) as any ).responses[ 0 ].response ).toEqual( {
			error: 'Not run: the assistant reached its limit of 2 rounds of tool calls.',
		} );
	} );

	it( 'keeps the history consistent when stopped during a tool call', async () => {
		const controller = new AbortController();
		respondWith(
			callTurn(
				{ id: 'call_1', name: 'editor_get-editor-tree' },
				{ id: 'call_2', name: 'editor_get-editor-tree' }
			)
		);
		vi.mocked( callTool ).mockImplementationOnce( async () => {
			controller.abort();
			return { isError: false, value: { blocks: [ 'one' ] }, text: '' };
		} );

		const { errors, wire } = await send(
			new WordPressAiTransport(),
			[ userMessage( 'Stop me' ) ],
			controller.signal
		);

		expect( errors ).toEqual( [] );
		expect( callTool ).toHaveBeenCalledTimes( 1 );
		expectEveryCallAnswered( wire );
		expect(
			( wire[ 1 ] as any ).responses.map(
				( response: any ) => response.response
			)
		).toEqual( [
			{ blocks: [ 'one' ] },
			{ error: 'Not run: the user stopped the assistant.' },
		] );
	} );

	it( 'stops waiting on a tool call that never returns', async () => {
		vi.useFakeTimers();
		try {
			const { requests } = respondWith(
				callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
				textTurn( 'It timed out.' )
			);
			vi.mocked( callTool ).mockReturnValueOnce(
				new Promise( () => {} )
			);

			const pending = send( new WordPressAiTransport(), [
				userMessage( 'Hang' ),
			] );
			await vi.advanceTimersByTimeAsync( TOOL_TIMEOUT_MS );
			const { wire, message } = await pending;

			expect(
				( wire[ 1 ] as any ).responses[ 0 ].response.error
			).toContain( 'did not finish within 30 seconds' );
			expect( requests() ).toHaveLength( 2 );
			expect( message.parts ).toContainEqual(
				expect.objectContaining( {
					type: 'dynamic-tool',
					state: 'output-error',
				} )
			);
		} finally {
			vi.useRealTimers();
		}
	} );

	it( 'waits longer for a tool that asks for it, up to the cap', async () => {
		vi.useFakeTimers();
		try {
			vi.mocked( listTools ).mockResolvedValue( [
				{
					name: 'editor_generate-image',
					description: 'Image',
					source: 'local',
					timeoutMs: 120_000,
				},
				{
					name: 'editor_greedy',
					description: 'Greedy',
					source: 'local',
					timeoutMs: 10 * MAX_TOOL_TIMEOUT_MS,
				},
			] );
			respondWith(
				callTurn( { id: 'call_1', name: 'editor_generate-image' } ),
				callTurn( { id: 'call_2', name: 'editor_greedy' } ),
				textTurn( 'Done.' )
			);
			let finish: ( result: any ) => void = () => {};
			vi.mocked( callTool )
				.mockReturnValueOnce(
					new Promise( ( resolve ) => {
						finish = resolve;
					} )
				)
				.mockReturnValueOnce( new Promise( () => {} ) );

			const pending = send( new WordPressAiTransport(), [
				userMessage( 'Draw' ),
			] );
			// Past the usual limit, the image call is still waited on.
			await vi.advanceTimersByTimeAsync( TOOL_TIMEOUT_MS * 2 );
			finish( { isError: false, value: { id: 42 }, text: '' } );
			await vi.advanceTimersByTimeAsync( MAX_TOOL_TIMEOUT_MS );
			const { wire } = await pending;

			expect( ( wire[ 1 ] as any ).responses[ 0 ].response ).toEqual( {
				id: 42,
			} );
			expect(
				( wire[ 3 ] as any ).responses[ 0 ].response.error
			).toContain(
				`did not finish within ${ MAX_TOOL_TIMEOUT_MS / 1000 } seconds`
			);
		} finally {
			vi.useRealTimers();
		}
	} );

	it( 'stops waiting on a running tool call when stopped', async () => {
		const controller = new AbortController();
		respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } )
		);
		vi.mocked( callTool ).mockImplementationOnce( () => {
			queueMicrotask( () => controller.abort() );
			return new Promise( () => {} );
		} );

		const { errors, wire } = await send(
			new WordPressAiTransport(),
			[ userMessage( 'Stop me' ) ],
			controller.signal
		);

		expect( errors ).toEqual( [] );
		expectEveryCallAnswered( wire );
		expect( ( wire[ 1 ] as any ).responses[ 0 ].response.error ).toContain(
			'may or may not have taken effect'
		);
	} );

	it( 'reports a failed tool call to the model and the UI', async () => {
		respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			textTurn( 'That failed.' )
		);
		vi.mocked( callTool ).mockResolvedValueOnce( {
			isError: true,
			value: { error: 'No editor' },
			text: 'No editor',
		} );

		const { wire, message } = await send( new WordPressAiTransport(), [
			userMessage( 'Try' ),
		] );

		expect( ( wire[ 1 ] as any ).responses[ 0 ].response ).toEqual( {
			error: 'No editor',
		} );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( {
				type: 'dynamic-tool',
				state: 'output-error',
				errorText: 'No editor',
			} )
		);
	} );

	it( 'surfaces the endpoint error message and stores only whole rounds', async () => {
		respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			() =>
				new Response( JSON.stringify( { message: 'Rate limited.' } ), {
					status: 429,
				} )
		);

		const { errors, wire } = await send( new WordPressAiTransport(), [
			userMessage( 'Hi' ),
		] );

		expect( errors ).toEqual( [ 'Rate limited.' ] );
		expect( wire.map( ( turn ) => turn.role ) ).toEqual( [
			'assistant',
			'tool',
		] );
		expectEveryCallAnswered( wire );
	} );

	it( 'reports the history mode that worked on the next request', async () => {
		const { requests } = respondWith(
			textTurn( 'One', 'text' ),
			textTurn( 'Two' )
		);
		const transport = new WordPressAiTransport();

		const first = await send( transport, [ userMessage( 'A' ) ] );
		await send( transport, [
			userMessage( 'A' ),
			first.message,
			userMessage( 'B' ),
		] );

		expect( requests()[ 0 ].historyMode ).toBe( 'native' );
		expect( requests()[ 1 ].historyMode ).toBe( 'text' );
	} );

	it( 'replays a stored turn exactly and never changes it afterwards', async () => {
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			textTurn( 'Done.' ),
			textTurn( 'Again.' )
		);
		const transport = new WordPressAiTransport();

		const first = await send( transport, [ userMessage( 'A' ) ] );
		const stored = structuredClone( first.wire );
		await send( transport, [
			userMessage( 'A' ),
			first.message,
			userMessage( 'B' ),
		] );

		expect( first.wire ).toEqual( stored );
		expect( requests()[ 2 ].messages ).toEqual( [
			{ role: 'user', content: 'A' },
			...stored,
			{ role: 'user', content: 'B' },
		] );
	} );
} );

describe( 'WordPressAiTransport approvals', () => {
	beforeEach( () => {
		vi.mocked( listTools ).mockResolvedValue( [
			{
				name: 'editor_create-pattern',
				description: 'Create',
				source: 'local',
				approval: 'Publishes a pattern.',
			},
		] );
	} );

	/** Answer the first approval request the stream raises. */
	function answerApproval(
		transport: WordPressAiTransport,
		approved: boolean
	) {
		const original = transport.sendMessages.bind( transport );
		vi.spyOn( transport, 'sendMessages' ).mockImplementation(
			async ( options ) => {
				const stream = await original( options );
				return stream.pipeThrough(
					new TransformStream( {
						transform( chunk, controller ) {
							controller.enqueue( chunk );
							if ( chunk.type === 'tool-approval-request' ) {
								queueMicrotask( () =>
									transport.respondToApproval(
										chunk.approvalId,
										approved
									)
								);
							}
						},
					} )
				);
			}
		);
	}

	it( 'runs a call once it is approved', async () => {
		respondWith(
			callTurn( {
				id: 'call_1',
				name: 'editor_create-pattern',
				args: { title: 'Hero' },
			} ),
			textTurn( 'Saved.' )
		);
		const transport = new WordPressAiTransport();
		answerApproval( transport, true );

		const { message, wire } = await send( transport, [
			userMessage( 'Save it' ),
		] );

		expect( callTool ).toHaveBeenCalledWith( 'editor_create-pattern', {
			title: 'Hero',
		} );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( {
				type: 'dynamic-tool',
				state: 'output-available',
				approval: expect.objectContaining( {
					approved: true,
					requestReason: 'Publishes a pattern.',
				} ),
			} )
		);
		expectEveryCallAnswered( wire );
	} );

	it( 'tells the model when a call is denied', async () => {
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_create-pattern' } ),
			textTurn( 'Okay, I will not.' )
		);
		const transport = new WordPressAiTransport();
		answerApproval( transport, false );

		const { message, wire } = await send( transport, [
			userMessage( 'Save it' ),
		] );

		expect( callTool ).not.toHaveBeenCalled();
		expect( message.parts ).toContainEqual(
			expect.objectContaining( {
				type: 'dynamic-tool',
				state: 'output-denied',
			} )
		);
		expect( requests()[ 1 ].messages.at( -1 ) ).toEqual( {
			role: 'tool',
			responses: [
				{
					id: 'call_1',
					name: 'editor_create-pattern',
					response: {
						error: 'Not run: the user declined this action.',
					},
				},
			],
		} );
		expectEveryCallAnswered( wire );
	} );

	it( 'stops cleanly while a call waits for approval', async () => {
		respondWith(
			callTurn( { id: 'call_1', name: 'editor_create-pattern' } )
		);
		const controller = new AbortController();
		const transport = new WordPressAiTransport();
		const original = transport.sendMessages.bind( transport );
		vi.spyOn( transport, 'sendMessages' ).mockImplementation(
			async ( options ) =>
				( await original( options ) ).pipeThrough(
					new TransformStream( {
						transform( chunk, stream ) {
							stream.enqueue( chunk );
							if ( chunk.type === 'tool-approval-request' ) {
								queueMicrotask( () => controller.abort() );
							}
						},
					} )
				)
		);

		const { errors, wire } = await send(
			transport,
			[ userMessage( 'Save it' ) ],
			controller.signal
		);

		expect( errors ).toEqual( [] );
		expect( callTool ).not.toHaveBeenCalled();
		expectEveryCallAnswered( wire );
		expect( ( wire[ 1 ] as any ).responses[ 0 ].response ).toEqual( {
			error: 'Not run: the user stopped the assistant.',
		} );
	} );
} );

describe( 'WordPressAiTransport nonce renewal', () => {
	const expired = () =>
		new Response(
			JSON.stringify( {
				code: 'rest_cookie_invalid_nonce',
				message: 'Cookie check failed',
			} ),
			{ status: 403 }
		);

	/** Route chat and nonce requests to separate queues of responses. */
	function mockFetch(
		chat: Array< () => Response >,
		nonce: Array< () => Response >
	) {
		const fetchMock = vi.fn( async ( url: string, _init?: RequestInit ) =>
			( url === chatConfig.nonceUrl ? nonce : chat ).shift()!()
		);
		vi.stubGlobal( 'fetch', fetchMock );
		return fetchMock;
	}

	it( 'renews an expired nonce and retries once', async () => {
		const fetchMock = mockFetch(
			[
				expired,
				() => new Response( JSON.stringify( textTurn( 'Hi again.' ) ) ),
			],
			[ () => new Response( '0123456789' ) ]
		);

		const { errors, message } = await send( new WordPressAiTransport(), [
			userMessage( 'Hi' ),
		] );

		expect( errors ).toEqual( [] );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( { type: 'text', text: 'Hi again.' } )
		);
		const chatCalls = fetchMock.mock.calls.filter(
			( [ url ] ) => url === chatConfig.restUrl
		);
		expect(
			( chatCalls[ 0 ][ 1 ]!.headers as Record< string, string > )[
				'X-WP-Nonce'
			]
		).toBe( 'nonce' );
		expect(
			( chatCalls[ 1 ][ 1 ]!.headers as Record< string, string > )[
				'X-WP-Nonce'
			]
		).toBe( '0123456789' );
	} );

	it( 'says the session expired when no nonce can be had', async () => {
		mockFetch(
			[ expired ],
			[ () => new Response( '0', { status: 400 } ) ]
		);

		const { errors } = await send( new WordPressAiTransport(), [
			userMessage( 'Hi' ),
		] );

		expect( errors ).toEqual( [
			'Your login session has expired. Reload the page, logging in again if asked, and resend your message.',
		] );
	} );

	it( 'leaves other 403s alone', async () => {
		const fetchMock = mockFetch(
			[
				() =>
					new Response(
						JSON.stringify( {
							code: 'rest_forbidden',
							message: 'Nope.',
						} ),
						{ status: 403 }
					),
			],
			[]
		);

		const { errors } = await send( new WordPressAiTransport(), [
			userMessage( 'Hi' ),
		] );

		expect( errors ).toEqual( [ 'Nope.' ] );
		expect( fetchMock ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'goes back to native history for a new conversation', async () => {
		const { requests } = respondWith(
			textTurn( 'One', 'text' ),
			textTurn( 'Two' )
		);
		const transport = new WordPressAiTransport();

		await send( transport, [ userMessage( 'A' ) ] );
		// After Clear, the next send has no assistant turn in its history.
		await send( transport, [ userMessage( 'B' ) ] );

		expect( requests()[ 1 ].historyMode ).toBe( 'native' );
	} );

	it( 'keeps calls apart when a provider reuses call IDs across rounds', async () => {
		vi.mocked( callTool ).mockResolvedValue( {
			isError: false,
			value: { ok: true },
			text: '',
		} );
		respondWith(
			callTurn( { id: 'call_0', name: 'editor_get-editor-tree' } ),
			callTurn( { id: 'call_0', name: 'editor_get-editor-tree' } ),
			textTurn( 'Done.' )
		);
		const transport = new WordPressAiTransport();

		const { message, wire } = await send( transport, [
			userMessage( 'A' ),
		] );

		const toolParts = message.parts.filter(
			( part ) => part.type === 'dynamic-tool'
		);
		expect( toolParts ).toHaveLength( 2 );
		expect(
			new Set( toolParts.map( ( part: any ) => part.toolCallId ) ).size
		).toBe( 2 );
		// The provider's own IDs are what the replay carries.
		expect(
			wire
				.filter( ( turn ) => turn.role === 'tool' )
				.map( ( turn: any ) => turn.responses[ 0 ].id )
		).toEqual( [ 'call_0', 'call_0' ] );
	} );

	it( 'stops the loop when the reader cancels mid-round', async () => {
		let finish: ( value: unknown ) => void = () => {};
		vi.mocked( callTool ).mockImplementation(
			() =>
				new Promise( ( resolve ) => {
					finish = resolve;
				} ) as never
		);
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			textTurn( 'Done.' )
		);
		const transport = new WordPressAiTransport();

		const stream = await transport.sendMessages( {
			trigger: 'submit-message',
			chatId: 'chat',
			messageId: undefined,
			messages: [ userMessage( 'A' ) ],
			abortSignal: undefined,
		} );
		const reader = stream.getReader();
		await vi.waitFor( () => expect( callTool ).toHaveBeenCalled() );
		await reader.cancel();

		// The loop stops instead of sending the tool result on.
		finish( { isError: false, value: {}, text: '' } );
		await new Promise( ( resolve ) => setTimeout( resolve, 20 ) );
		expect( requests() ).toHaveLength( 1 );
	} );
} );
