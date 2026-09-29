/**
 * An AI SDK transport backed by the WordPress AI Client.
 *
 * The REST endpoint runs exactly one model turn and streams nothing, so this
 * transport owns the loop that turns a request into an answer: send the
 * conversation, run whatever tools the model asked for against the page, send
 * the results back, repeat until the model replies with text. Every round is
 * emitted into the one assistant message the AI SDK is expecting, separated by
 * step boundaries.
 *
 * Nothing here touches the DOM or the block editor.
 */

import { chatConfig } from '@agentic-editor/chat-config';
import {
	callTool,
	listTools,
	type WebMcpTool,
	type WebMcpToolResult,
} from '@agentic-editor/webmcp-tools';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { approvalReason } from './approval';

/**
 * What a turn is replayed from.
 *
 * `wire` holds the raw AI Client messages this assistant turn produced, in
 * order, so a later request can replay the model's own function calls as
 * function calls rather than as a description of them. Anything reconstructed
 * from the rendered UI message would lose the provider's call IDs.
 */
export interface ChatMetadata {
	wire?: WireMessage[];
	/** What the user attached to this message, for the transcript only. */
	attachment?: { label: string };
	model?: string;
	provider?: string;
}

export type ChatUIMessage = UIMessage< ChatMetadata >;

type WireMessage =
	| { role: 'user'; content: string }
	| { role: 'assistant'; parts: unknown[] }
	| { role: 'tool'; responses: ToolResponse[] };

interface ToolResponse {
	id: string | null;
	name: string;
	response: unknown;
}

interface ToolCall {
	id: string | null;
	name: string;
	arguments: Record< string, unknown > | null;
}

interface TurnResponse {
	message?: { role: string; parts: unknown[] };
	text?: string;
	/** The model's thinking, when the provider returned any. */
	reasoning?: string;
	toolCalls?: ToolCall[];
	meta?: { provider?: string; model?: string };
	historyMode?: HistoryMode;
}

type HistoryMode = 'native' | 'text';

type Emit = ( chunk: UIMessageChunk< ChatMetadata > ) => void;

/**
 * How long one tool call may run before the loop gives up on it. Abilities
 * cannot be cancelled once started, so this only stops the loop waiting.
 */
export const TOOL_TIMEOUT_MS = 30_000;

/**
 * The longest a tool may ask to be waited on, however long it says it needs.
 */
export const MAX_TOOL_TIMEOUT_MS = 300_000;

let idCounter = 0;

function nextId( prefix: string ): string {
	idCounter += 1;
	return `${ prefix }-${ idCounter }`;
}

function errorMessage( error: unknown ): string {
	if ( error instanceof Error ) {
		return error.message;
	}
	return String( error );
}

function isAbort( error: unknown ): boolean {
	return (
		( error instanceof Error || error instanceof DOMException ) &&
		error.name === 'AbortError'
	);
}

/**
 * Flatten a UI message back into what the endpoint replays.
 *
 * Assistant turns come from their metadata rather than from their rendered
 * parts; see ChatMetadata.
 */
function toWireMessages( message: ChatUIMessage ): WireMessage[] {
	if ( message.role === 'user' ) {
		const content = message.parts
			.filter( ( part ) => part.type === 'text' )
			.map( ( part ) => ( part as { text: string } ).text )
			.join( '\n' )
			.trim();

		return content ? [ { role: 'user', content } ] : [];
	}

	if ( message.role === 'assistant' ) {
		return message.metadata?.wire ?? [];
	}

	return [];
}

/**
 * A tool turn answering every call with the same error.
 *
 * Providers reject a function call that has no response, so a round that is
 * cut short still has to answer each call, and saying why lets the model take
 * it into account on the next message.
 */
function notRunTurn(
	toolCalls: ToolCall[],
	reason: string
): { role: 'tool'; responses: ToolResponse[] } {
	return {
		role: 'tool',
		responses: toolCalls.map( ( call ) => ( {
			id: call.id,
			name: call.name,
			response: { error: reason },
		} ) ),
	};
}

/**
 * Run a tool call, but stop waiting on Stop or after its timeout: the tool's
 * own `timeoutMs` when it set one, capped at MAX_TOOL_TIMEOUT_MS, and
 * TOOL_TIMEOUT_MS otherwise.
 *
 * WebMCP has no way to cancel a call in progress, so a call abandoned here may
 * still finish in the background; the loop just no longer waits for it.
 */
async function callToolWithLimits(
	name: string,
	input: Record< string, unknown >,
	abortSignal: AbortSignal | undefined,
	timeoutMs: number = TOOL_TIMEOUT_MS
): Promise< WebMcpToolResult > {
	const limit = Math.min( timeoutMs, MAX_TOOL_TIMEOUT_MS );
	let timer: ReturnType< typeof setTimeout > | undefined;
	let onAbort: ( () => void ) | undefined;

	const timeout = new Promise< WebMcpToolResult >( ( resolve ) => {
		timer = setTimeout( () => {
			const text = `${ name } did not finish within ${
				limit / 1000
			} seconds, so its result is unknown. Check the current state before retrying.`;
			resolve( { isError: true, value: { error: text }, text } );
		}, limit );
	} );

	const aborted = new Promise< never >( ( _resolve, reject ) => {
		onAbort = () => reject( new DOMException( 'Stopped', 'AbortError' ) );
		abortSignal?.addEventListener( 'abort', onAbort, { once: true } );
	} );

	try {
		abortSignal?.throwIfAborted();
		return await Promise.race( [
			callTool( name, input ),
			timeout,
			aborted,
		] );
	} finally {
		clearTimeout( timer );
		if ( onAbort ) {
			abortSignal?.removeEventListener( 'abort', onAbort );
		}
	}
}

/** Whether a response is WordPress rejecting an expired REST nonce. */
async function isExpiredNonce( response: Response ): Promise< boolean > {
	if ( response.status !== 403 ) {
		return false;
	}
	try {
		const body = await response.clone().json();
		return body?.code === 'rest_cookie_invalid_nonce';
	} catch {
		return false;
	}
}

async function readErrorMessage( response: Response ): Promise< string > {
	try {
		const body = await response.json();
		if ( body?.message ) {
			return String( body.message );
		}
	} catch {
		// Fall through to the status text.
	}
	return `The chat request failed (${ response.status } ${ response.statusText }).`;
}

export interface WordPressAiTransportOptions {
	/**
	 * Page context for the user's latest message, read at send time so that
	 * it describes the screen as it is now rather than as it was at mount.
	 */
	getContext?: () => Record< string, unknown >;
}

export class WordPressAiTransport implements ChatTransport< ChatUIMessage > {
	private readonly getContext: () => Record< string, unknown >;

	/**
	 * How the server replayed tool calls last turn. Reporting it back keeps a
	 * provider that rejects native tool call history from being retried on
	 * every turn of the same conversation.
	 */
	private historyMode: HistoryMode = 'native';

	/** Starts as the page's nonce and is renewed when it expires. */
	private nonce: string = chatConfig.nonce;

	/** Tool calls waiting on a person, by approval ID. */
	private readonly pendingApprovals = new Map<
		string,
		( approved: boolean ) => void
	>();

	constructor( options: WordPressAiTransportOptions = {} ) {
		this.getContext = options.getContext ?? ( () => ( {} ) );
	}

	sendMessages( options: {
		trigger: 'submit-message' | 'regenerate-message';
		chatId: string;
		messageId: string | undefined;
		messages: ChatUIMessage[];
		abortSignal: AbortSignal | undefined;
	} ): Promise< ReadableStream< UIMessageChunk< ChatMetadata > > > {
		const { messages } = options;

		/*
		 * The reader can go away without Stop being pressed (the panel
		 * unmounting, say). That has to end the loop too, or it would carry
		 * on sending paid requests nobody reads, and enqueueing after it
		 * would throw.
		 */
		let closed = false;
		const cancelled = new AbortController();
		const abortSignal = options.abortSignal
			? AbortSignal.any( [ options.abortSignal, cancelled.signal ] )
			: cancelled.signal;

		const stream = new ReadableStream< UIMessageChunk< ChatMetadata > >( {
			start: async ( controller ) => {
				const emit: Emit = ( chunk ) => {
					if ( ! closed ) {
						controller.enqueue( chunk );
					}
				};

				try {
					await this.run( messages, emit, abortSignal );
				} catch ( error ) {
					if ( ! isAbort( error ) ) {
						emit( {
							type: 'error',
							errorText: errorMessage( error ),
						} );
					}
				} finally {
					if ( ! closed ) {
						closed = true;
						controller.close();
					}
				}
			},
			cancel: () => {
				closed = true;
				cancelled.abort();
			},
		} );

		return Promise.resolve( stream );
	}

	/**
	 * Answer a tool call that is waiting for approval.
	 *
	 * The loop waits inside the stream rather than ending it, as the AI SDK's
	 * own approval flow would, so the round carries on where it paused.
	 */
	respondToApproval( approvalId: string, approved: boolean ): void {
		const resolve = this.pendingApprovals.get( approvalId );
		if ( resolve ) {
			this.pendingApprovals.delete( approvalId );
			resolve( approved );
		}
	}

	private waitForApproval(
		approvalId: string,
		abortSignal: AbortSignal | undefined
	): Promise< boolean > {
		return new Promise( ( resolve, reject ) => {
			const onAbort = () => {
				this.pendingApprovals.delete( approvalId );
				reject( new DOMException( 'Stopped', 'AbortError' ) );
			};
			if ( abortSignal?.aborted ) {
				onAbort();
				return;
			}
			abortSignal?.addEventListener( 'abort', onAbort, { once: true } );
			this.pendingApprovals.set( approvalId, ( approved ) => {
				abortSignal?.removeEventListener( 'abort', onAbort );
				resolve( approved );
			} );
		} );
	}

	reconnectToStream(): Promise< ReadableStream<
		UIMessageChunk< ChatMetadata >
	> | null > {
		// Every turn is driven from the browser, so there is nothing to rejoin.
		return Promise.resolve( null );
	}

	private async run(
		history: ChatUIMessage[],
		emit: Emit,
		abortSignal: AbortSignal | undefined
	): Promise< void > {
		// A conversation with no assistant turn yet is a new one, so it gets
		// to try native history again, even after Clear on the same page.
		if ( ! history.some( ( message ) => message.role === 'assistant' ) ) {
			this.historyMode = 'native';
		}

		const wire: WireMessage[] = history.flatMap( toWireMessages );

		// Only the turns produced now belong to the message being built.
		const produced: WireMessage[] = [];
		const metadata: ChatMetadata = {};

		/*
		 * The AI SDK keeps whatever array a metadata chunk carries, so every
		 * chunk gets a fresh snapshot rather than a live array that later
		 * rounds would change underneath the stored message. `pending` is a
		 * round still in progress, included so that the stored history always
		 * pairs every function call with a response, wherever Stop lands.
		 */
		const snapshot = ( pending: WireMessage[] = [] ): ChatMetadata => ( {
			...metadata,
			wire: [ ...produced, ...pending ],
		} );
		const publish = ( pending?: WireMessage[] ) =>
			emit( {
				type: 'message-metadata',
				messageMetadata: snapshot( pending ),
			} );

		const tools = await listTools();
		const toolsByName = new Map(
			tools.map( ( tool ) => [ tool.name, tool ] )
		);
		const declarations = tools.map( ( tool ) => ( {
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		} ) );

		const maxRounds = Math.max( 1, chatConfig.maxToolRounds );

		emit( { type: 'start' } );

		for ( let round = 0; round <= maxRounds; round += 1 ) {
			abortSignal?.throwIfAborted();

			emit( { type: 'start-step' } );

			const payload = await this.requestTurn(
				wire,
				declarations,
				abortSignal
			);

			const parts = payload.message?.parts ?? [];
			const assistantTurn: WireMessage = { role: 'assistant', parts };

			if ( payload.meta?.model ) {
				metadata.model = payload.meta.model;
			}
			if ( payload.meta?.provider ) {
				metadata.provider = payload.meta.provider;
			}

			// Thinking comes before what it led to, the way a provider
			// that streams would have sent it.
			if ( payload.reasoning ) {
				const reasoningId = nextId( 'reasoning' );
				emit( { type: 'reasoning-start', id: reasoningId } );
				emit( {
					type: 'reasoning-delta',
					id: reasoningId,
					delta: payload.reasoning,
				} );
				emit( { type: 'reasoning-end', id: reasoningId } );
			}

			if ( payload.text ) {
				/*
				 * The endpoint returns the whole turn at once, so the text
				 * arrives as a single delta rather than being retimed into a
				 * fake typewriter.
				 */
				const textId = nextId( 'text' );
				emit( { type: 'text-start', id: textId } );
				emit( {
					type: 'text-delta',
					id: textId,
					delta: payload.text,
				} );
				emit( { type: 'text-end', id: textId } );
			}

			const toolCalls = payload.toolCalls ?? [];

			if ( ! toolCalls.length ) {
				produced.push( assistantTurn );
				emit( { type: 'finish-step' } );
				emit( { type: 'finish', messageMetadata: snapshot() } );
				return;
			}

			if ( round === maxRounds ) {
				produced.push(
					assistantTurn,
					notRunTurn(
						toolCalls,
						`Not run: the assistant reached its limit of ${ maxRounds } rounds of tool calls.`
					)
				);
				publish();
				emit( { type: 'finish-step' } );
				emit( {
					type: 'error',
					errorText: `The assistant stopped after ${ maxRounds } rounds of tool calls.`,
				} );
				return;
			}

			// Filled in as each call completes; anything left was never run.
			let toolTurn = notRunTurn(
				toolCalls,
				'Not run: the user stopped the assistant.'
			);
			publish( [ assistantTurn, toolTurn ] );

			await this.runToolCalls(
				toolCalls,
				toolsByName,
				emit,
				abortSignal,
				( index, response ) => {
					// A new turn each time: the last one is already emitted.
					toolTurn = {
						role: 'tool',
						responses: toolTurn.responses.map(
							( existing, position ) =>
								position === index ? response : existing
						),
					};
					publish( [ assistantTurn, toolTurn ] );
				}
			);

			wire.push( assistantTurn, toolTurn );
			produced.push( assistantTurn, toolTurn );

			emit( { type: 'finish-step' } );
		}
	}

	private async runToolCalls(
		toolCalls: ToolCall[],
		toolsByName: Map< string, WebMcpTool >,
		emit: Emit,
		abortSignal: AbortSignal | undefined,
		onResponse: ( index: number, response: ToolResponse ) => void
	): Promise< void > {
		for ( const [ index, call ] of toolCalls.entries() ) {
			abortSignal?.throwIfAborted();

			/*
			 * The UI's own ID for this call. The provider's ID is only unique
			 * within its round, and a provider that restarts its numbering
			 * each round would otherwise overwrite earlier calls on screen.
			 */
			const toolCallId = nextId( 'call' );
			const input = call.arguments ?? {};

			/*
			 * These are dynamic tools: the set comes from whatever the page
			 * registered with WebMCP, so there is no statically known tool
			 * name for the AI SDK to type against.
			 */
			emit( {
				type: 'tool-input-available',
				toolCallId,
				toolName: call.name,
				input,
				dynamic: true,
			} );

			const reason = approvalReason(
				toolsByName.get( call.name ),
				input
			);
			if ( reason ) {
				const approvalId = nextId( 'approval' );
				emit( {
					type: 'tool-approval-request',
					approvalId,
					toolCallId,
					reason,
				} );

				const approved = await this.waitForApproval(
					approvalId,
					abortSignal
				);
				emit( {
					type: 'tool-approval-response',
					approvalId,
					approved,
				} );

				if ( ! approved ) {
					emit( { type: 'tool-output-denied', toolCallId } );
					onResponse( index, {
						id: call.id,
						name: call.name,
						response: {
							error: 'Not run: the user declined this action.',
						},
					} );
					continue;
				}
			}

			let result: WebMcpToolResult;
			try {
				result = await callToolWithLimits(
					call.name,
					input,
					abortSignal,
					toolsByName.get( call.name )?.timeoutMs
				);
			} catch ( error ) {
				if ( isAbort( error ) ) {
					onResponse( index, {
						id: call.id,
						name: call.name,
						response: {
							error: 'Stopped by the user while this was running, so it may or may not have taken effect.',
						},
					} );
				}
				throw error;
			}

			if ( result.isError ) {
				emit( {
					type: 'tool-output-error',
					toolCallId,
					errorText: result.text || 'The tool call failed.',
					dynamic: true,
				} );
			} else {
				emit( {
					type: 'tool-output-available',
					toolCallId,
					output: result.value,
					dynamic: true,
				} );
			}

			onResponse( index, {
				id: call.id,
				name: call.name,
				response: result.value,
			} );
		}
	}

	private async requestTurn(
		messages: WireMessage[],
		tools: unknown[],
		abortSignal: AbortSignal | undefined
	): Promise< TurnResponse > {
		const body = JSON.stringify( {
			messages,
			tools,
			context: this.getContext() || {},
			historyMode: this.historyMode,
		} );

		let response = await this.post( body, abortSignal );

		/*
		 * A REST nonce lasts a day at most, and an editor tab can stay open
		 * longer. Renew it once, the way core's own apiFetch middleware does,
		 * rather than failing every send until the page is reloaded.
		 */
		if ( await isExpiredNonce( response ) ) {
			if ( ! ( await this.renewNonce( abortSignal ) ) ) {
				throw new Error(
					'Your login session has expired. Reload the page, logging in again if asked, and resend your message.'
				);
			}
			response = await this.post( body, abortSignal );
		}

		if ( ! response.ok ) {
			throw new Error( await readErrorMessage( response ) );
		}

		const payload = ( await response.json() ) as TurnResponse;

		if ( payload?.historyMode ) {
			this.historyMode = payload.historyMode;
		}

		return payload;
	}

	private post(
		body: string,
		abortSignal: AbortSignal | undefined
	): Promise< Response > {
		return fetch( chatConfig.restUrl, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': this.nonce,
			},
			signal: abortSignal,
			body,
		} );
	}

	/** Fetch a fresh REST nonce; false when the login itself has expired. */
	private async renewNonce(
		abortSignal: AbortSignal | undefined
	): Promise< boolean > {
		if ( ! chatConfig.nonceUrl ) {
			return false;
		}
		try {
			const response = await fetch( chatConfig.nonceUrl, {
				credentials: 'same-origin',
				signal: abortSignal,
			} );
			const nonce = ( await response.text() ).trim();
			// Anything else, such as "0" for a logged-out user, is a failure.
			if ( ! response.ok || ! /^[a-f0-9]{10}$/.test( nonce ) ) {
				return false;
			}
			this.nonce = nonce;
			return true;
		} catch ( error ) {
			if ( isAbort( error ) ) {
				throw error;
			}
			return false;
		}
	}
}
