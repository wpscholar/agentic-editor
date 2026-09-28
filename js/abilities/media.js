/**
 * Media abilities: generating images into the Media Library.
 *
 * The AI Client runs only in PHP, so generation happens behind the plugin's
 * `/agentic-editor/v1/image` endpoint. These abilities never place what they
 * make; the result carries the attributes `editor/insert-block` and
 * `editor/update-block` need, and the model places it with those.
 */

import {
	ABILITY_CATEGORY,
	assertEditorReady,
	getData,
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

/** @type {Object} */
const generateImageAbility = {
	name: 'editor/generate-image',
	label: 'Generate Image',
	description:
		"Generates a new image from a text description with this site's AI provider and adds it to the Media Library. It does not place the image: pass the returned blockAttributes to editor/insert-block as the attributes of a core/image block, or give the returned id and url to editor/update-block for an existing image block (id, url), cover block (id, url) or media & text block (mediaId, mediaUrl). Use this whenever the user wants a new image; never use an image URL from anywhere else.",
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

		return {
			id: image.id,
			url: image.url,
			alt: image.alt,
			title: image.title,
			width: image.width ?? null,
			height: image.height ?? null,
			blockAttributes: {
				id: image.id,
				url: image.url,
				alt: image.alt,
				sizeSlug: 'full',
				linkDestination: 'none',
			},
		};
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
	return readConfig().imageGeneration
		? registerAbilities( [ generateImageAbility ] )
		: [];
}
