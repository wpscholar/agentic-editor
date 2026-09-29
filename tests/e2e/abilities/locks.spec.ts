import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';

/** Insert a paragraph straight through the store, bypassing the abilities. */
async function insertParagraph(
	page: Page,
	attributes: Record< string, unknown > = {}
): Promise< string > {
	return page.evaluate( ( attributes ) => {
		const wp = ( window as any ).wp;
		const block = wp.blocks.createBlock( 'core/paragraph', {
			content: 'Original',
			...attributes,
		} );
		wp.data.dispatch( 'core/block-editor' ).insertBlocks( [ block ] );
		return block.clientId;
	}, attributes );
}

async function setEditingMode( page: Page, clientId: string, mode: string ) {
	await page.evaluate(
		( { clientId, mode } ) =>
			( window as any ).wp.data
				.dispatch( 'core/block-editor' )
				.setBlockEditingMode( clientId, mode ),
		{ clientId, mode }
	);
}

async function getBlock( page: Page, clientId: string ) {
	return page.evaluate(
		( clientId ) =>
			( window as any ).wp.data
				.select( 'core/block-editor' )
				.getBlock( clientId ),
		clientId
	);
}

test.describe( 'locks', () => {
	test( "editor/update-block refuses to change a block's locks", async ( {
		editor,
		callTool,
	} ) => {
		const clientId = await insertParagraph( editor, {
			lock: { move: true, remove: true },
		} );

		for ( const attributes of [
			{ lock: { move: false, remove: false } },
			{ templateLock: false },
			{ metadata: { name: 'Renamed' } },
		] ) {
			const result = await callTool( 'editor_update-block', {
				clientId,
				attributes,
			} );
			expect( result.isError, JSON.stringify( attributes ) ).toBe( true );
			expect( result.text ).toContain(
				'cannot be set through this ability'
			);
		}

		const block = await getBlock( editor, clientId );
		expect( block.attributes.lock ).toEqual( { move: true, remove: true } );
		expect( block.attributes.metadata ).toBeUndefined();
	} );

	test( 'editor/insert-block refuses locks at any depth', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_insert-block', {
			name: 'core/group',
			innerBlocks: [
				{
					name: 'core/paragraph',
					attributes: { content: 'Hi', lock: { remove: true } },
				},
			],
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain( 'innerBlocks[0].attributes.lock' );
	} );

	test( 'editor/update-block leaves a disabled block alone', async ( {
		editor,
		callTool,
	} ) => {
		const clientId = await insertParagraph( editor );
		await setEditingMode( editor, clientId, 'disabled' );

		const result = await callTool( 'editor_update-block', {
			clientId,
			attributes: { content: 'Changed' },
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain( 'cannot be updated' );
		expect(
			( await getBlock( editor, clientId ) ).attributes.content
		).toBe( 'Original' );
	} );

	test( 'editor/update-block edits only content in a contentOnly block', async ( {
		editor,
		callTool,
	} ) => {
		const clientId = await insertParagraph( editor );
		await setEditingMode( editor, clientId, 'contentOnly' );

		const structural = await callTool( 'editor_update-block', {
			clientId,
			attributes: { content: 'Changed', dropCap: true },
		} );
		expect( structural.isError ).toBe( true );
		expect( structural.text ).toContain( 'rules out dropCap' );
		expect( structural.text ).toContain(
			'Its content attributes are: content'
		);

		const content = await callTool( 'editor_update-block', {
			clientId,
			attributes: { content: 'Changed' },
		} );
		expect( content.isError ).toBe( false );

		const block = await getBlock( editor, clientId );
		expect( String( block.attributes.content ) ).toBe( 'Changed' );
		expect( block.attributes.dropCap ).toBeFalsy();
	} );

	test( 'editor/transform-block respects a remove lock', async ( {
		editor,
		callTool,
	} ) => {
		const clientId = await insertParagraph( editor, {
			lock: { remove: true },
		} );

		const result = await callTool( 'editor_transform-block', {
			clientId,
			name: 'core/heading',
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain( 'locked against removal' );
		expect( ( await getBlock( editor, clientId ) ).name ).toBe(
			'core/paragraph'
		);
	} );

	test( 'editor/create-pattern checks a remove lock before publishing anything', async ( {
		editor,
		callTool,
	} ) => {
		const clientId = await insertParagraph( editor, {
			lock: { remove: true },
		} );
		const title = `Locked source ${ Date.now() }`;

		const result = await callTool( 'editor_create-pattern', {
			title,
			clientIds: [ clientId ],
			syncStatus: 'synced',
			replaceSource: true,
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain( 'cannot be replaced by the pattern' );
		expect( await getBlock( editor, clientId ) ).not.toBeNull();

		const saved = await editor.evaluate(
			( title ) =>
				( window as any ).wp.apiFetch( {
					path: `/wp/v2/blocks?search=${ encodeURIComponent( title ) }&context=edit`,
				} ),
			title
		);
		expect( saved ).toEqual( [] );
	} );
} );
