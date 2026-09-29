import { test, expect } from '../fixtures';

test.describe( 'block type discovery', () => {
	test( 'editor/get-block-types lists registered blocks and supports search', async ( {
		callTool,
	} ) => {
		const all = await callTool( 'editor_get-block-types' );
		expect( all.isError ).toBe( false );
		expect( all.value.totalCount ).toBeGreaterThan( 0 );
		expect(
			all.value.blockTypes.some(
				( type: { name: string } ) => type.name === 'core/paragraph'
			)
		).toBe( true );

		const filtered = await callTool( 'editor_get-block-types', {
			search: 'paragraph',
		} );
		expect( filtered.isError ).toBe( false );
		expect( filtered.value.count ).toBeGreaterThan( 0 );
		expect( filtered.value.count ).toBeLessThan( all.value.totalCount );
	} );

	test( 'editor/get-block-types narrows to what a parent block accepts', async ( {
		callTool,
	} ) => {
		const columns = await callTool( 'editor_insert-block', {
			name: 'core/columns',
			innerBlocks: [ { name: 'core/column' }, { name: 'core/column' } ],
		} );

		const insideColumns = await callTool( 'editor_get-block-types', {
			rootClientId: columns.value.clientId,
		} );
		expect( insideColumns.isError ).toBe( false );
		expect(
			insideColumns.value.blockTypes.some(
				( type: { name: string } ) => type.name === 'core/column'
			)
		).toBe( true );
	} );

	test( 'editor/get-block-type returns the full definition for one block', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-block-type', {
			name: 'core/paragraph',
		} );
		expect( result.isError ).toBe( false );
		expect( result.value.name ).toBe( 'core/paragraph' );
		expect( result.value.attributes ).toHaveProperty( 'content' );
	} );

	test( 'editor/get-block-type fails for an unregistered block name', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-block-type', {
			name: 'not/a-real-block',
		} );
		expect( result.isError ).toBe( true );
	} );
} );
