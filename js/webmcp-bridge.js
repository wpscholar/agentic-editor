/**
 * Bridge WordPress client-side abilities to the WebMCP Imperative API.
 *
 * @see https://developer.chrome.com/docs/ai/webmcp
 */

import { executeAbility, getAbility } from '@wordpress/abilities';
import { getModelContext } from '@agentic-editor/webmcp-polyfill';
import { rememberLocalTool } from '@agentic-editor/webmcp-tools';

/**
 * WebMCP tool names may include alphanumerics, _, -, and .
 * Convert ability names like "editor/get-editor-tree" → "editor_get-editor-tree".
 *
 * @param {string} abilityName
 * @return {string}
 */
export function toToolName( abilityName ) {
	return abilityName.replace( /\//g, '_' );
}

/**
 * @param {Object} [ability]
 * @return {{ readOnlyHint: boolean, untrustedContentHint?: boolean }|undefined}
 */
function toToolAnnotations( ability ) {
	const annotations = ability?.meta?.annotations;
	if ( ! annotations ) {
		return undefined;
	}

	// Only WebMCP-supported annotation keys (unknown keys can break registration).
	const hints = {
		readOnlyHint: !! annotations.readonly,
	};

	// Block content and patterns are written by other users, so an agent
	// should treat what these tools return as data, never as instructions.
	if ( ability.meta.agenticEditor?.untrustedContent ) {
		hints.untrustedContentHint = true;
	}

	return hints;
}

/**
 * @param {unknown} result
 * @return {{ content: Array<{ type: string, text: string }>, structuredContent?: Object }}
 */
function formatToolResult( result ) {
	if ( result === undefined ) {
		return { content: [ { type: 'text', text: '' } ] };
	}

	const text =
		typeof result === 'string' ? result : JSON.stringify( result, null, 2 );
	const formatted = { content: [ { type: 'text', text } ] };

	// structuredContent must be a JSON object, not an array or primitive.
	if (
		result !== null &&
		typeof result === 'object' &&
		! Array.isArray( result )
	) {
		formatted.structuredContent = result;
	}

	return formatted;
}

/**
 * Surface ability failures as tool errors the agent can read and retry from,
 * rather than rejecting the execute() call.
 *
 * @param {Partial<Error>} error
 * @return {{ content: Array<{ type: string, text: string }>, isError: true }}
 */
function formatToolError( error ) {
	return {
		content: [ { type: 'text', text: String( error?.message || error ) } ],
		isError: true,
	};
}

/**
 * Copy a JSON Schema, recursing into properties and items.
 *
 * @param {Object}  schema
 * @param {boolean} collapseNullableTypes Replace ['string','null'] with 'string'.
 * @return {Object|undefined}
 */
function normalizeSchema( schema, collapseNullableTypes ) {
	if ( ! schema || typeof schema !== 'object' ) {
		return undefined;
	}

	const normalized = { ...schema };

	if ( collapseNullableTypes && Array.isArray( normalized.type ) ) {
		const nonNull = normalized.type.filter( ( type ) => type !== 'null' );
		normalized.type = nonNull[ 0 ] || 'string';
	}

	if ( normalized.properties && typeof normalized.properties === 'object' ) {
		const properties = {};
		for ( const [ key, value ] of Object.entries(
			normalized.properties
		) ) {
			const property = normalizeSchema( value, collapseNullableTypes );
			if ( property ) {
				properties[ key ] = property;
			}
		}
		normalized.properties = properties;
	}

	if ( normalized.items ) {
		normalized.items =
			normalizeSchema( normalized.items, collapseNullableTypes ) ??
			normalized.items;
	}

	return normalized;
}

/**
 * Agent function-calling formats generally reject union types, so nullable
 * input types are collapsed to their first concrete type.
 *
 * @param {Object} [schema]
 * @return {Object}
 */
function toToolInputSchema( schema ) {
	const normalized = normalizeSchema( schema, true );
	if ( ! normalized || normalized.type !== 'object' ) {
		return { type: 'object', properties: {} };
	}

	if (
		! normalized.properties ||
		typeof normalized.properties !== 'object'
	) {
		normalized.properties = {};
	}

	return normalized;
}

/**
 * Output schemas are validated with plain JSON Schema, so nullable unions are
 * kept intact here.
 *
 * @param {Object} [schema]
 * @return {Object|undefined}
 */
function toToolOutputSchema( schema ) {
	const normalized = normalizeSchema( schema, false );
	if ( ! normalized || normalized.type !== 'object' ) {
		return undefined;
	}
	return normalized;
}

/**
 * @param {unknown} value
 * @return {value is number} Whether value is a finite number above zero.
 */
function isPositiveNumber( value ) {
	return typeof value === 'number' && Number.isFinite( value ) && value > 0;
}

/**
 * @param {Partial<Error>} error
 * @return {boolean}
 */
function isAlreadyRegisteredError( error ) {
	if ( error?.name === 'InvalidStateError' ) {
		return true;
	}
	// Only a message about the tool itself existing counts; any other
	// failure that happens to say "already" is a real failure.
	return /already (been )?(registered|exists)|already a tool/i.test(
		String( error?.message || error )
	);
}

/**
 * Register one ability as a page-lifetime WebMCP tool (no AbortSignal).
 *
 * @param {string}       abilityName
 * @param {ModelContext} modelContext
 * @return {Promise<boolean>}
 */
async function registerAbilityAsWebMCPTool( abilityName, modelContext ) {
	const ability = getAbility( abilityName );
	if ( ! ability ) {
		throw new Error( `Ability not found: ${ abilityName }` );
	}

	const tool = {
		name: toToolName( abilityName ),
		description: ability.description || ability.label || abilityName,
		inputSchema: toToolInputSchema( ability.input_schema ),
		execute: async ( input = {} ) => {
			try {
				const result = await executeAbility( abilityName, input || {} );
				return formatToolResult( result );
			} catch ( error ) {
				console.warn(
					`[agentic-editor] Ability failed: ${ abilityName }`,
					error
				);
				return formatToolError( error );
			}
		},
	};

	const optional = {};
	const outputSchema = toToolOutputSchema( ability.output_schema );
	if ( outputSchema ) {
		optional.outputSchema = outputSchema;
	}
	const annotations = toToolAnnotations( ability );
	if ( annotations ) {
		optional.annotations = annotations;
	}

	// Keep the executor around so consumers on this page (the chat panel) can
	// call the ability without depending on the optional executeTool() API.
	// The approval reason and timeout are for this page's own consumers only;
	// they are not WebMCP descriptor keys, so they never reach registerTool.
	const approval = ability.meta?.agenticEditor?.approval;
	const timeoutMs = ability.meta?.agenticEditor?.timeoutMs;
	const remember = () =>
		rememberLocalTool( {
			...tool,
			...optional,
			...( typeof approval === 'string' ? { approval } : {} ),
			...( isPositiveNumber( timeoutMs ) ? { timeoutMs } : {} ),
		} );

	try {
		await modelContext.registerTool( { ...tool, ...optional } );
	} catch ( error ) {
		// Already on the page from an earlier bootstrap: still usable, so
		// this page's consumers need its executor all the same.
		if ( isAlreadyRegisteredError( error ) ) {
			remember();
			throw error;
		}
		// Older WebMCP builds reject descriptor keys they do not know about;
		// a tool without hints beats no tool at all.
		try {
			await modelContext.registerTool( tool );
		} catch ( retryError ) {
			if ( isAlreadyRegisteredError( retryError ) ) {
				remember();
			}
			throw retryError;
		}
	}

	remember();
	return true;
}

/**
 * Bridge abilities to WebMCP.
 *
 * @param {string[]} abilityNames
 * @return {Promise<{ supported: boolean, registered: string[], skipped: string[], errors: Object[] }>}
 */
export async function bridgeAbilitiesToWebMCP( abilityNames ) {
	// The polyfill is a classic script, so it has run before any module and
	// there is nothing to wait for: no model context now means none at all.
	const modelContext = getModelContext();
	if ( ! modelContext?.registerTool ) {
		return {
			supported: false,
			registered: [],
			skipped: [ ...abilityNames ],
			errors: [],
		};
	}

	const registered = [];
	const skipped = [];
	const errors = [];

	for ( const name of abilityNames ) {
		try {
			await registerAbilityAsWebMCPTool( name, modelContext );
			registered.push( name );
		} catch ( error ) {
			// Already registered from a prior bootstrap attempt — treat as success.
			const message = String( error?.message || error );
			if ( isAlreadyRegisteredError( error ) ) {
				registered.push( name );
				continue;
			}

			console.warn(
				`[agentic-editor] Failed to register WebMCP tool for ${ name }:`,
				error
			);
			skipped.push( name );
			errors.push( { name, message } );
		}
	}

	return { supported: true, registered, skipped, errors };
}

/**
 * @return {boolean}
 */
export function isWebMCPSupported() {
	const modelContext = getModelContext();
	return !! ( modelContext && 'registerTool' in modelContext );
}
