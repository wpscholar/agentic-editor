import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/** A 1×1 transparent PNG. */
const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Upload a tiny image through the REST API, the way the media modal does.
 */
async function upload(
	editor: Page,
	fields: { fileName: string; title: string; alt?: string }
): Promise< number > {
	return editor.evaluate(
		async ( { png, fields } ) => {
			const bytes = Uint8Array.from( atob( png ), ( c ) =>
				c.charCodeAt( 0 )
			);
			const body = new FormData();
			body.append(
				'file',
				new File( [ bytes ], fields.fileName, { type: 'image/png' } )
			);
			body.append( 'title', fields.title );
			if ( fields.alt ) {
				body.append( 'alt_text', fields.alt );
			}
			const media = await ( window as any ).wp.apiFetch( {
				path: '/wp/v2/media',
				method: 'POST',
				body,
			} );
			return media.id;
		},
		{ png: PNG, fields }
	);
}

test.describe( 'media', () => {
	// Each run gets its own word, so files left by other runs never match.
	const token = `e2e${ Date.now().toString( 36 ) }`;

	test( 'editor/search-media finds an image by its alt text, ready to place', async ( {
		editor,
		callTool,
		cleanup,
	} ) => {
		const id = await upload( editor, {
			fileName: 'IMG_1234.png',
			title: 'IMG_1234',
			alt: `Lighthouse ${ token } at dusk`,
		} );
		cleanup.media( id );

		const result = await callTool( 'editor_search-media', {
			search: token,
		} );

		expect( result.isError ).toBe( false );
		expect( result.value.items ).toHaveLength( 1 );
		const [ item ] = result.value.items;
		expect( item ).toMatchObject( {
			id,
			title: 'IMG_1234',
			alt: `Lighthouse ${ token } at dusk`,
			mimeType: 'image/png',
		} );
		expect( item.blockAttributes ).toEqual( {
			id,
			url: item.url,
			alt: `Lighthouse ${ token } at dusk`,
			sizeSlug: 'full',
			linkDestination: 'none',
		} );

		// What it returns is what a core/image block takes.
		const inserted = await callTool( 'editor_insert-block', {
			name: 'core/image',
			attributes: item.blockAttributes,
		} );
		expect( inserted.isError ).toBe( false );
	} );

	test( 'editor/search-media finds an image by its file name', async ( {
		editor,
		callTool,
		cleanup,
	} ) => {
		const id = await upload( editor, {
			fileName: `harbor-${ token }.png`,
			title: 'Untitled',
		} );
		cleanup.media( id );

		const result = await callTool( 'editor_search-media', {
			search: `harbor-${ token }`,
		} );

		expect( result.isError ).toBe( false );
		expect(
			result.value.items.map( ( item: { id: number } ) => item.id )
		).toEqual( [ id ] );
	} );

	test( 'editor/search-media reports no match as an empty list', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_search-media', {
			search: `nothing-${ token }-matches`,
		} );

		expect( result.isError ).toBe( false );
		expect( result.value.items ).toEqual( [] );
	} );
} );
