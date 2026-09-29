import { test, expect } from '../fixtures';

test.describe( 'inspecting the editor', () => {
	test( 'editor/get-editor-tree returns the full block tree', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Hello from a test' },
		} );
		expect( insert.isError ).toBe( false );

		const tree = await callTool( 'editor_get-editor-tree' );
		expect( tree.isError ).toBe( false );
		expect( tree.value.count ).toBeGreaterThan( 0 );
		expect(
			tree.value.blocks.some(
				( block: { clientId: string } ) =>
					block.clientId === insert.value.clientId
			)
		).toBe( true );
	} );

	test( 'editor/get-editor-tree truncates below maxDepth', async ( {
		callTool,
	} ) => {
		await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [
				{
					name: 'core/column',
					innerBlocks: [
						{
							name: 'core/paragraph',
							attributes: { content: 'Nested' },
						},
					],
				},
				{ name: 'core/column' },
			],
		} );

		const tree = await callTool( 'editor_get-editor-tree', {
			maxDepth: 0,
		} );
		expect( tree.isError ).toBe( false );
		const columns = tree.value.blocks.find(
			( block: { name: string } ) => block.name === 'core/columns'
		);
		expect( columns.innerBlocks ?? [] ).toHaveLength( 0 );
	} );

	test( 'editor/find-editor-blocks finds a block by its visible text', async ( {
		callTool,
	} ) => {
		await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Findable paragraph text' },
		} );

		const found = await callTool( 'editor_find-editor-blocks', {
			search: 'Findable paragraph',
		} );
		expect( found.isError ).toBe( false );
		expect( found.value.count ).toBeGreaterThanOrEqual( 1 );
		expect( found.value.blocks[ 0 ].name ).toBe( 'core/paragraph' );
	} );

	test( 'editor/find-editor-blocks filters by attribute value', async ( {
		callTool,
	} ) => {
		await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Not a match', dropCap: true },
		} );
		await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Also not a match', dropCap: false },
		} );

		const found = await callTool( 'editor_find-editor-blocks', {
			name: 'core/paragraph',
			attribute: 'dropCap',
			value: 'true',
		} );
		expect( found.isError ).toBe( false );
		expect( found.value.count ).toBe( 1 );
		expect( found.value.blocks[ 0 ].attributes.dropCap ).toBe( true );
	} );

	// A RichText attribute (paragraph/heading `content`, etc.) is a
	// RichTextData object at runtime, not a plain string. attribute+value
	// matching has to compare against its rendered text rather than treating
	// it like any other object attribute (see issue #3).
	test( 'editor/find-editor-blocks filters by attribute value on a RichText attribute', async ( {
		callTool,
	} ) => {
		await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Exact rich text match' },
		} );
		await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'A different paragraph' },
		} );

		const found = await callTool( 'editor_find-editor-blocks', {
			name: 'core/paragraph',
			attribute: 'content',
			value: 'Exact rich text match',
		} );
		expect( found.isError ).toBe( false );
		expect( found.value.count ).toBe( 1 );
		expect( found.value.blocks[ 0 ].attributes.content ).toBe(
			'Exact rich text match'
		);
	} );

	test( 'editor/get-block-location reports parents, root, and index', async ( {
		callTool,
	} ) => {
		await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [
				{
					name: 'core/column',
					innerBlocks: [
						{
							name: 'core/paragraph',
							attributes: { content: 'In a column' },
						},
					],
				},
				{ name: 'core/column' },
			],
		} );

		const found = await callTool( 'editor_find-editor-blocks', {
			search: 'In a column',
		} );
		const paragraphId = found.value.blocks[ 0 ].clientId;

		const location = await callTool( 'editor_get-block-location', {
			clientId: paragraphId,
		} );
		expect( location.isError ).toBe( false );
		expect( location.value.parentClientIds ).toHaveLength( 2 );
		expect( location.value.index ).toBe( 0 );
	} );

	test( 'editor/get-block-location fails for an unknown client ID', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-block-location', {
			clientId: 'does-not-exist',
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/select-block updates the selection editor/get-editor-selection reports', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Select me' },
		} );

		const select = await callTool( 'editor_select-block', {
			clientId: insert.value.clientId,
		} );
		expect( select.isError ).toBe( false );

		const selection = await callTool( 'editor_get-editor-selection' );
		expect( selection.isError ).toBe( false );
		expect( selection.value.selectedBlockClientId ).toBe(
			insert.value.clientId
		);
		expect( selection.value.selectedBlock.clientId ).toBe(
			insert.value.clientId
		);
	} );

	test( 'editor/can-insert-block respects parent/child nesting rules', async ( {
		callTool,
	} ) => {
		const atRoot = await callTool( 'editor_can-insert-block', {
			name: 'core/paragraph',
		} );
		expect( atRoot.isError ).toBe( false );
		expect( atRoot.value.canInsert ).toBe( true );

		// core/column is only ever valid inside core/columns.
		const columnAtRoot = await callTool( 'editor_can-insert-block', {
			name: 'core/column',
		} );
		expect( columnAtRoot.value.canInsert ).toBe( false );

		const columns = await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [ { name: 'core/column' }, { name: 'core/column' } ],
		} );

		const columnInColumns = await callTool( 'editor_can-insert-block', {
			name: 'core/column',
			rootClientId: columns.value.clientId,
		} );
		expect( columnInColumns.value.canInsert ).toBe( true );
	} );
} );
