/**
 * Pattern abilities: listing, reading, inserting, and saving block patterns.
 */

import {
	ABILITY_CATEGORY,
	BLOCK_EDITOR_STORE,
	CORE_STORE,
	assertCanInsert,
	assertEditorReady,
	buildBlock,
	canInsertAt,
	describeEditingLock,
	getBlocksApi,
	getData,
	getResolveSelect,
	registerAbilities,
	requireBlock,
	requireBlockType,
	resolveInsertionPoint,
	summarizeBlock,
	trySelectBlock,
	waitForBlockListSettings,
} from '@agentic-editor/abilities/shared';

const PATTERN_POST_TYPE = 'wp_block';
const PATTERN_TAXONOMY = 'wp_pattern_category';
const PATTERN_BLOCK_NAME = 'core/block';
// Core names user patterns after the block that references them, so a name
// from these abilities is the same name the editor uses internally.
const USER_PATTERN_PREFIX = 'core/block/';

/**
 * @return {{ parse: (html: string, options?: Object) => Object[], serialize: (blocks: Object[]) => string }}
 */
function getBlockMarkupApi() {
	const blocks = getBlocksApi();
	if (
		typeof blocks.parse !== 'function' ||
		typeof blocks.serialize !== 'function'
	) {
		throw new Error(
			'WordPress block markup API is not available, so patterns cannot be read or written.'
		);
	}
	return blocks;
}

/**
 * Parse pattern markup into blocks that are not yet in the document.
 *
 * @param {Object} pattern
 * @return {Object[]}
 */
function parsePatternContent( pattern ) {
	const { parse } = getBlockMarkupApi();
	const blocks =
		parse( pattern.content ?? '', {
			__unstableSkipMigrationLogs: true,
		} ) || [];
	return blocks.filter( ( block ) => block?.name );
}

/**
 * @param {Object[]} blocks
 * @return {number} Blocks at every level, not just the top one.
 */
function countPatternBlocks( blocks ) {
	return blocks.reduce(
		( total, block ) =>
			total + 1 + countPatternBlocks( block.innerBlocks || [] ),
		0
	);
}

/**
 * Serialize a parsed pattern block in the shape editor/insert-block accepts.
 *
 * Client IDs are deliberately left out: these blocks are not in the document,
 * so reporting an ID would invite an edit call that cannot resolve it.
 *
 * @param {Object} block
 * @param {number} [maxDepth]
 * @param {number} [depth]
 * @return {Object}
 */
function serializePatternBlock( block, maxDepth = Infinity, depth = 0 ) {
	const innerBlocks = block.innerBlocks || [];
	const node = {
		name: block.name,
		attributes: block.attributes ?? {},
	};

	if ( depth >= maxDepth ) {
		node.innerBlocks = [];
		node.truncatedInnerBlockCount = innerBlocks.length;
		return node;
	}

	node.innerBlocks = innerBlocks.map( ( innerBlock ) =>
		serializePatternBlock( innerBlock, maxDepth, depth + 1 )
	);
	return node;
}

/**
 * Patterns registered by core, the theme, and plugins, read over REST.
 *
 * @return {Promise<Object[]>}
 */
async function loadRegisteredPatterns() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getBlockPatterns !== 'function' ) {
		return [];
	}
	return ( await core.getBlockPatterns() ) || [];
}

/**
 * User patterns, which are wp_block posts.
 *
 * Raw content needs the edit context, and an account without access to it gets
 * nothing back. That is reported as "no user patterns" rather than an error, so
 * the registered ones stay usable.
 *
 * @return {Promise<Object[]>}
 */
async function loadUserPatternRecords() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getEntityRecords !== 'function' ) {
		return [];
	}
	try {
		return (
			( await core.getEntityRecords( 'postType', PATTERN_POST_TYPE, {
				per_page: -1,
				context: 'edit',
			} ) ) || []
		);
	} catch {
		return [];
	}
}

/**
 * wp_pattern_category terms, which is where user pattern categories live.
 *
 * @return {Promise<Object[]>}
 */
async function loadPatternCategoryTerms() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getEntityRecords !== 'function' ) {
		return [];
	}
	try {
		return (
			( await core.getEntityRecords( 'taxonomy', PATTERN_TAXONOMY, {
				per_page: -1,
				hide_empty: false,
			} ) ) || []
		);
	} catch {
		return [];
	}
}

/**
 * @param {Object} pattern Registered pattern, as returned by REST.
 * @return {Object}
 */
function normalizeRegisteredPattern( pattern ) {
	return {
		name: pattern.name,
		title: pattern.title ?? pattern.name,
		description: pattern.description ?? '',
		source: pattern.source ?? null,
		isUserPattern: false,
		id: null,
		syncStatus: null,
		categories: pattern.categories ?? [],
		blockTypes: pattern.blockTypes ?? [],
		inserter: pattern.inserter !== false,
		content: pattern.content ?? '',
	};
}

/**
 * @param {Object}             record            A wp_block post.
 * @param {Map<number,string>} categorySlugsById
 * @return {Object}
 */
function normalizeUserPattern( record, categorySlugsById ) {
	const syncStatus =
		record.wp_pattern_sync_status ??
		record.meta?.wp_pattern_sync_status ??
		'';

	return {
		name: `${ USER_PATTERN_PREFIX }${ record.id }`,
		title: record.title?.raw ?? record.title?.rendered ?? '',
		description: '',
		source: 'user',
		isUserPattern: true,
		id: record.id,
		// Core stores an empty sync status for a fully synced pattern and only
		// writes the meta for unsynced ones.
		syncStatus: syncStatus === 'unsynced' ? 'unsynced' : 'synced',
		categories: ( record.wp_pattern_category ?? [] ).map(
			( termId ) => categorySlugsById.get( termId ) ?? String( termId )
		),
		blockTypes: [],
		inserter: true,
		// Only the raw markup holds block comments. The rendered form is
		// front-end HTML, which would parse as a single freeform block.
		content: record.content?.raw ?? '',
	};
}

/**
 * Every pattern this editor can use, from both sources, in one shape.
 *
 * @return {Promise<Object[]>}
 */
async function loadPatterns() {
	const [ registered, records, terms ] = await Promise.all( [
		loadRegisteredPatterns(),
		loadUserPatternRecords(),
		loadPatternCategoryTerms(),
	] );

	const categorySlugsById = new Map(
		terms.map( ( term ) => [ term.id, term.slug ] )
	);

	return [
		...records.map( ( record ) =>
			normalizeUserPattern( record, categorySlugsById )
		),
		...registered.map( normalizeRegisteredPattern ),
	];
}

// Parsing is the expensive part of listing patterns, and a block theme can
// ship dozens, so the shape of each one is kept until its markup changes.
const patternStructureCache = new Map();

/**
 * @param {Object} pattern
 * @return {{ blockCount: number, rootBlockNames: string[] }}
 */
function getPatternStructure( pattern ) {
	const cached = patternStructureCache.get( pattern.name );
	if ( cached && cached.content === pattern.content ) {
		return cached.structure;
	}

	const blocks = parsePatternContent( pattern );
	const structure = {
		blockCount: countPatternBlocks( blocks ),
		rootBlockNames: blocks.map( ( block ) => block.name ),
	};
	patternStructureCache.set( pattern.name, {
		content: pattern.content,
		structure,
	} );
	return structure;
}

/**
 * Describe a pattern without its markup, for list results.
 *
 * @param {Object} pattern
 * @return {Object}
 */
function summarizePattern( pattern ) {
	const { blockCount, rootBlockNames } = getPatternStructure( pattern );
	const summary = {
		name: pattern.name,
		title: pattern.title,
		description: pattern.description,
		source: pattern.source,
		isUserPattern: pattern.isUserPattern,
		syncStatus: pattern.syncStatus,
		categories: pattern.categories,
		blockCount,
		rootBlockNames,
	};

	if ( pattern.blockTypes.length ) {
		summary.blockTypes = pattern.blockTypes;
	}

	return summary;
}

/**
 * One user pattern by post ID, without loading every other one.
 *
 * @param {string} id Post ID, as it appears in the pattern name.
 * @return {Promise<?Object>} Null when there is no such pattern.
 */
async function loadUserPattern( id ) {
	if ( ! /^\d+$/.test( id ) ) {
		return null;
	}
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.getEntityRecord !== 'function' ) {
		return null;
	}

	let record;
	try {
		record = await core.getEntityRecord(
			'postType',
			PATTERN_POST_TYPE,
			Number( id ),
			{ context: 'edit' }
		);
	} catch {
		return null;
	}
	if ( ! record?.id ) {
		return null;
	}

	const terms = record.wp_pattern_category?.length
		? await loadPatternCategoryTerms()
		: [];
	return normalizeUserPattern(
		record,
		new Map( terms.map( ( term ) => [ term.id, term.slug ] ) )
	);
}

/**
 * @param {string} name
 * @return {Promise<Object>}
 */
async function requirePattern( name ) {
	if ( typeof name !== 'string' || ! name ) {
		throw new Error(
			'name must be a pattern name from editor/get-patterns.'
		);
	}

	const pattern = name.startsWith( USER_PATTERN_PREFIX )
		? await loadUserPattern( name.slice( USER_PATTERN_PREFIX.length ) )
		: ( await loadRegisteredPatterns() )
				.map( normalizeRegisteredPattern )
				.find( ( candidate ) => candidate.name === name );
	if ( ! pattern ) {
		throw new Error(
			`Pattern not found: ${ name }. Use editor/get-patterns to list what this site has.`
		);
	}
	return pattern;
}

/**
 * Pattern categories from both sources, keyed by slug. A category only has a
 * term id once something has been filed under it.
 *
 * @return {Promise<Object[]>}
 */
async function listPatternCategories() {
	const core = getResolveSelect()( CORE_STORE );
	const [ registered, terms ] = await Promise.all( [
		typeof core?.getBlockPatternCategories === 'function'
			? core.getBlockPatternCategories()
			: [],
		loadPatternCategoryTerms(),
	] );

	const bySlug = new Map();
	for ( const category of registered || [] ) {
		bySlug.set( category.name, {
			name: category.name,
			label: category.label ?? category.name,
			description: category.description ?? '',
			id: null,
			registered: true,
		} );
	}
	for ( const term of terms ) {
		const existing = bySlug.get( term.slug );
		bySlug.set( term.slug, {
			name: term.slug,
			label: term.name ?? existing?.label ?? term.slug,
			description: term.description ?? existing?.description ?? '',
			id: term.id,
			registered: existing?.registered ?? false,
		} );
	}

	return [ ...bySlug.values() ].sort( ( a, b ) =>
		a.name.localeCompare( b.name )
	);
}

/**
 * Turn category names into the term ids wp_pattern_category stores, creating
 * the term when it does not exist yet. The editor does the same: a category a
 * theme declared has no term until a pattern is filed under it.
 *
 * A name given twice, or by both its slug and its label, is filed once. If a
 * term cannot be created, the ones this call already created are deleted.
 *
 * @param {string[]} [names]
 * @return {Promise<{ ids: number[], slugs: string[], created: string[], createdIds: number[] }>}
 */
async function resolvePatternCategoryIds( names ) {
	const resolved = { ids: [], slugs: [], created: [], createdIds: [] };
	if ( ! names?.length ) {
		return resolved;
	}

	for ( const requested of names ) {
		if ( typeof requested !== 'string' || ! requested.trim() ) {
			throw new Error(
				'categories must be a list of pattern category names.'
			);
		}
	}

	const { dispatch } = getData();
	const categories = await listPatternCategories();
	const seen = new Set();

	try {
		for ( const requested of names ) {
			const needle = requested.trim().toLowerCase();
			const match = categories.find(
				( category ) =>
					category.name.toLowerCase() === needle ||
					category.label.toLowerCase() === needle
			);

			const key = match?.name ?? needle;
			if ( seen.has( key ) ) {
				continue;
			}
			seen.add( key );

			if ( match?.id ) {
				resolved.ids.push( match.id );
				resolved.slugs.push( match.name );
				continue;
			}

			const term = await dispatch( CORE_STORE ).saveEntityRecord(
				'taxonomy',
				PATTERN_TAXONOMY,
				{ name: match?.label ?? requested.trim(), slug: match?.name },
				{ throwOnError: true }
			);
			if ( ! term?.id ) {
				throw new Error(
					`Could not create the pattern category "${ requested }".`
				);
			}

			const slug = term.slug ?? requested;
			resolved.ids.push( term.id );
			resolved.slugs.push( slug );
			resolved.created.push( slug );
			resolved.createdIds.push( term.id );
		}
	} catch ( error ) {
		await deletePatternCategories( resolved.createdIds );
		throw error;
	}

	return resolved;
}

/**
 * Delete category terms this plugin created, when the save they were for
 * failed. Best-effort: a failed clean-up must not hide the original error.
 *
 * @param {number[]} ids
 */
async function deletePatternCategories( ids ) {
	const { dispatch } = getData();
	for ( const id of ids ) {
		try {
			await dispatch( CORE_STORE ).deleteEntityRecord(
				'taxonomy',
				PATTERN_TAXONOMY,
				id,
				{ force: true }
			);
		} catch {
			// Nothing more to do; the term is merely left unused.
		}
	}
}

/**
 * Refuse a save the REST API would refuse anyway, with a readable reason.
 */
async function assertCanCreatePatterns() {
	const core = getResolveSelect()( CORE_STORE );
	if ( typeof core?.canUser !== 'function' ) {
		return;
	}

	let allowed;
	try {
		allowed = await core.canUser( 'create', {
			kind: 'postType',
			name: PATTERN_POST_TYPE,
		} );
	} catch {
		// A check that cannot run is not a refusal; let the save report it.
		return;
	}

	if ( allowed === false ) {
		throw new Error(
			'This account is not allowed to create patterns on this site.'
		);
	}
}

/**
 * Ensure a set of blocks is one unbroken run of siblings, which is what
 * replacing them with a single block requires.
 *
 * @param {Object}   store     Block editor store selectors.
 * @param {string[]} clientIds
 * @return {{ rootClientId: string, index: number, clientIds: string[] }}
 */
function requireSiblingRange( store, clientIds ) {
	const rootClientId = store.getBlockRootClientId( clientIds[ 0 ] ) || '';

	const positions = clientIds.map( ( clientId ) => {
		if (
			( store.getBlockRootClientId( clientId ) || '' ) !== rootClientId
		) {
			throw new Error(
				'Every clientId must have the same parent to be replaced by one block.'
			);
		}
		return { clientId, index: store.getBlockIndex( clientId ) };
	} );

	positions.sort( ( a, b ) => a.index - b.index );

	const contiguous = positions.every(
		( position, offset ) =>
			offset === 0 || position.index === positions[ offset - 1 ].index + 1
	);
	if ( ! contiguous ) {
		throw new Error(
			'The blocks to replace must sit next to each other, with nothing else between them.'
		);
	}

	return {
		rootClientId,
		index: positions[ 0 ].index,
		clientIds: positions.map( ( position ) => position.clientId ),
	};
}

/**
 * Ensure a run of sibling blocks can be swapped for a pattern reference.
 *
 * replaceBlocks checks only that the replacement may be inserted, not that the
 * originals may be removed, so a remove lock has to be checked here.
 *
 * @param {Object}                                        store        Block editor store selectors.
 * @param {{ rootClientId: string, clientIds: string[] }} siblingRange
 */
async function assertCanReplace( store, siblingRange ) {
	const { rootClientId, clientIds } = siblingRange;

	if ( store.canRemoveBlocks?.( clientIds ) === false ) {
		await trySelectBlock( clientIds[ 0 ] );
		const lockReason = describeEditingLock( store, rootClientId );
		throw new Error(
			lockReason
				? `These blocks cannot be replaced by the pattern: ${ lockReason }`
				: 'These blocks cannot be replaced by the pattern, because at least one of them is locked against removal. Save the pattern without replaceSource, or unlock the blocks in the editor first.'
		);
	}

	requireBlockType( PATTERN_BLOCK_NAME );
	await assertCanInsert(
		store,
		PATTERN_BLOCK_NAME,
		rootClientId,
		clientIds[ 0 ]
	);
}

/** @type {Object} */
const getPatternsAbility = {
	name: 'editor/get-patterns',
	label: 'Get Patterns',
	description:
		'Lists the block patterns available in this editor, from the theme, plugins, core, and the patterns saved on this site. Use this to find a ready-made layout before building one block by block.',
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {
			search: {
				type: 'string',
				description:
					'Text to match against the pattern title, name, description, and categories, case-insensitively.',
			},
			category: {
				type: 'string',
				description:
					'Pattern category slug to match (e.g. header, gallery). Use editor/get-pattern-categories to list them.',
			},
			blockTypes: {
				type: 'array',
				description:
					'Only list patterns that declare one of these block types as their intended context.',
				items: { type: 'string' },
			},
			source: {
				type: 'string',
				description:
					'Only list patterns from this source: user for patterns saved on this site, otherwise the registered source such as theme, plugin, core, or pattern-directory.',
			},
			syncStatus: {
				type: 'string',
				enum: [ 'synced', 'unsynced' ],
				description:
					'Only list patterns saved on this site with this sync status.',
			},
			rootClientId: {
				type: 'string',
				description:
					'Only list patterns whose top-level blocks can all be inserted inside this block.',
			},
			includeHidden: {
				type: 'boolean',
				description:
					'Include patterns their author hid from the inserter.',
			},
		},
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			patterns: {
				type: 'array',
				description: 'Matching patterns, without their block markup.',
			},
			count: { type: 'integer' },
			totalCount: {
				type: 'integer',
				description: 'Patterns available before filtering.',
			},
		},
		required: [ 'patterns', 'count', 'totalCount' ],
	},
	meta: {
		agenticEditor: { untrustedContent: true },
		annotations: {
			readonly: true,
			destructive: false,
			idempotent: true,
		},
	},
	callback: async ( input = {} ) => {
		assertEditorReady();
		const { select } = getData();
		const store = select( BLOCK_EDITOR_STORE );

		if ( input.rootClientId ) {
			requireBlock( store, input.rootClientId, 'rootClientId' );
		}
		if ( input.blockTypes && ! Array.isArray( input.blockTypes ) ) {
			throw new Error( 'blockTypes must be an array of block names.' );
		}

		const all = await loadPatterns();
		const needle = input.search?.toLowerCase();

		if ( input.rootClientId ) {
			await waitForBlockListSettings( store, input.rootClientId );
		}

		const matches = all
			.filter( ( pattern ) => {
				if ( ! input.includeHidden && ! pattern.inserter ) {
					return false;
				}
				if (
					input.source &&
					pattern.source !== input.source &&
					! pattern.source?.startsWith( `${ input.source }/` )
				) {
					return false;
				}
				if (
					input.syncStatus &&
					pattern.syncStatus !== input.syncStatus
				) {
					return false;
				}
				if (
					input.category &&
					! pattern.categories.includes( input.category )
				) {
					return false;
				}
				if (
					input.blockTypes?.length &&
					! input.blockTypes.some( ( blockType ) =>
						pattern.blockTypes.includes( blockType )
					)
				) {
					return false;
				}
				if ( needle ) {
					const haystack = [
						pattern.name,
						pattern.title,
						pattern.description,
						...pattern.categories,
					]
						.join( ' ' )
						.toLowerCase();
					if ( ! haystack.includes( needle ) ) {
						return false;
					}
				}
				if ( input.rootClientId ) {
					const { rootBlockNames } = getPatternStructure( pattern );
					const fits =
						rootBlockNames.length &&
						rootBlockNames.every( ( blockName ) =>
							canInsertAt( store, blockName, input.rootClientId )
						);
					if ( ! fits ) {
						return false;
					}
				}
				return true;
			} )
			.map( summarizePattern )
			.sort( ( a, b ) => a.title.localeCompare( b.title ) );

		return {
			patterns: matches,
			count: matches.length,
			totalCount: all.length,
		};
	},
};

/** @type {Object} */
const getPatternAbility = {
	name: 'editor/get-pattern',
	label: 'Get Pattern',
	description:
		'Returns one pattern in full, as the block tree it would insert. Read this to see what a pattern contains, or to copy its structure into editor/insert-block.',
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description:
					'Pattern name from editor/get-patterns (e.g. twentytwentyfive/hero, core/block/12).',
			},
			maxDepth: {
				type: 'integer',
				minimum: 0,
				description:
					'Levels of nested blocks to include. Omit for the whole tree.',
			},
			includeContent: {
				type: 'boolean',
				description:
					'Also return the raw block markup, which is what gets saved.',
			},
		},
		required: [ 'name' ],
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			title: { type: 'string' },
			description: { type: 'string' },
			source: { type: [ 'string', 'null' ] },
			isUserPattern: { type: 'boolean' },
			id: { type: [ 'integer', 'null' ] },
			syncStatus: { type: [ 'string', 'null' ] },
			categories: { type: 'array' },
			blockTypes: { type: 'array' },
			blockCount: { type: 'integer' },
			blocks: {
				type: 'array',
				description:
					'Parsed blocks as { name, attributes, innerBlocks }, without client IDs: nothing here is in the document yet.',
			},
			content: { type: 'string' },
		},
		required: [ 'name', 'title', 'blocks', 'blockCount' ],
	},
	meta: {
		agenticEditor: { untrustedContent: true },
		annotations: {
			readonly: true,
			destructive: false,
			idempotent: true,
		},
	},
	callback: async ( input = {} ) => {
		assertEditorReady();

		if ( input.maxDepth !== undefined && ! ( input.maxDepth >= 0 ) ) {
			throw new Error( 'maxDepth must be zero or greater.' );
		}

		const pattern = await requirePattern( input.name );
		const blocks = parsePatternContent( pattern );
		const depthLimit =
			input.maxDepth === undefined ? Infinity : input.maxDepth;

		const result = {
			name: pattern.name,
			title: pattern.title,
			description: pattern.description,
			source: pattern.source,
			isUserPattern: pattern.isUserPattern,
			id: pattern.id,
			syncStatus: pattern.syncStatus,
			categories: pattern.categories,
			blockTypes: pattern.blockTypes,
			blockCount: countPatternBlocks( blocks ),
			blocks: blocks.map( ( block ) =>
				serializePatternBlock( block, depthLimit )
			),
		};

		if ( input.includeContent ) {
			result.content = pattern.content;
		}

		return result;
	},
};

/** @type {Object} */
const getPatternCategoriesAbility = {
	name: 'editor/get-pattern-categories',
	label: 'Get Pattern Categories',
	description:
		'Lists the pattern categories on this site, both the ones registered by core and the theme and the ones patterns are filed under. Use this before filtering editor/get-patterns or filing a new pattern.',
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			categories: {
				type: 'array',
				description:
					'Categories as { name, label, description, id, registered }. A null id means no pattern has been filed under it yet.',
			},
			count: { type: 'integer' },
		},
		required: [ 'categories', 'count' ],
	},
	meta: {
		agenticEditor: { untrustedContent: true },
		annotations: {
			readonly: true,
			destructive: false,
			idempotent: true,
		},
	},
	callback: async () => {
		assertEditorReady();
		const categories = await listPatternCategories();
		return { categories, count: categories.length };
	},
};

/** @type {Object} */
const insertPatternAbility = {
	name: 'editor/insert-pattern',
	label: 'Insert Pattern',
	description:
		'Inserts a pattern into the editor at a chosen location. Returns the client ID of every block it inserted, so the content can then be edited with editor/update-block.',
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Pattern name from editor/get-patterns.',
			},
			rootClientId: {
				type: 'string',
				description:
					'Optional parent client ID. Omit to insert at the document root.',
			},
			index: {
				type: 'integer',
				description:
					'Optional index within the parent (or root). Defaults to append.',
			},
			afterClientId: {
				type: 'string',
				description:
					'Insert immediately after this block (overrides index when set).',
			},
			asReference: {
				type: 'boolean',
				description:
					'For a synced pattern saved on this site, insert a single core/block that references it (the default, and how the editor inserts them). Pass false to copy its blocks in instead. Unsynced and registered patterns can only be copied.',
			},
		},
		required: [ 'name' ],
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			title: { type: 'string' },
			asReference: { type: 'boolean' },
			blocks: {
				type: 'array',
				description: 'The inserted top-level blocks, in order.',
			},
			count: { type: 'integer' },
			rootClientId: { type: [ 'string', 'null' ] },
			index: { type: 'integer' },
		},
		required: [ 'name', 'blocks', 'count' ],
	},
	meta: {
		annotations: {
			readonly: false,
			destructive: false,
			idempotent: false,
		},
	},
	callback: async ( input = {} ) => {
		assertEditorReady();
		const { select, dispatch } = getData();
		const store = select( BLOCK_EDITOR_STORE );
		const actions = dispatch( BLOCK_EDITOR_STORE );

		const pattern = await requirePattern( input.name );

		const { rootClientId: effectiveRootClientId, index } =
			resolveInsertionPoint( store, input );

		const asReference =
			input.asReference ?? pattern.syncStatus === 'synced';
		if ( asReference && ! pattern.isUserPattern ) {
			throw new Error(
				`Pattern "${ pattern.name }" is registered by ${
					pattern.source ?? 'this site'
				} rather than saved on it, so it has nothing to reference. Insert it without asReference.`
			);
		}
		// A reference to an unsynced pattern would turn this copy into a
		// synced instance, which is not what unsynced means.
		if ( asReference && pattern.syncStatus === 'unsynced' ) {
			throw new Error(
				`Pattern "${ pattern.name }" is unsynced, so it cannot be inserted as a reference. Insert it without asReference to copy its blocks in.`
			);
		}

		let blocks;
		if ( asReference ) {
			requireBlockType( PATTERN_BLOCK_NAME );
			blocks = [
				getBlocksApi().createBlock( PATTERN_BLOCK_NAME, {
					ref: pattern.id,
				} ),
			];
		} else {
			blocks = parsePatternContent( pattern );
			if ( ! blocks.length ) {
				throw new Error(
					`Pattern "${ pattern.name }" contains no blocks.`
				);
			}
		}

		for ( const block of blocks ) {
			await assertCanInsert( store, block.name, effectiveRootClientId );
		}

		await actions.insertBlocks(
			blocks,
			index,
			effectiveRootClientId || undefined
		);

		const inserted = blocks.filter( ( block ) =>
			store.getBlock( block.clientId )
		);
		if ( inserted.length !== blocks.length ) {
			throw new Error(
				'The editor did not insert this pattern. Its destination may be locked.'
			);
		}

		return {
			name: pattern.name,
			title: pattern.title,
			asReference,
			blocks: inserted.map( ( block ) =>
				summarizeBlock( store, store.getBlock( block.clientId ) )
			),
			count: inserted.length,
			rootClientId:
				store.getBlockRootClientId( inserted[ 0 ].clientId ) || null,
			index: store.getBlockIndex( inserted[ 0 ].clientId ),
		};
	},
};

/** @type {Object} */
const createPatternAbility = {
	name: 'editor/create-pattern',
	label: 'Create Pattern',
	description:
		'Saves blocks as a reusable pattern on this site, either blocks already in the document or a block structure supplied directly. Synced patterns stay linked everywhere they are used; unsynced ones are copied on insert. The pattern is published immediately, separately from the post, and editor undo does not remove it.',
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: 'Name the pattern is saved and listed under.',
			},
			clientIds: {
				type: 'array',
				description:
					'Client IDs of blocks already in the document to save, in the order they should appear in the pattern.',
				items: { type: 'string' },
			},
			blocks: {
				type: 'array',
				description:
					'Blocks to save, as { name, attributes, innerBlocks }, the same shape editor/insert-block accepts. Use this instead of clientIds to save a pattern that is not in the document.',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						attributes: { type: 'object' },
						innerBlocks: {
							type: 'array',
							description:
								'Blocks nested one level deeper, in the same shape.',
							items: { type: 'object' },
						},
					},
					required: [ 'name' ],
				},
			},
			syncStatus: {
				type: 'string',
				enum: [ 'synced', 'unsynced' ],
				description:
					'synced keeps every instance in step with the saved pattern; unsynced inserts an independent copy. Defaults to unsynced.',
			},
			categories: {
				type: 'array',
				description:
					'Category names to file the pattern under. A category with no term yet gets one created, the same as the editor does.',
				items: { type: 'string' },
			},
			replaceSource: {
				type: 'boolean',
				description:
					'Replace the blocks named in clientIds with a reference to the new pattern. Synced patterns only, and the blocks must be neighbours.',
			},
		},
		required: [ 'title' ],
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			id: { type: 'integer' },
			name: {
				type: 'string',
				description: 'Pattern name to pass to editor/insert-pattern.',
			},
			title: { type: 'string' },
			syncStatus: { type: 'string' },
			categories: { type: 'array' },
			createdCategories: {
				type: 'array',
				description: 'Categories that did not exist until now.',
			},
			blockCount: { type: 'integer' },
			replacedClientIds: { type: [ 'array', 'null' ] },
			clientId: {
				type: [ 'string', 'null' ],
				description:
					'Client ID of the reference block, when the source blocks were replaced.',
			},
		},
		required: [ 'id', 'name', 'title', 'syncStatus', 'blockCount' ],
	},
	meta: {
		// Undo cannot take this back, so the chat asks before running it.
		agenticEditor: {
			approval:
				'Publishes a pattern on this site straight away, separately from this post. Undo in the editor will not remove it.',
		},
		annotations: {
			readonly: false,
			destructive: true,
			idempotent: false,
		},
	},
	callback: async ( input = {} ) => {
		assertEditorReady();
		const { select, dispatch } = getData();
		const store = select( BLOCK_EDITOR_STORE );
		const actions = dispatch( BLOCK_EDITOR_STORE );
		const { serialize } = getBlockMarkupApi();

		if ( typeof input.title !== 'string' || ! input.title.trim() ) {
			throw new Error( 'title must be a name for the pattern.' );
		}

		const hasClientIds = !! input.clientIds?.length;
		const hasBlocks = !! input.blocks?.length;
		if ( hasClientIds === hasBlocks ) {
			throw new Error(
				'Pass either clientIds, to save blocks already in the document, or blocks, to save a structure directly.'
			);
		}

		const syncStatus = input.syncStatus ?? 'unsynced';
		if ( ! [ 'synced', 'unsynced' ].includes( syncStatus ) ) {
			throw new Error( 'syncStatus must be either synced or unsynced.' );
		}

		let sourceBlocks;
		let siblingRange = null;
		if ( hasClientIds ) {
			sourceBlocks = input.clientIds.map( ( clientId ) =>
				requireBlock( store, clientId, 'clientIds' )
			);
			if ( input.replaceSource ) {
				if ( syncStatus !== 'synced' ) {
					throw new Error(
						'replaceSource only applies to a synced pattern, since an unsynced one leaves the original blocks unchanged.'
					);
				}
				siblingRange = requireSiblingRange( store, input.clientIds );
				// Checked before saving: the pattern is published at once
				// and cannot be taken back if the replacement then fails.
				await assertCanReplace( store, siblingRange );
			}
		} else {
			if ( input.replaceSource ) {
				throw new Error(
					'replaceSource needs clientIds, since there are no blocks in the document to replace.'
				);
			}
			sourceBlocks = input.blocks.map( ( spec, position ) =>
				buildBlock( spec, `blocks[${ position }]` )
			);
		}

		await assertCanCreatePatterns();

		const { ids, slugs, created, createdIds } =
			await resolvePatternCategoryIds( input.categories );

		const save = dispatch( CORE_STORE ).saveEntityRecord(
			'postType',
			PATTERN_POST_TYPE,
			{
				title: input.title,
				content: serialize( sourceBlocks ),
				status: 'publish',
				// Core writes the sync status only for unsynced patterns;
				// no meta at all is what marks one as fully synced.
				meta:
					syncStatus === 'unsynced'
						? { wp_pattern_sync_status: 'unsynced' }
						: undefined,
				wp_pattern_category: ids,
			},
			{ throwOnError: true }
		);

		let record;
		try {
			record = await save;
			if ( ! record?.id ) {
				throw new Error( 'WordPress did not save this pattern.' );
			}
		} catch ( error ) {
			// Categories created for a pattern that never saved would be
			// left behind with nothing filed under them.
			await deletePatternCategories( createdIds );
			throw error;
		}

		const result = {
			id: record.id,
			name: `${ USER_PATTERN_PREFIX }${ record.id }`,
			title: input.title,
			syncStatus,
			categories: slugs,
			createdCategories: created,
			blockCount: countPatternBlocks( sourceBlocks ),
			replacedClientIds: null,
			clientId: null,
		};

		if ( siblingRange ) {
			const reference = getBlocksApi().createBlock( PATTERN_BLOCK_NAME, {
				ref: record.id,
			} );
			await actions.replaceBlocks( siblingRange.clientIds, [
				reference,
			] );

			if ( ! store.getBlock( reference.clientId ) ) {
				throw new Error(
					`The pattern was saved as ${ result.name }, but the editor did not replace the original blocks with it.`
				);
			}

			result.replacedClientIds = siblingRange.clientIds;
			result.clientId = reference.clientId;
		}

		return result;
	},
};

/** Pattern abilities, in registration order. */
const PATTERN_ABILITIES = [
	getPatternsAbility,
	getPatternAbility,
	getPatternCategoriesAbility,
	insertPatternAbility,
	createPatternAbility,
];

/**
 * Register the pattern abilities.
 *
 * @return {string[]} Registered ability names.
 */
export function registerPatternAbilities() {
	return registerAbilities( PATTERN_ABILITIES );
}
