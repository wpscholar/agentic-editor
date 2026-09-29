import { test, expect } from '../fixtures';

test.describe( 'mutating the document', () => {
	test( 'editor/insert-block inserts nested container blocks in one step', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [
				{
					name: 'core/column',
					innerBlocks: [
						{
							name: 'core/paragraph',
							attributes: { content: 'Left' },
						},
					],
				},
				{
					name: 'core/column',
					innerBlocks: [
						{
							name: 'core/paragraph',
							attributes: { content: 'Right' },
						},
					],
				},
			],
		} );
		expect( result.isError ).toBe( false );
		expect( result.value.innerBlockCount ).toBe( 2 );

		const tree = await callTool( 'editor_get-editor-tree' );
		const columns = tree.value.blocks.find(
			( block: { clientId: string } ) =>
				block.clientId === result.value.clientId
		);
		expect( columns.innerBlocks ).toHaveLength( 2 );
		expect(
			columns.innerBlocks[ 0 ].innerBlocks[ 0 ].attributes.content
		).toBe( 'Left' );
	} );

	test( 'editor/insert-block fails for an unregistered block name', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_insert-block', {
			name: 'not/a-real-block',
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/insert-block fails for a stale afterClientId', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			afterClientId: 'does-not-exist',
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/update-block merges attributes without touching the rest', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Original', dropCap: false },
		} );

		const update = await callTool( 'editor_update-block', {
			clientId: insert.value.clientId,
			attributes: { content: 'Updated' },
		} );
		expect( update.isError ).toBe( false );
		expect( update.value.attributes.content ).toBe( 'Updated' );
		expect( update.value.attributes.dropCap ).toBe( false );
		expect( update.value.updatedAttributes ).toEqual( [ 'content' ] );
	} );

	test( 'editor/update-block merges nested object attributes', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: {
				content: 'Styled',
				style: {
					typography: { fontSize: '20px' },
					color: { text: '#000000', background: '#ffffff' },
				},
			},
		} );

		const update = await callTool( 'editor_update-block', {
			clientId: insert.value.clientId,
			attributes: {
				style: { color: { text: '#ff0000', background: null } },
			},
		} );

		expect( update.isError ).toBe( false );
		expect( update.value.attributes.style ).toEqual( {
			typography: { fontSize: '20px' },
			color: { text: '#ff0000' },
		} );
	} );

	test( 'editor/move-block repositions a block after a sibling', async ( {
		callTool,
	} ) => {
		const first = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'First' },
		} );
		const second = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Second' },
		} );

		const move = await callTool( 'editor_move-block', {
			clientId: first.value.clientId,
			afterClientId: second.value.clientId,
		} );
		expect( move.isError ).toBe( false );
		expect( move.value.index ).toBe( 1 );

		const tree = await callTool( 'editor_get-editor-tree' );
		const order = tree.value.blocks.map(
			( block: { clientId: string } ) => block.clientId
		);
		expect( order.indexOf( first.value.clientId ) ).toBeGreaterThan(
			order.indexOf( second.value.clientId )
		);
	} );

	test( 'editor/move-block refuses to move a block into itself', async ( {
		callTool,
	} ) => {
		const columns = await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [ { name: 'core/column' }, { name: 'core/column' } ],
		} );

		const result = await callTool( 'editor_move-block', {
			clientId: columns.value.clientId,
			rootClientId: columns.value.clientId,
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/transform-block converts a paragraph into a heading', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Turn me into a heading' },
		} );

		const transform = await callTool( 'editor_transform-block', {
			clientId: insert.value.clientId,
			name: 'core/heading',
		} );
		expect( transform.isError ).toBe( false );
		expect( transform.value.name ).toBe( 'core/heading' );
		expect( transform.value.blocks[ 0 ].name ).toBe( 'core/heading' );

		const stale = await callTool( 'editor_get-block-location', {
			clientId: insert.value.clientId,
		} );
		expect( stale.isError ).toBe( true );
	} );

	test( 'editor/transform-block fails when already that block type', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Already a paragraph' },
		} );

		const result = await callTool( 'editor_transform-block', {
			clientId: insert.value.clientId,
			name: 'core/paragraph',
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/remove-block removes a block, including nested content', async ( {
		callTool,
	} ) => {
		const columns = await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [
				{
					name: 'core/column',
					innerBlocks: [
						{
							name: 'core/paragraph',
							attributes: { content: 'Doomed' },
						},
					],
				},
				{ name: 'core/column' },
			],
		} );

		const remove = await callTool( 'editor_remove-block', {
			clientId: columns.value.clientId,
		} );
		expect( remove.isError ).toBe( false );
		expect( remove.value.removedInnerBlockCount ).toBe( 3 );

		const stillThere = await callTool( 'editor_find-editor-blocks', {
			search: 'Doomed',
		} );
		expect( stillThere.value.count ).toBe( 0 );
	} );
} );
