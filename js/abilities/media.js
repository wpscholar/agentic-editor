/**
 * Media abilities: finding images in the Media Library and generating new ones.
 *
 * The AI Client runs only in PHP, so generation happens behind the plugin's
 * `/agentic-editor/v1/image` endpoint. These abilities never place anything;
 * each result carries the attributes `editor/insert-block` and
 * `editor/update-block` need, and the model places it with those.
 */

import {
	ABILITY_CATEGORY,
	CORE_STORE,
	assertEditorReady,
	getData,
	getResolveSelect,
	isPlainObject,
	registerAbilities,
} from '@agentic-editor/abilities/shared';

const DATA_ELEMENT_ID = 'wp-script-module-data-@agentic-editor/abilities/media';

const IMAGE_PATH = '/agentic-editor/v1/image';

/**
 * Image models take far longer than one editor edit, so the chat waits this
 * long for this tool instead of its usual limit.
 */
const GENERATE_IMAGE_TIMEOUT_MS = 180_000;

/**
 * @return {{ imageGeneration: boolean }} What PHP says this site can do.
 */
function readConfig() {
	const element = document.getElementById( DATA_ELEMENT_ID );
	if ( ! element ) {
		return { imageGeneration: false };
	}

	try {
		const data = JSON.parse( element.textContent || '{}' );
		return { imageGeneration: data?.imageGeneration === true };
	} catch ( error ) {
		console.warn(
			'[agentic-editor] Could not read the media abilities configuration:',
			error
		);
		return { imageGeneration: false };
	}
}

/**
 * @return {(options: Record<string, unknown>) => Promise<unknown>} `wp.apiFetch`.
 */
function getApiFetch() {
	const apiFetch = window.wp?.apiFetch;
	if ( typeof apiFetch !== 'function' ) {
		throw new Error( 'WordPress apiFetch is not available.' );
	}
	return apiFetch;
}

/**
 * The post being edited, to attach the image to. None in the site editor.
 *
 * @return {number|undefined}
 */
function getCurrentPostId() {
	const id = getData().select( 'core/editor' )?.getCurrentPostId?.();
	return typeof id === 'number' && id > 0 ? id : undefined;
}

/**
 * @param {unknown} value
 * @param {string}  label
 * @return {string|undefined} The trimmed string, or undefined when absent.
 */
function optionalString( value, label ) {
	if ( value === undefined || value === null ) {
		return undefined;
	}
	if ( typeof value !== 'string' ) {
		throw new Error( `${ label } must be a string.` );
	}
	return value.trim() || undefined;
}

/**
 * Attributes for a core/image block showing an attachment at full size.
 *
 * @param {{ id: number, url: string, alt?: string }} image
 * @return {Record<string, unknown>}
 */
function imageBlockAttributes( image ) {
	return {
		id: image.id,
		url: image.url,
		alt: image.alt ?? '',
		sizeSlug: 'full',
		linkDestination: 'none',
	};
}

const MAX_CAPTION_CHARS = 200;

/**
 * Plain text from a REST field that may be `{ raw, rendered }` or a string.
 *
 * @param {unknown} field
 * @return {string}
 */
function fieldText( field ) {
	if ( typeof field === 'string' ) {
		return field;
	}
	if ( ! isPlainObject( field ) ) {
		return '';
	}
	if ( typeof field.raw === 'string' ) {
		return field.raw;
	}
	return typeof field.rendered === 'string'
		? field.rendered.replace( /<[^>]*>/g, '' ).trim()
		: '';
}

/**
 * @param {Object} record Attachment entity record.
 * @return {Object} What the model needs to recognize and place it.
 */
function summarizeAttachment( record ) {
	const caption = fieldText( record.caption );
	const summary = {
		id: record.id,
		url: record.source_url,
		title: fieldText( record.title ),
		alt: typeof record.alt_text === 'string' ? record.alt_text : '',
		caption:
			caption.length > MAX_CAPTION_CHARS
				? `${ caption.slice( 0, MAX_CAPTION_CHARS ) }…`
				: caption,
		mimeType: record.mime_type,
		width: record.media_details?.width ?? null,
		height: record.media_details?.height ?? null,
		date: record.date,
	};

	return record.media_type === 'image'
		? { ...summary, blockAttributes: imageBlockAttributes( summary ) }
		: summary;
}

/** @type {Object} */
const searchMediaAbility = {
	name: 'editor/search-media',
	label: 'Search Media Library',
	description:
		"Finds files already in this site's Media Library, newest first, matching words in their title, alt text, caption, description or file name. Use this whenever the user refers to an existing, uploaded or Media Library image. Place a result by passing its blockAttributes to editor/insert-block as the attributes of a core/image block, or its id and url to editor/update-block for an existing image block (id, url), cover block (id, url) or media & text block (mediaId, mediaUrl). If nothing matches, tell the user rather than generating an image they did not ask for.",
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {
			search: {
				type: 'string',
				description:
					'Words to look for. Try a single key word (lighthouse) before a phrase. Omit to list the most recent files.',
			},
			mediaType: {
				type: 'string',
				enum: [ 'image', 'video', 'audio', 'application' ],
				description: 'Kind of file. Defaults to image.',
			},
			perPage: {
				type: 'integer',
				minimum: 1,
				maximum: 20,
				description: 'Results per page. Defaults to 10.',
			},
			page: {
				type: 'integer',
				minimum: 1,
				description: 'Page of results, starting at 1.',
			},
		},
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: { type: 'integer' },
						url: { type: 'string' },
						title: { type: 'string' },
						alt: { type: 'string' },
						caption: { type: 'string' },
						mimeType: { type: 'string' },
						width: { type: [ 'integer', 'null' ] },
						height: { type: [ 'integer', 'null' ] },
						date: { type: 'string' },
						blockAttributes: {
							type: 'object',
							description:
								'Attributes for a core/image block showing this image. Images only.',
						},
					},
				},
			},
			total: {
				type: [ 'integer', 'null' ],
				description: 'Matching files across every page, when known.',
			},
		},
		required: [ 'items' ],
	},
	meta: {
		agenticEditor: {
			untrustedContent: true,
		},
		annotations: {
			readonly: true,
			destructive: false,
			idempotent: true,
		},
	},
	callback: async ( input = {} ) => {
		assertEditorReady();

		const search = optionalString( input.search, 'search' );
		const mediaType = input.mediaType ?? 'image';
		if (
			! [ 'image', 'video', 'audio', 'application' ].includes( mediaType )
		) {
			throw new Error(
				'mediaType must be one of image, video, audio or application.'
			);
		}
		const perPage = input.perPage ?? 10;
		const page = input.page ?? 1;
		if ( ! Number.isInteger( perPage ) || perPage < 1 || perPage > 20 ) {
			throw new Error( 'perPage must be a whole number from 1 to 20.' );
		}
		if ( ! Number.isInteger( page ) || page < 1 ) {
			throw new Error( 'page must be a whole number from 1.' );
		}

		/** @type {Record<string, unknown>} */
		const query = {
			media_type: mediaType,
			per_page: perPage,
			page,
			orderby: 'date',
			order: 'desc',
			// Widens the search to alt text and file names; see
			// includes/media-search.php.
			agentic_editor_search: 1,
		};
		if ( search ) {
			query.search = search;
		}

		// A search is always answered fresh, so a file uploaded or generated
		// since the last identical search is found.
		const args = [ 'postType', 'attachment', query ];
		getData()
			.dispatch( CORE_STORE )
			?.invalidateResolution?.( 'getEntityRecords', args );

		const records =
			( await getResolveSelect()( CORE_STORE ).getEntityRecords(
				...args
			) ) ?? [];
		const total = getData()
			.select( CORE_STORE )
			?.getEntityRecordsTotalItems?.( ...args );

		return {
			items: records.map( summarizeAttachment ),
			total: typeof total === 'number' ? total : null,
		};
	},
};

/** @type {Object} */
const generateImageAbility = {
	name: 'editor/generate-image',
	label: 'Generate Image',
	description:
		"Generates a new image from a text description with this site's AI provider and adds it to the Media Library. It does not place the image: pass the returned blockAttributes to editor/insert-block as the attributes of a core/image block, or give the returned id and url to editor/update-block for an existing image block (id, url), cover block (id, url) or media & text block (mediaId, mediaUrl). Use this only when the user asks for a new or generated image; to use an image already on the site, call editor/search-media instead. Never use an image URL from anywhere else.",
	category: ABILITY_CATEGORY.slug,
	input_schema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description:
					'A detailed description of the image: subject, setting, style, lighting and mood. Do not ask for text in the image unless the user did.',
			},
			alt: {
				type: 'string',
				description:
					'Alternative text describing the image for people who cannot see it. Defaults to the prompt.',
			},
			title: {
				type: 'string',
				description:
					'Short title for the Media Library, also used for the file name.',
			},
			orientation: {
				type: 'string',
				enum: [ 'landscape', 'portrait', 'square' ],
				description:
					'Shape of the image. Defaults to landscape, which suits most places in a post.',
			},
		},
		required: [ 'prompt' ],
		additionalProperties: false,
	},
	output_schema: {
		type: 'object',
		properties: {
			id: { type: 'integer', description: 'Attachment ID.' },
			url: { type: 'string', description: 'Full-size image URL.' },
			alt: { type: 'string' },
			title: { type: 'string' },
			width: { type: [ 'integer', 'null' ] },
			height: { type: [ 'integer', 'null' ] },
			blockAttributes: {
				type: 'object',
				description:
					'Attributes for a core/image block showing this image.',
			},
		},
		required: [ 'id', 'url', 'blockAttributes' ],
	},
	meta: {
		agenticEditor: {
			// Billed, and the attachment outlives undo, so the chat asks first.
			approval:
				"Generates an image with the site's AI provider, which may be billed, and adds it to the Media Library. Undo in the editor will not remove it.",
			timeoutMs: GENERATE_IMAGE_TIMEOUT_MS,
		},
		annotations: {
			readonly: false,
			destructive: false,
			idempotent: false,
		},
	},
	callback: async ( input = {} ) => {
		assertEditorReady();

		const prompt = optionalString( input.prompt, 'prompt' );
		if ( ! prompt ) {
			throw new Error( 'prompt must describe the image to generate.' );
		}

		/** @type {Record<string, unknown>} */
		const data = { prompt };
		const alt = optionalString( input.alt, 'alt' );
		const title = optionalString( input.title, 'title' );
		if ( alt ) {
			data.alt = alt;
		}
		if ( title ) {
			data.title = title;
		}
		if ( input.orientation !== undefined ) {
			data.orientation = input.orientation;
		}
		const postId = getCurrentPostId();
		if ( postId ) {
			data.postId = postId;
		}

		let image;
		try {
			image = await getApiFetch()( {
				path: IMAGE_PATH,
				method: 'POST',
				data,
			} );
		} catch ( error ) {
			const message =
				isPlainObject( error ) && typeof error.message === 'string'
					? error.message
					: String( error );
			throw new Error( `The image was not generated: ${ message }` );
		}

		if ( ! isPlainObject( image ) || typeof image.id !== 'number' ) {
			throw new Error(
				'The image endpoint returned something other than an attachment.'
			);
		}

		const result = {
			id: image.id,
			url: String( image.url ?? '' ),
			alt: typeof image.alt === 'string' ? image.alt : '',
			title: image.title,
			width: image.width ?? null,
			height: image.height ?? null,
		};

		return { ...result, blockAttributes: imageBlockAttributes( result ) };
	},
};

/**
 * Register the media abilities this site supports.
 *
 * `editor/generate-image` is left out entirely when no connector can generate
 * images, so a model never sees a tool that can only fail.
 *
 * @return {string[]} Registered ability names.
 */
export function registerMediaAbilities() {
	return registerAbilities( [
		searchMediaAbility,
		...( readConfig().imageGeneration ? [ generateImageAbility ] : [] ),
	] );
}
