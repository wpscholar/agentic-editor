/**
 * Helpers shared by every editor-abilities category module.
 */

import {
	getAbility,
	getAbilityCategory,
	registerAbility,
	registerAbilityCategory,
} from '@wordpress/abilities';

export const BLOCK_EDITOR_STORE = 'core/block-editor';
export const BLOCKS_STORE = 'core/blocks';
export const CORE_STORE = 'core';

/**
 * @return {Object} `wp.data`, checked to have `select` and `dispatch`.
 */
export function getData() {
	const { data } = window.wp || {};
	if ( ! data?.select || ! data?.dispatch ) {
		throw new Error(
			'WordPress data store is not available. Open this ability in the block editor.'
		);
	}
	return data;
}

/**
 * Anything backed by REST (patterns, media, terms) has to be awaited rather
 * than read: a plain select returns nothing until the resolver has finished.
 *
 * @return {(storeName: string) => Object} `wp.data.resolveSelect`.
 */
export function getResolveSelect() {
	const { resolveSelect } = getData();
	if ( typeof resolveSelect !== 'function' ) {
		throw new Error(
			'WordPress data resolvers are not available, so site content cannot be loaded.'
		);
	}
	return resolveSelect;
}

/**
 * @return {Object} `wp.blocks`, checked to have `createBlock` and `getBlockType`.
 */
export function getBlocksApi() {
	const { blocks } = window.wp || {};
	if ( ! blocks?.createBlock || ! blocks?.getBlockType ) {
		throw new Error( 'WordPress blocks API is not available.' );
	}
	return blocks;
}

/**
 * @param {unknown} value
 * @return {value is Record<string, unknown>} Whether value is a non-array object.
 */
export function isPlainObject( value ) {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

/**
 * @param {unknown} value
 * @return {string}
 */
function describeValue( value ) {
	if ( value === null ) {
		return 'null';
	}
	if ( Array.isArray( value ) ) {
		return 'an array';
	}
	return `a ${ typeof value }`;
}

const ATTRIBUTE_TYPE_CHECKS = {
	string: ( value ) => typeof value === 'string',
	'rich-text': ( value ) => typeof value === 'string',
	number: ( value ) => typeof value === 'number',
	integer: ( value ) => Number.isInteger( value ),
	boolean: ( value ) => typeof value === 'boolean',
	array: ( value ) => Array.isArray( value ),
	object: ( value ) => isPlainObject( value ),
	null: ( value ) => value === null,
};

/**
 * @param {string|string[]} type
 * @param {unknown}         value
 * @return {boolean}
 */
function matchesAttributeType( type, value ) {
	const types = Array.isArray( type ) ? type : [ type ];
	return types.some( ( name ) => {
		const check = ATTRIBUTE_TYPE_CHECKS[ name ];
		// An unfamiliar type keyword is not a reason to reject a value.
		return check ? check( value ) : true;
	} );
}

/**
 * Complete one item of a query-sourced attribute against its sub-schema.
 *
 * Defaults declared inside a `query` are only applied while parsing saved
 * markup, so attributes set programmatically arrive incomplete. A table cell
 * without its `tag` default renders as an undefined element and breaks the
 * block, so the defaults are filled in here.
 *
 * @param {unknown} item
 * @param {Object}  query Attribute sub-schema keyed by field.
 * @param {string}  path  Field path, used in error messages.
 * @return {Object}
 */
function normalizeQueryItem( item, query, path ) {
	if ( ! isPlainObject( item ) ) {
		throw new Error(
			`${ path } must be an object, received ${ describeValue( item ) }.`
		);
	}

	const unknown = Object.keys( item ).filter( ( key ) => ! ( key in query ) );
	if ( unknown.length ) {
		throw new Error(
			`${ path } has no field(s): ${ unknown.join(
				', '
			) }. Supported fields: ${ Object.keys( query ).join( ', ' ) }.`
		);
	}

	const normalized = {};
	for ( const [ key, schema ] of Object.entries( query ) ) {
		if ( item[ key ] === undefined ) {
			if ( schema?.default !== undefined ) {
				normalized[ key ] = schema.default;
			}
			continue;
		}
		normalized[ key ] = normalizeAttributeValue(
			item[ key ],
			schema,
			`${ path }.${ key }`
		);
	}
	return normalized;
}

/**
 * Validate one attribute value against its schema and complete nested rows.
 *
 * @param {unknown}          value
 * @param {Object|undefined} schema
 * @param {string}           path
 * @return {unknown}
 */
function normalizeAttributeValue( value, schema, path ) {
	if ( schema?.type && ! matchesAttributeType( schema.type, value ) ) {
		const expected = Array.isArray( schema.type )
			? schema.type.join( ' or ' )
			: schema.type;
		throw new Error(
			`${ path } must be of type ${ expected }, received ${ describeValue(
				value
			) }.`
		);
	}

	if ( schema?.query && Array.isArray( value ) ) {
		return value.map( ( item, index ) =>
			normalizeQueryItem( item, schema.query, `${ path }[${ index }]` )
		);
	}

	return value;
}

/**
 * Validate attribute keys and values against what the block type declares.
 *
 * @param {string} blockName
 * @param {Object} attributes
 * @return {Object}
 */
export function normalizeAttributes( blockName, attributes ) {
	const { getBlockType } = getBlocksApi();

	if ( ! isPlainObject( attributes ) ) {
		throw new Error( 'attributes must be an object.' );
	}

	// Unknown keys are stored but never serialized, so fail loudly with the
	// list the block actually accepts.
	const supported = getBlockType( blockName )?.attributes;
	if ( ! supported ) {
		return { ...attributes };
	}

	const keys = Object.keys( attributes );
	const unknown = keys.filter( ( key ) => ! ( key in supported ) );
	if ( unknown.length ) {
		throw new Error(
			`Block "${ blockName }" has no attribute(s): ${ unknown.join(
				', '
			) }. Supported attributes: ${ Object.keys( supported ).join(
				', '
			) }.`
		);
	}

	const normalized = {};
	for ( const key of keys ) {
		normalized[ key ] = normalizeAttributeValue(
			attributes[ key ],
			supported[ key ],
			key
		);
	}
	return normalized;
}

/**
 * Merge an attribute update into the block's current value.
 *
 * Plain objects merge key by key at every depth, so `{ style: { color } }`
 * keeps the block's existing typography and spacing; a nested `null` removes
 * that key. Anything else, arrays included, replaces the current value.
 *
 * @param {unknown} current
 * @param {unknown} update
 * @return {unknown}
 */
export function mergeAttributeValue( current, update ) {
	if ( ! isPlainObject( current ) || ! isPlainObject( update ) ) {
		return update;
	}

	const merged = { ...current };
	for ( const [ key, value ] of Object.entries( update ) ) {
		if ( value === null ) {
			delete merged[ key ];
			continue;
		}
		merged[ key ] = mergeAttributeValue( current[ key ], value );
	}
	return merged;
}

/**
 * Attributes the editor uses to protect blocks rather than to hold content,
 * with why an agent may not set them. Each of these is how a person locks
 * something, so letting an agent write one would let it undo that lock.
 */
const RESERVED_ATTRIBUTES = {
	metadata:
		"it holds editor bookkeeping, including a locked pattern's identity, and overwriting it can silently remove that pattern's lock",
	lock: 'it is the lock that controls whether the block can be moved or removed',
	templateLock:
		'it is the lock that controls whether what the block contains can be changed',
};

/**
 * Refuse attributes that would change a block's locks instead of its content.
 *
 * @param {Object} attributes
 * @param {string} [path]     Field path, used in the error message.
 */
export function assertNoReservedAttributes( attributes, path = 'attributes' ) {
	const reserved = Object.keys( attributes ).filter( ( key ) =>
		Object.hasOwn( RESERVED_ATTRIBUTES, key )
	);
	if ( ! reserved.length ) {
		return;
	}

	throw new Error(
		`${ reserved
			.map(
				( key ) =>
					`${ path }.${ key } cannot be set through this ability: ${ RESERVED_ATTRIBUTES[ key ] }.`
			)
			.join( ' ' ) } A person can change it from the editor instead.`
	);
}

/**
 * Attributes a block type marks as content: the only ones a person can edit
 * while the block is in "contentOnly" editing mode.
 *
 * @param {string} blockName
 * @return {string[]}
 */
export function getContentAttributeNames( blockName ) {
	const attributes = getBlocksApi().getBlockType( blockName )?.attributes;
	if ( ! attributes ) {
		return [];
	}

	// Read directly rather than through getBlockAttributesNamesByRole, which
	// logs a deprecation for every block still using __experimentalRole.
	return Object.keys( attributes ).filter(
		( key ) =>
			attributes[ key ]?.role === 'content' ||
			attributes[ key ]?.__experimentalRole === 'content'
	);
}

/**
 * Reject nesting the editor would refuse anyway, before anything is inserted.
 *
 * @param {string}    parentName
 * @param {string}    childName
 * @param {string}    path
 * @param {?string[]} ancestorNames Every block name above the child, parent
 *                                  included, or null when the destination is
 *                                  not known and `ancestor` cannot be judged.
 */
function assertNestingAllowed( parentName, childName, path, ancestorNames ) {
	const { getBlockType } = getBlocksApi();

	const allowedParents = getBlockType( childName )?.parent;
	if (
		Array.isArray( allowedParents ) &&
		! allowedParents.includes( parentName )
	) {
		throw new Error(
			`${ path }: "${ childName }" can only be nested inside ${ allowedParents.join(
				', '
			) }.`
		);
	}

	const requiredAncestors = getBlockType( childName )?.ancestor;
	if (
		ancestorNames &&
		Array.isArray( requiredAncestors ) &&
		! requiredAncestors.some( ( name ) => ancestorNames.includes( name ) )
	) {
		throw new Error(
			`${ path }: "${ childName }" can only be used somewhere inside ${ requiredAncestors.join(
				', '
			) }.`
		);
	}

	const allowedChildren = getBlockType( parentName )?.allowedBlocks;
	if (
		Array.isArray( allowedChildren ) &&
		! allowedChildren.includes( childName )
	) {
		throw new Error(
			`${ path }: "${ parentName }" only accepts ${ allowedChildren.join(
				', '
			) }.`
		);
	}
}

/**
 * Build a block and its descendants from a plain { name, attributes,
 * innerBlocks } spec.
 *
 * @param {Object}    spec
 * @param {string}    [path]          Field path prefix, used in error messages.
 * @param {?string}   [parentName]    Block name this spec is nested in.
 * @param {?string[]} [ancestorNames] Block names above this spec, outermost
 *                                    first. Null when the blocks have no
 *                                    destination yet (a pattern being saved),
 *                                    which skips `ancestor` checks rather than
 *                                    guessing where they will end up.
 * @return {Object}
 */
export function buildBlock(
	spec,
	path = '',
	parentName = null,
	ancestorNames = null
) {
	const { createBlock, getBlockType } = getBlocksApi();
	const field = ( key ) => ( path ? `${ path }.${ key }` : key );

	if ( ! isPlainObject( spec ) ) {
		throw new Error(
			`${ path || 'block' } must be an object with a block name.`
		);
	}
	if ( typeof spec.name !== 'string' || ! spec.name ) {
		throw new Error( `${ field( 'name' ) } must be a block name.` );
	}
	const name = spec.name;
	if ( ! getBlockType( name ) ) {
		throw new Error( `Block type is not registered: ${ name }` );
	}
	if ( parentName ) {
		assertNestingAllowed( parentName, name, path, ancestorNames );
	}

	if ( isPlainObject( spec.attributes ) ) {
		assertNoReservedAttributes( spec.attributes, field( 'attributes' ) );
	}

	const children = spec.innerBlocks ?? [];
	if ( ! Array.isArray( children ) ) {
		throw new Error(
			`${ field( 'innerBlocks' ) } must be an array of blocks.`
		);
	}

	return createBlock(
		name,
		normalizeAttributes( name, spec.attributes ?? {} ),
		children.map( ( child, index ) =>
			buildBlock(
				child,
				`${ field( 'innerBlocks' ) }[${ index }]`,
				name,
				ancestorNames ? [ ...ancestorNames, name ] : null
			)
		)
	);
}

/**
 * Children of a block, including the ones the block does not own.
 *
 * A synced pattern (core/block) or template part is an inner block controller:
 * its children belong to another entity, so getBlock() reports none and only
 * getBlocks() reaches them. Reading them through getBlock alone leaves the
 * whole contents of a synced pattern invisible.
 *
 * @param {Object} store Block editor store selectors.
 * @param {Object} block
 * @return {{ innerBlocks: Object[], controlled: boolean }}
 */
export function getInnerBlocks( store, block ) {
	if ( store?.areInnerBlocksControlled?.( block.clientId ) ) {
		return {
			innerBlocks: store.getBlocks( block.clientId ) || [],
			controlled: true,
		};
	}
	return { innerBlocks: block.innerBlocks || [], controlled: false };
}

/**
 * Every block nested inside a block, at any depth, including the contents of
 * synced patterns and template parts.
 *
 * @param {Object}       store         Block editor store selectors.
 * @param {Object}       block
 * @param {Set<unknown>} [visitedRefs] Pattern entities on the current path.
 * @return {number}
 */
export function countDescendants( store, block, visitedRefs = new Set() ) {
	const { innerBlocks, controlled } = getInnerBlocks( store, block );
	const childRefs = controlled
		? withControlledRef( block, visitedRefs )
		: visitedRefs;
	if ( childRefs === null ) {
		return 0;
	}
	return innerBlocks.reduce(
		( total, child ) =>
			total + 1 + countDescendants( store, child, childRefs ),
		0
	);
}

/**
 * Names of a location's block and everything above it, outermost first.
 *
 * @param {Object}  store        Block editor store selectors.
 * @param {?string} rootClientId Location, empty for the document root.
 * @return {string[]}
 */
export function getAncestorNames( store, rootClientId ) {
	if ( ! rootClientId ) {
		return [];
	}
	return [ ...( store.getBlockParents( rootClientId ) || [] ), rootClientId ]
		.map( ( clientId ) => store.getBlockName( clientId ) )
		.filter( Boolean );
}

/**
 * Extend the set of pattern entities on the current path, so a pattern that
 * references itself (directly or through another pattern) cannot loop forever.
 *
 * The set is copied rather than mutated: two instances of the same pattern
 * side by side are not a cycle, only one nested inside the other is.
 *
 * @param {Object}       block
 * @param {Set<unknown>} visitedRefs
 * @return {?Set<unknown>} Set for the children, or null when this entity repeats.
 */
export function withControlledRef( block, visitedRefs ) {
	const ref = block.attributes?.ref;
	if ( ref === undefined ) {
		return visitedRefs;
	}
	if ( visitedRefs.has( ref ) ) {
		return null;
	}
	return new Set( visitedRefs ).add( ref );
}

/**
 * Serialize a block without its subtree, for flat match lists.
 *
 * @param {Object} store Block editor store selectors.
 * @param {Object} block
 * @return {Object}
 */
export function summarizeBlock( store, block ) {
	const { innerBlocks, controlled } = getInnerBlocks( store, block );
	const summary = {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
		innerBlockCount: innerBlocks.length,
	};
	if ( controlled ) {
		summary.controlledInnerBlocks = true;
	}
	return summary;
}

/**
 * Resolve a client ID to a block, throwing when it is missing or unknown.
 *
 * @param {Object} store    Block editor store selectors.
 * @param {string} clientId
 * @param {string} [label]  Input field name, used in the error message.
 * @return {Object}
 */
export function requireBlock( store, clientId, label = 'clientId' ) {
	const block = clientId ? store.getBlock( clientId ) : null;
	if ( ! block ) {
		throw new Error( `Block not found for ${ label }: ${ clientId }` );
	}
	return block;
}

/**
 * The element a block renders in the editor canvas, when it has rendered.
 *
 * @param {string} clientId
 * @return {?Element}
 */
function findBlockElement( clientId ) {
	if ( typeof document === 'undefined' ) {
		return null;
	}
	const canvas = /** @type {?HTMLIFrameElement} */ (
		document.querySelector( 'iframe[name="editor-canvas"]' )
	);
	const selector = `[data-block="${ CSS.escape( clientId ) }"]`;
	return (
		canvas?.contentDocument?.querySelector( selector ) ??
		document.querySelector( selector )
	);
}

/**
 * A freshly inserted container has no list settings until the editor canvas
 * renders its InnerBlocks, a React pass that lags the data-store insert by a
 * render or two. Until then, canInsertBlockType(...) can't see the parent's
 * allowed-children rules and wrongly rejects every child. Wait for that
 * render rather than trusting a stale "no settings" read.
 *
 * @param {Object}  store        Block editor store selectors.
 * @param {?string} rootClientId Destination parent, empty for the root.
 * @param {number}  [timeoutMs]
 */
export async function waitForBlockListSettings(
	store,
	rootClientId,
	timeoutMs = 1000
) {
	if (
		! rootClientId ||
		store.getBlockListSettings( rootClientId ) !== undefined
	) {
		return;
	}

	// A block that has rendered without an inner block list is a leaf, or a
	// container still showing its placeholder. Neither will ever get list
	// settings on its own, so waiting would only delay the refusal. The list
	// renders in the same pass as its block, so a container never looks
	// like this.
	const element = findBlockElement( rootClientId );
	if (
		element &&
		! element.querySelector( '.block-editor-block-list__layout' )
	) {
		return;
	}

	const { subscribe } = getData();
	await new Promise( ( resolve ) => {
		const unsubscribe = subscribe( () => {
			if ( store.getBlockListSettings( rootClientId ) !== undefined ) {
				finish();
			}
		} );
		const timer = window.setTimeout( finish, timeoutMs );
		function finish() {
			window.clearTimeout( timer );
			unsubscribe();
			resolve( undefined );
		}
	} );
}

/**
 * Explain a structural refusal caused by locked editing, distinguishing it
 * from an ordinary nesting-rule refusal. Retrying an insert, move, or remove
 * against a locked location can never succeed until a person unlocks it in
 * the editor, so that has to be said plainly rather than left to another
 * attempt to discover.
 *
 * @param {Object}  store        Block editor store selectors.
 * @param {?string} rootClientId Destination parent, empty for the root.
 * @return {?string} A locked-specific reason, or null when this is not a lock.
 */
export function describeEditingLock( store, rootClientId ) {
	if (
		typeof store.getBlockEditingMode !== 'function' ||
		store.getBlockEditingMode( rootClientId || undefined ) !== 'disabled'
	) {
		return null;
	}

	// The lock is usually inherited from an inserted pattern instance higher
	// up the tree; name that pattern so there is something to go unlock.
	const chain = rootClientId
		? [ ...store.getBlockParents( rootClientId ), rootClientId ]
		: [];
	const patternAncestor = chain
		.map( ( id ) => store.getBlock( id ) )
		.find( ( candidate ) => candidate?.attributes?.metadata?.patternName );

	if ( patternAncestor ) {
		const label =
			patternAncestor.attributes.metadata.name ??
			patternAncestor.attributes.metadata.patternName;
		return `it is inside the "${ label }" pattern, which is locked to protect its layout: only its text and media can be edited here. A person can change its structure from the editor via that block's "Edit pattern" option (which affects every place the pattern is used), or by unlocking it first. Retrying will not succeed until then.`;
	}

	return 'this location has been locked against structural changes in the editor. A person needs to unlock it there before this can succeed; retrying will not help.';
}

/**
 * Select a block so a person watching the editor can see exactly which one a
 * refused request was about, instead of having to find it from a clientId in
 * an error message. Best-effort: selecting is a courtesy for the person
 * watching, and its failure must never mask the error about to be thrown.
 *
 * @param {?string} clientId Block to select.
 */
export async function trySelectBlock( clientId ) {
	if ( ! clientId ) {
		return;
	}
	try {
		await getData().dispatch( BLOCK_EDITOR_STORE ).selectBlock( clientId );
	} catch {
		// Selecting is a courtesy, not the point of the call.
	}
}

/**
 * Whether a block type may go at a location, as the editor's own inserter
 * would judge it.
 *
 * canInsertBlockType special-cases the default block type (core/paragraph) as
 * insertable almost anywhere, including inside a container the editor offers
 * no inserter for, so a lock is checked independently rather than trusted to
 * make it false. Call waitForBlockListSettings first for a fresh container.
 *
 * @param {Object}  store        Block editor store selectors.
 * @param {string}  name         Block name.
 * @param {?string} rootClientId Destination parent, empty for the root.
 * @return {boolean}
 */
export function canInsertAt( store, name, rootClientId ) {
	return (
		! describeEditingLock( store, rootClientId ) &&
		!! store.canInsertBlockType( name, rootClientId || undefined )
	);
}

/**
 * Check an optional index input.
 *
 * @param {unknown} index
 * @return {number|undefined}
 */
export function validateIndex( index ) {
	if ( index === undefined ) {
		return undefined;
	}
	if ( ! Number.isInteger( index ) ) {
		throw new Error( 'index must be an integer.' );
	}
	if ( /** @type {number} */ ( index ) < 0 ) {
		throw new Error( 'index must be zero or greater.' );
	}
	return /** @type {number} */ ( index );
}

/**
 * Where an insert lands, from `rootClientId`, `index`, and `afterClientId`.
 *
 * @param {Object}                                                             store Block editor store selectors.
 * @param {{ rootClientId?: string, index?: unknown, afterClientId?: string }} input
 * @return {{ rootClientId: string, index: number|undefined }} Index undefined means append.
 */
export function resolveInsertionPoint( store, input ) {
	let index = validateIndex( input.index );

	if ( input.rootClientId ) {
		requireBlock( store, input.rootClientId, 'rootClientId' );
	}

	let rootClientId = input.rootClientId || '';

	if ( input.afterClientId ) {
		requireBlock( store, input.afterClientId, 'afterClientId' );

		const afterRoot =
			store.getBlockRootClientId( input.afterClientId ) || '';
		if ( input.rootClientId && input.rootClientId !== afterRoot ) {
			throw new Error(
				'afterClientId is not a child of the provided rootClientId.'
			);
		}

		rootClientId = afterRoot;
		index = store.getBlockIndex( input.afterClientId ) + 1;
	}

	return { rootClientId, index };
}

/**
 * Ensure a block type is allowed at a location, with an actionable reason when
 * it is not.
 *
 * @param {Object}  store                  Block editor store selectors.
 * @param {string}  name                   Block name to insert.
 * @param {?string} rootClientId           Destination parent, empty for the root.
 * @param {?string} [selectOnLockClientId] Block to select on a lock refusal,
 *                                         when the caller has a more specific
 *                                         existing subject than the container
 *                                         itself (e.g. the block being
 *                                         transformed). Defaults to rootClientId.
 */
export async function assertCanInsert(
	store,
	name,
	rootClientId,
	selectOnLockClientId
) {
	await waitForBlockListSettings( store, rootClientId );

	// Checked before canInsertBlockType, not after: that selector special-cases
	// the default block type (core/paragraph) as insertable almost everywhere,
	// including inside a container whose editing mode is "disabled" — the
	// editor's own UI never offers an inserter there for any block type, so
	// trusting canInsertBlockType alone would let this ability do something a
	// person could never trigger by hand.
	const lockReason = describeEditingLock( store, rootClientId );
	if ( lockReason ) {
		await trySelectBlock( selectOnLockClientId || rootClientId );
		throw new Error(
			`Block type "${ name }" cannot be inserted here: ${ lockReason }`
		);
	}

	if ( store.canInsertBlockType( name, rootClientId || undefined ) ) {
		return;
	}

	// A container that is still empty renders a placeholder instead of an
	// inner block list, and the editor refuses every child until that list
	// exists. Point at the way out instead of just saying no.
	const parent = rootClientId ? store.getBlock( rootClientId ) : null;
	if (
		parent &&
		! getInnerBlocks( store, parent ).innerBlocks.length &&
		store.getBlockListSettings?.( rootClientId ) === undefined
	) {
		throw new Error(
			`Block type "${ name }" cannot be inserted into "${ parent.name }" because that block is empty and is showing its placeholder, so it accepts no children yet. Insert a new "${ parent.name }" with its children in a single call using innerBlocks, then remove the empty one.`
		);
	}

	throw new Error(
		`Block type "${ name }" cannot be inserted at the requested location.`
	);
}

/**
 * Ensure the block editor store is mounted.
 */
export function assertEditorReady() {
	const { select } = getData();
	if ( ! select( BLOCK_EDITOR_STORE ) ) {
		throw new Error(
			'Block editor store is not available. These abilities only work in the block editor.'
		);
	}
}

/**
 * Look up a registered block type, listing nothing useful if it is missing.
 *
 * @param {string} name
 * @return {Object}
 */
export function requireBlockType( name ) {
	const { getBlockType } = getBlocksApi();
	if ( typeof name !== 'string' || ! name ) {
		throw new Error( 'name must be a block name (e.g. core/paragraph).' );
	}
	const blockType = getBlockType( name );
	if ( ! blockType ) {
		throw new Error(
			`Block type is not registered: ${ name }. Use editor/get-block-types to list what this site has.`
		);
	}
	return blockType;
}

/**
 * The category every ability in this plugin is filed under.
 */
export const ABILITY_CATEGORY = {
	slug: 'block-editor',
	label: 'Block Editor',
	description:
		'Abilities for inspecting and modifying the WordPress block editor.',
};

/**
 * Register abilities, and their category, unless they already exist.
 *
 * Registering an existing ability throws, which would abort a second bootstrap,
 * so each one is checked first.
 *
 * @param {Object[]} abilities Ability definitions.
 * @return {string[]} Names of the abilities, in order.
 */
export function registerAbilities( abilities ) {
	if ( ! getAbilityCategory( ABILITY_CATEGORY.slug ) ) {
		registerAbilityCategory( ABILITY_CATEGORY.slug, {
			label: ABILITY_CATEGORY.label,
			description: ABILITY_CATEGORY.description,
		} );
	}

	for ( const ability of abilities ) {
		if ( ! getAbility( ability.name ) ) {
			registerAbility( ability );
		}
	}

	return abilities.map( ( ability ) => ability.name );
}
