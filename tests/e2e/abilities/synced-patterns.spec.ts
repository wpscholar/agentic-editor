import { test, expect, type ToolResult } from '../fixtures';

type CallTool = (
	name: string,
	args?: Record< string, unknown >
) => Promise< ToolResult >;

/** Insert paragraphs through the ability and return their client IDs. */
async function paragraphs(
	callTool: CallTool,
	...contents: string[]
): Promise< string[] > {
	const ids: string[] = [];
	for ( const content of contents ) {
		const result = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content },
		} );
		expect( result.isError, result.text ).toBe( false );
		ids.push( result.value.clientId );
	}
	return ids;
}

/**
 * A synced pattern's blocks load from its own entity after the reference
 * renders, so reads of them are polled rather than taken once.
 */
async function findText( callTool: CallTool, search: string ) {
	let found: ToolResult | undefined;
	await expect
		.poll(
			async () => {
				found = await callTool( 'editor_find-editor-blocks', {
					search,
				} );
				return found.value.count;
			},
			{ timeout: 10_000 }
		)
		.toBeGreaterThan( 0 );
	return found!;
}

test.describe( 'synced patterns', () => {
	test( 'saving blocks in place replaces them with a reference the tree can see into', async ( {
		callTool,
		cleanup,
	} ) => {
		const marker = `Synced ${ Date.now() }`;
		const ids = await paragraphs(
			callTool,
			`${ marker } one`,
			`${ marker } two`
		);

		const created = await callTool( 'editor_create-pattern', {
			title: marker,
			clientIds: ids,
			syncStatus: 'synced',
			replaceSource: true,
		} );
		expect( created.isError, created.text ).toBe( false );
		cleanup.pattern( created.value.id );

		expect( created.value ).toMatchObject( {
			syncStatus: 'synced',
			blockCount: 2,
			replacedClientIds: ids,
		} );
		const reference = created.value.clientId;

		// The originals are gone; what is left is one reference whose
		// contents are the pattern's own blocks.
		const found = await findText( callTool, `${ marker } two` );
		expect( found.value.blocks[ 0 ].clientId ).not.toBe( ids[ 1 ] );

		const tree = await callTool( 'editor_get-editor-tree' );
		const node = tree.value.blocks.find(
			( block: any ) => block.clientId === reference
		);
		expect( node ).toMatchObject( {
			name: 'core/block',
			controlledInnerBlocks: true,
		} );
		expect( node.innerBlocks ).toHaveLength( 2 );

		const removed = await callTool( 'editor_remove-block', {
			clientId: reference,
		} );
		expect( removed.isError, removed.text ).toBe( false );
		expect( removed.value.removedInnerBlockCount ).toBe( 2 );
	} );

	test( 'a synced pattern inserts as a reference by default, or as copies on request', async ( {
		callTool,
		cleanup,
	} ) => {
		const marker = `Linked ${ Date.now() }`;
		const created = await callTool( 'editor_create-pattern', {
			title: marker,
			syncStatus: 'synced',
			blocks: [
				{ name: 'core/paragraph', attributes: { content: marker } },
				{ name: 'core/paragraph', attributes: { content: 'Second' } },
			],
		} );
		expect( created.isError, created.text ).toBe( false );
		cleanup.pattern( created.value.id );

		const reference = await callTool( 'editor_insert-pattern', {
			name: created.value.name,
		} );
		expect( reference.isError, reference.text ).toBe( false );
		expect( reference.value ).toMatchObject( {
			asReference: true,
			count: 1,
		} );
		expect( reference.value.blocks[ 0 ].name ).toBe( 'core/block' );

		const copies = await callTool( 'editor_insert-pattern', {
			name: created.value.name,
			asReference: false,
		} );
		expect( copies.isError, copies.text ).toBe( false );
		expect( copies.value.asReference ).toBe( false );
		expect(
			copies.value.blocks.map( ( block: any ) => block.name )
		).toEqual( [ 'core/paragraph', 'core/paragraph' ] );
	} );

	test( 'an unsynced pattern cannot be inserted as a reference', async ( {
		callTool,
		cleanup,
	} ) => {
		const created = await callTool( 'editor_create-pattern', {
			title: `Unsynced ${ Date.now() }`,
			blocks: [
				{ name: 'core/paragraph', attributes: { content: 'Copy me' } },
			],
		} );
		expect( created.isError, created.text ).toBe( false );
		cleanup.pattern( created.value.id );

		const result = await callTool( 'editor_insert-pattern', {
			name: created.value.name,
			asReference: true,
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain( 'is unsynced' );

		const tree = await callTool( 'editor_find-editor-blocks', {
			name: 'core/block',
		} );
		expect( tree.value.count ).toBe( 0 );
	} );
} );
