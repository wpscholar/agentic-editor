/**
 * Consumer side of WebMCP: list the tools the current page offers and call them.
 *
 * Two paths exist because the producer-preview execution API is not guaranteed:
 *
 * 1. Tools this plugin registered are kept here with their executors, so they
 *    can be called directly no matter what the browser implements.
 * 2. Everything else is discovered with `getTools()` and called through
 *    `executeTool()`, which the polyfill always provides and native Chrome
 *    provides as an optional extension.
 *
 * Nothing here knows about the chat, the block editor, or WordPress, so any
 * page that loads this module gets a working tool layer.
 */

import { getModelContext } from '@agentic-editor/webmcp-polyfill';

/** @type {Map<string, Object>} */
const localTools = new Map();

/** @type {Set<() => void>} */
const changeListeners = new Set();

let listeningForToolChange = false;

/**
 * Record a tool this page registered, along with the function that runs it.
 *
 * @param {Object}                             descriptor               Tool descriptor as passed to registerTool.
 * @param {string}                             descriptor.name          Tool name.
 * @param {string}                             [descriptor.description]
 * @param {Object}                             [descriptor.inputSchema]
 * @param {Object}                             [descriptor.annotations]
 * @param {string}                             [descriptor.approval]    Why a person must approve each call.
 * @param {number}                             [descriptor.timeoutMs]   How long a consumer should wait for a call.
 * @param {(input: Object) => Promise<Object>} descriptor.execute       Executor.
 */
export function rememberLocalTool( descriptor ) {
	if ( ! descriptor?.name || typeof descriptor.execute !== 'function' ) {
		return;
	}
	localTools.set( descriptor.name, descriptor );
	notifyToolsChanged();
}

/**
 * Subscribe to tool set changes.
 *
 * @param {() => void} listener Called with no arguments when the tool set changes.
 * @return {() => void} Unsubscribe.
 */
export function onToolsChanged( listener ) {
	changeListeners.add( listener );
	startListeningForToolChange();
	return () => changeListeners.delete( listener );
}

function notifyToolsChanged() {
	for ( const listener of changeListeners ) {
		try {
			listener();
		} catch ( error ) {
			console.warn(
				'[agentic-editor] Tool change listener failed:',
				error
			);
		}
	}
}

function startListeningForToolChange() {
	if ( listeningForToolChange ) {
		return;
	}
	const modelContext = getModelContext();
	if ( typeof modelContext?.addEventListener !== 'function' ) {
		return;
	}
	listeningForToolChange = true;
	modelContext.addEventListener( 'toolchange', notifyToolsChanged );
}

/**
 * `getTools()` serializes input schemas as JSON strings.
 *
 * @param {unknown} inputSchema
 * @return {Object|undefined}
 */
function parseInputSchema( inputSchema ) {
	if ( ! inputSchema ) {
		return undefined;
	}
	if ( typeof inputSchema === 'object' ) {
		return inputSchema;
	}
	try {
		const parsed = JSON.parse( String( inputSchema ) );
		return parsed && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {Object} tool
 * @param {string} source
 * @return {{ name: string, description: string, inputSchema: Object|undefined, annotations: Object|undefined, source: string, approval?: string, timeoutMs?: number }}
 */
function normalizeTool( tool, source ) {
	const normalized = {
		name: tool.name,
		description: tool.description || tool.title || tool.name,
		inputSchema: parseInputSchema( tool.inputSchema ),
		annotations: tool.annotations,
		source,
	};

	// Only this page's own tools may say why they need approval; a tool from
	// another script is never taken at its word.
	if ( source === 'local' && typeof tool.approval === 'string' ) {
		normalized.approval = tool.approval;
	}

	// Likewise only this page's own tools may ask to be waited on for longer.
	if (
		source === 'local' &&
		typeof tool.timeoutMs === 'number' &&
		Number.isFinite( tool.timeoutMs ) &&
		tool.timeoutMs > 0
	) {
		normalized.timeoutMs = tool.timeoutMs;
	}

	return normalized;
}

/**
 * Every tool available on this page.
 *
 * @return {Promise<Array<Object>>}
 */
export async function listTools() {
	startListeningForToolChange();

	const tools = new Map();

	for ( const descriptor of localTools.values() ) {
		tools.set( descriptor.name, normalizeTool( descriptor, 'local' ) );
	}

	const modelContext = getModelContext();
	if ( typeof modelContext?.getTools === 'function' ) {
		try {
			const discovered = await modelContext.getTools();
			for ( const tool of discovered || [] ) {
				if ( tool?.name && ! tools.has( tool.name ) ) {
					tools.set( tool.name, normalizeTool( tool, 'webmcp' ) );
				}
			}
		} catch ( error ) {
			console.warn(
				'[agentic-editor] Could not list WebMCP tools:',
				error
			);
		}
	}

	return [ ...tools.values() ].sort( ( a, b ) =>
		a.name.localeCompare( b.name )
	);
}

/**
 * Reduce a tool result to what is worth sending back to the model.
 *
 * WebMCP results are `{ content: [...], structuredContent?, isError? }`. The
 * structured form is preferred when present because it round-trips as JSON;
 * otherwise the text blocks are concatenated.
 *
 * @param {unknown} raw
 * @return {{ isError: boolean, value: unknown, text: string }}
 */
function normalizeToolResult( raw ) {
	if ( raw === null || raw === undefined ) {
		return { isError: false, value: null, text: '' };
	}

	const result =
		/** @type {{ content?: unknown, isError?: boolean, structuredContent?: unknown }} */ (
			raw
		);

	if ( typeof raw !== 'object' || ! Array.isArray( result.content ) ) {
		return {
			isError: false,
			value: raw,
			text: typeof raw === 'string' ? raw : JSON.stringify( raw ),
		};
	}

	const textBlocks = result.content.filter(
		( block ) => block?.type === 'text'
	);
	const text = textBlocks.map( ( block ) => block.text ).join( '\n' );

	let value = result.structuredContent;
	if ( value === undefined ) {
		/*
		 * structuredContent can only be an object, so a tool returning an
		 * array or a number sends it as JSON text. Parse it back, so the model
		 * gets the same structured value an object result would.
		 */
		value = textBlocks.length === 1 ? parseMaybeJson( text ) : text;
	}

	return {
		isError: !! result.isError,
		value,
		text,
	};
}

/**
 * Find the `getTools()` record for a name, needed by `executeTool()`.
 *
 * @param {string} name
 * @return {Promise<Object|null>}
 */
async function findRemoteTool( name ) {
	const modelContext = getModelContext();
	if ( typeof modelContext?.getTools !== 'function' ) {
		return null;
	}
	const tools = await modelContext.getTools();
	return ( tools || [] ).find( ( tool ) => tool?.name === name ) || null;
}

/**
 * Whether the page is known not to have a tool, from whichever listing the
 * browser offers. False when there is no way to tell.
 *
 * @param {string} name
 * @return {Promise<boolean>}
 */
async function isKnownMissing( name ) {
	const modelContext = getModelContext();
	const testing =
		typeof navigator !== 'undefined' ? navigator.modelContextTesting : null;

	let tools = null;
	if ( typeof modelContext?.getTools === 'function' ) {
		tools = await modelContext.getTools();
	} else if ( typeof testing?.listTools === 'function' ) {
		tools = await testing.listTools();
	}

	return (
		Array.isArray( tools ) &&
		! tools.some( ( tool ) => tool?.name === name )
	);
}

/**
 * Run a tool by name.
 *
 * Tool failures are returned rather than thrown, since a failed call is
 * something the model should see and be able to correct.
 *
 * @param {string} name Tool name.
 * @param {Object} args Arguments.
 * @return {Promise<{ isError: boolean, value: unknown, text: string }>}
 */
export async function callTool( name, args = {} ) {
	const local = localTools.get( name );
	if ( local ) {
		try {
			return normalizeToolResult( await local.execute( args ) );
		} catch ( error ) {
			return toolFailure( error );
		}
	}

	try {
		// A name the model made up is reported as such, whatever this
		// browser can or cannot execute.
		if ( await isKnownMissing( name ) ) {
			return toolFailure( new Error( `Unknown tool: ${ name }` ) );
		}

		const modelContext = getModelContext();
		if ( typeof modelContext?.executeTool === 'function' ) {
			const tool = await findRemoteTool( name );
			if ( ! tool ) {
				return toolFailure( new Error( `Unknown tool: ${ name }` ) );
			}
			const serialized = await modelContext.executeTool(
				tool,
				JSON.stringify( args ?? {} )
			);
			return normalizeToolResult( parseMaybeJson( serialized ) );
		}

		const testing =
			typeof navigator !== 'undefined'
				? navigator.modelContextTesting
				: null;
		if ( typeof testing?.executeTool === 'function' ) {
			const serialized = await testing.executeTool(
				name,
				JSON.stringify( args ?? {} )
			);
			return normalizeToolResult( parseMaybeJson( serialized ) );
		}
	} catch ( error ) {
		return toolFailure( error );
	}

	return toolFailure(
		new Error(
			`This browser cannot execute WebMCP tools, so ${ name } was not run.`
		)
	);
}

/**
 * @param {unknown} value
 * @return {unknown}
 */
function parseMaybeJson( value ) {
	if ( typeof value !== 'string' ) {
		return value;
	}
	try {
		return JSON.parse( value );
	} catch {
		return value;
	}
}

/**
 * @param {Partial<Error>} error
 * @return {{ isError: true, value: { error: string }, text: string }}
 */
function toolFailure( error ) {
	const message = String( error?.message || error );
	return { isError: true, value: { error: message }, text: message };
}
