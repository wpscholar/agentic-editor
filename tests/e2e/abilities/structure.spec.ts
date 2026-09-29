import { test, expect } from '../fixtures';

test.describe( 'block structure', () => {
	test( 'editor/insert-block refuses a nested block outside its required ancestor', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_insert-block', {
			name: 'core/group',
			innerBlocks: [ { name: 'core/comment-author-name' } ],
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain(
			'can only be used somewhere inside core/comment-template'
		);
		const found = await callTool( 'editor_find-editor-blocks', {
			name: 'core/group',
		} );
		expect( found.value.count ).toBe( 0 );
	} );

	test( 'editor/insert-block accepts a block several levels inside its ancestor', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_insert-block', {
			name: 'core/comments',
			innerBlocks: [
				{
					name: 'core/comment-template',
					innerBlocks: [
						{
							name: 'core/group',
							innerBlocks: [
								{ name: 'core/comment-author-name' },
							],
						},
					],
				},
			],
		} );

		expect( result.isError, result.text ).toBe( false );
	} );

	test( 'editor/get-block-type returns variations in the shape editor/insert-block takes', async ( {
		callTool,
	} ) => {
		const columns = await callTool( 'editor_get-block-type', {
			name: 'core/columns',
		} );
		const variation = columns.value.variations.find(
			( candidate: any ) => candidate.innerBlocks.length > 1
		);
		expect( variation ).toBeDefined();

		for ( const inner of variation.innerBlocks ) {
			expect( typeof inner.name ).toBe( 'string' );
			expect( inner.attributes ).toBeInstanceOf( Object );
			expect( Array.isArray( inner.innerBlocks ) ).toBe( true );
		}

		const inserted = await callTool( 'editor_insert-block', {
			name: 'core/columns',
			attributes: variation.attributes,
			innerBlocks: variation.innerBlocks,
		} );
		expect( inserted.isError, inserted.text ).toBe( false );
		expect( inserted.value.innerBlockCount ).toBe(
			variation.innerBlocks.length
		);
	} );

	test( 'editor/can-insert-block reports an unknown block name', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_can-insert-block', {
			name: 'core/not-a-block',
		} );

		expect( result.isError ).toBe( true );
		expect( result.text ).toContain( 'not registered' );
	} );

	test( 'editor/can-insert-block answers at once for a block that takes no children', async ( {
		editor,
		callTool,
	} ) => {
		const leaf = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Leaf' },
		} );
		// Let the paragraph render, as it would have long before an agent
		// asks about it.
		await expect(
			editor
				.frameLocator( 'iframe[name="editor-canvas"]' )
				.locator( `[data-block="${ leaf.value.clientId }"]` )
		).toBeVisible();

		const started = Date.now();
		const result = await callTool( 'editor_can-insert-block', {
			name: 'core/paragraph',
			rootClientId: leaf.value.clientId,
		} );

		expect( result.value.canInsert ).toBe( false );
		// It used to wait out the full second for list settings that a
		// leaf block never gets.
		expect( Date.now() - started ).toBeLessThan( 700 );
	} );

	test( 'editor/transform-block reports every block a transform produces', async ( {
		callTool,
	} ) => {
		const list = await callTool( 'editor_insert-block', {
			name: 'core/list',
			innerBlocks: [
				{ name: 'core/list-item', attributes: { content: 'One' } },
				{ name: 'core/list-item', attributes: { content: 'Two' } },
				{ name: 'core/list-item', attributes: { content: 'Three' } },
			],
		} );

		const result = await callTool( 'editor_transform-block', {
			clientId: list.value.clientId,
			name: 'core/paragraph',
		} );

		expect( result.isError, result.text ).toBe( false );
		expect( result.value.count ).toBe( 3 );
		expect(
			result.value.blocks.map( ( block: any ) => block.name )
		).toEqual( [ 'core/paragraph', 'core/paragraph', 'core/paragraph' ] );

		const tree = await callTool( 'editor_get-editor-tree' );
		expect( tree.value.count ).toBe( 3 );
	} );

	test( 'editor/undo steps back through several edits one at a time', async ( {
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
		await callTool( 'editor_update-block', {
			clientId: first.value.clientId,
			attributes: { content: 'First, edited' },
		} );

		const content = async () => {
			const tree = await callTool( 'editor_get-editor-tree' );
			return tree.value.blocks.map(
				( block: any ) => block.attributes.content
			);
		};

		expect( await content() ).toEqual( [ 'First, edited', 'Second' ] );

		await callTool( 'editor_undo' );
		expect( await content() ).toEqual( [ 'First', 'Second' ] );

		await callTool( 'editor_undo' );
		expect( await content() ).toEqual( [ 'First' ] );

		const redo = await callTool( 'editor_redo' );
		expect( redo.value.hasRedo ).toBe( true );
		expect( await content() ).toEqual( [ 'First', 'Second' ] );

		await callTool( 'editor_redo' );
		expect( await content() ).toEqual( [ 'First, edited', 'Second' ] );
		expect( second.isError ).toBe( false );
	} );
} );
