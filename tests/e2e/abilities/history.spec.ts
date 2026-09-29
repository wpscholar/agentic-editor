import { test, expect } from '../fixtures';

test.describe( 'undo and redo', () => {
	test( 'editor/undo fails on a fresh document with nothing to undo', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_undo' );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/redo fails on a fresh document with nothing to redo', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_redo' );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/undo reverts the last change, and editor/redo brings it back', async ( {
		callTool,
	} ) => {
		const insert = await callTool( 'editor_insert-block', {
			name: 'core/paragraph',
			attributes: { content: 'Undo me' },
		} );
		expect( insert.isError ).toBe( false );

		const undo = await callTool( 'editor_undo' );
		expect( undo.isError ).toBe( false );
		expect( undo.value.undone ).toBe( true );

		const afterUndo = await callTool( 'editor_get-block-location', {
			clientId: insert.value.clientId,
		} );
		expect( afterUndo.isError ).toBe( true );

		const redo = await callTool( 'editor_redo' );
		expect( redo.isError ).toBe( false );
		expect( redo.value.redone ).toBe( true );

		const afterRedo = await callTool( 'editor_get-block-location', {
			clientId: insert.value.clientId,
		} );
		expect( afterRedo.isError ).toBe( false );
	} );
} );
