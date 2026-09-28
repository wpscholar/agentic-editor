import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAbility } from '@wordpress/abilities';

vi.mock( '@wordpress/abilities', () => ( {
	getAbility: vi.fn( () => undefined ),
	getAbilityCategory: vi.fn( () => ( {} ) ),
	registerAbility: vi.fn(),
	registerAbilityCategory: vi.fn(),
} ) );

const mockedRegister = /** @type {import('vitest').Mock} */ (
	/** @type {unknown} */ ( registerAbility )
);

/**
 * Put a page on the global scope: the media module's server data, and the
 * `wp.data` stores it reads.
 *
 * @param {{ imageGeneration?: boolean, records?: Object[], total?: number }} options
 */
function usePage( { imageGeneration = false, records = [], total } = {} ) {
	const getEntityRecords = vi.fn( async () => records );
	const invalidateResolution = vi.fn();
	const getEntityRecordsTotalItems = vi.fn( () => total );
	const stores = {
		'core/block-editor': {},
		core: { getEntityRecordsTotalItems },
	};

	vi.stubGlobal( 'document', {
		getElementById: ( id ) =>
			id === 'wp-script-module-data-@agentic-editor/abilities/media'
				? { textContent: JSON.stringify( { imageGeneration } ) }
				: null,
	} );
	vi.stubGlobal( 'window', {
		wp: {
			data: {
				select: ( name ) => stores[ name ],
				dispatch: () => ( { invalidateResolution } ),
				resolveSelect: () => ( { getEntityRecords } ),
			},
		},
	} );

	return { getEntityRecords, invalidateResolution };
}

/**
 * Import the module fresh, so it reads the page set up for this test.
 *
 * @return {Promise<typeof import('./media.js')>} The media abilities module.
 */
async function loadMedia() {
	vi.resetModules();
	return import( './media.js' );
}

/**
 * @param {string} name Ability name.
 * @return {Object} The definition passed to registerAbility.
 */
function registered( name ) {
	const call = mockedRegister.mock.calls.find(
		( [ ability ] ) => ability.name === name
	);
	if ( ! call ) {
		throw new Error( `${ name } was not registered` );
	}
	return call[ 0 ];
}

beforeEach( () => {
	mockedRegister.mockClear();
} );

afterEach( () => {
	vi.unstubAllGlobals();
} );

describe( 'registerMediaAbilities', () => {
	it( 'always offers search, and generation only when the site supports it', async () => {
		usePage( { imageGeneration: false } );
		expect( ( await loadMedia() ).registerMediaAbilities() ).toEqual( [
			'editor/search-media',
		] );

		usePage( { imageGeneration: true } );
		expect( ( await loadMedia() ).registerMediaAbilities() ).toEqual( [
			'editor/search-media',
			'editor/generate-image',
		] );
	} );

	it( 'steers the model from generating to searching for existing images', async () => {
		usePage( { imageGeneration: true } );
		( await loadMedia() ).registerMediaAbilities();

		expect( registered( 'editor/generate-image' ).description ).toContain(
			'editor/search-media'
		);
		expect( registered( 'editor/search-media' ).meta ).toMatchObject( {
			agenticEditor: { untrustedContent: true },
			annotations: { readonly: true },
		} );
	} );
} );

describe( 'editor/search-media', () => {
	it( 'searches images, fresh, with the flag that widens the search', async () => {
		const { getEntityRecords, invalidateResolution } = usePage();
		( await loadMedia() ).registerMediaAbilities();

		await registered( 'editor/search-media' ).callback( {
			search: ' lighthouse ',
			perPage: 5,
		} );

		const query = {
			media_type: 'image',
			per_page: 5,
			page: 1,
			orderby: 'date',
			order: 'desc',
			agentic_editor_search: 1,
			search: 'lighthouse',
		};
		expect( getEntityRecords ).toHaveBeenCalledWith(
			'postType',
			'attachment',
			query
		);
		expect( invalidateResolution ).toHaveBeenCalledWith(
			'getEntityRecords',
			[ 'postType', 'attachment', query ]
		);
	} );

	it( 'returns each image with the attributes to place it', async () => {
		usePage( {
			total: 1,
			records: [
				{
					id: 42,
					source_url: 'https://example.test/lighthouse.png',
					title: { raw: 'IMG_1234', rendered: 'IMG_1234' },
					alt_text: 'Lighthouse at dusk',
					caption: { rendered: '<p>On the <em>cape</em></p>' },
					mime_type: 'image/png',
					media_type: 'image',
					media_details: { width: 1536, height: 1024 },
					date: '2026-09-28T10:00:00',
				},
			],
		} );
		( await loadMedia() ).registerMediaAbilities();

		const result = await registered( 'editor/search-media' ).callback( {
			search: 'lighthouse',
		} );

		expect( result ).toEqual( {
			total: 1,
			items: [
				{
					id: 42,
					url: 'https://example.test/lighthouse.png',
					title: 'IMG_1234',
					alt: 'Lighthouse at dusk',
					caption: 'On the cape',
					mimeType: 'image/png',
					width: 1536,
					height: 1024,
					date: '2026-09-28T10:00:00',
					blockAttributes: {
						id: 42,
						url: 'https://example.test/lighthouse.png',
						alt: 'Lighthouse at dusk',
						sizeSlug: 'full',
						linkDestination: 'none',
					},
				},
			],
		} );
	} );

	it( 'rejects a page size outside the limit', async () => {
		usePage();
		( await loadMedia() ).registerMediaAbilities();

		await expect(
			registered( 'editor/search-media' ).callback( { perPage: 50 } )
		).rejects.toThrow( 'perPage' );
	} );
} );
