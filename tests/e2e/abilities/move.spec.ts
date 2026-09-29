import { test, expect, type ToolResult } from '../fixtures';

type CallTool = (
	name: string,
	args?: Record< string, unknown >
) => Promise< ToolResult >;

/** Insert one paragraph and return its client ID. */
async function paragraph(
	callTool: CallTool,
	content: string,
	extra: Record< string, unknown > = {}
): Promise< string > {
	const result = await callTool( 'editor_insert-block', {
		name: 'core/paragraph',
		attributes: { content },
		...extra,
	} );
	expect( result.isError, result.text ).toBe( false );
	return result.value.clientId;
}

/** Client IDs of a parent's children, or of the root. */
async function childOrder(
	callTool: CallTool,
	rootClientId?: string
): Promise< string[] > {
	const tree = await callTool( 'editor_get-editor-tree' );
	const find = ( blocks: any[] ): any[] | null => {
		for ( const block of blocks ) {
			if ( block.clientId === rootClientId ) {
				return block.innerBlocks;
			}
			const found = find( block.innerBlocks );
			if ( found ) {
				return found;
			}
		}
		return null;
	};
	const children = rootClientId
		? find( tree.value.blocks )
		: tree.value.blocks;
	return ( children ?? [] ).map( ( block: any ) => block.clientId );
}

test.describe( 'editor/move-block', () => {
	test( 'moves a block before a sibling', async ( { callTool } ) => {
		const a = await paragraph( callTool, 'A' );
		const b = await paragraph( callTool, 'B' );
		const c = await paragraph( callTool, 'C' );

		const move = await callTool( 'editor_move-block', {
			clientId: c,
			beforeClientId: a,
		} );

		expect( move.isError, move.text ).toBe( false );
		expect( move.value ).toMatchObject( {
			index: 0,
			previousIndex: 2,
			rootClientId: null,
		} );
		expect( await childOrder( callTool ) ).toEqual( [ c, a, b ] );
	} );

	test( 'moves a block into a parent at an index', async ( { callTool } ) => {
		const group = await callTool( 'editor_insert-block', {
			name: 'core/group',
			innerBlocks: [
				{ name: 'core/paragraph', attributes: { content: 'In 1' } },
				{ name: 'core/paragraph', attributes: { content: 'In 2' } },
			],
		} );
		const outside = await paragraph( callTool, 'Outside' );

		const move = await callTool( 'editor_move-block', {
			clientId: outside,
			rootClientId: group.value.clientId,
			index: 1,
		} );

		expect( move.isError, move.text ).toBe( false );
		expect( move.value ).toMatchObject( {
			rootClientId: group.value.clientId,
			index: 1,
			previousRootClientId: null,
		} );
		const inside = await childOrder( callTool, group.value.clientId );
		expect( inside ).toHaveLength( 3 );
		expect( inside[ 1 ] ).toBe( outside );
	} );

	test( 'clamps an index past the end to the last position', async ( {
		callTool,
	} ) => {
		const a = await paragraph( callTool, 'A' );
		const b = await paragraph( callTool, 'B' );

		const move = await callTool( 'editor_move-block', {
			clientId: a,
			index: 99,
		} );

		expect( move.isError, move.text ).toBe( false );
		expect( await childOrder( callTool ) ).toEqual( [ b, a ] );
	} );

	test( 'moves a block from one parent to another', async ( {
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
							attributes: { content: 'Travelling' },
						},
					],
				},
				{ name: 'core/column' },
			],
		} );
		const [ first, second ] = await childOrder(
			callTool,
			columns.value.clientId
		);
		const [ travelling ] = await childOrder( callTool, first );

		const move = await callTool( 'editor_move-block', {
			clientId: travelling,
			rootClientId: second,
		} );

		expect( move.isError, move.text ).toBe( false );
		expect( move.value ).toMatchObject( {
			rootClientId: second,
			previousRootClientId: first,
			index: 0,
		} );
		expect( await childOrder( callTool, first ) ).toEqual( [] );
		expect( await childOrder( callTool, second ) ).toEqual( [
			travelling,
		] );
	} );

	test( 'refuses to move a block into its own descendant', async ( {
		callTool,
	} ) => {
		const outer = await callTool( 'editor_insert-block', {
			name: 'core/group',
			innerBlocks: [ { name: 'core/group' } ],
		} );
		const [ inner ] = await childOrder( callTool, outer.value.clientId );

		const move = await callTool( 'editor_move-block', {
			clientId: outer.value.clientId,
			rootClientId: inner,
		} );

		expect( move.isError ).toBe( true );
		expect( move.text ).toContain( 'own descendants' );
	} );

	test( 'refuses both afterClientId and beforeClientId', async ( {
		callTool,
	} ) => {
		const a = await paragraph( callTool, 'A' );
		const b = await paragraph( callTool, 'B' );
		const c = await paragraph( callTool, 'C' );

		const move = await callTool( 'editor_move-block', {
			clientId: a,
			afterClientId: b,
			beforeClientId: c,
		} );

		expect( move.isError ).toBe( true );
		expect( move.text ).toContain( 'only one of' );
	} );

	test( 'explains a block locked against moving', async ( {
		editor,
		callTool,
	} ) => {
		await paragraph( callTool, 'Free' );
		const locked = await editor.evaluate( () => {
			const wp = ( window as any ).wp;
			const block = wp.blocks.createBlock( 'core/paragraph', {
				content: 'Pinned',
				lock: { move: true },
			} );
			wp.data.dispatch( 'core/block-editor' ).insertBlocks( [ block ] );
			return block.clientId;
		} );

		const move = await callTool( 'editor_move-block', {
			clientId: locked,
			index: 0,
		} );

		expect( move.isError ).toBe( true );
		expect( move.text ).toContain( 'locked against moving' );
	} );

	test( 'keeps a remove-locked block inside its parent, but lets it reorder there', async ( {
		editor,
		callTool,
	} ) => {
		const { group, locked } = await editor.evaluate( () => {
			const wp = ( window as any ).wp;
			const lockedBlock = wp.blocks.createBlock( 'core/paragraph', {
				content: 'Stays',
				lock: { remove: true },
			} );
			const groupBlock = wp.blocks.createBlock( 'core/group', {}, [
				wp.blocks.createBlock( 'core/paragraph', {
					content: 'Neighbour',
				} ),
				lockedBlock,
			] );
			wp.data
				.dispatch( 'core/block-editor' )
				.insertBlocks( [ groupBlock ] );
			return {
				group: groupBlock.clientId,
				locked: lockedBlock.clientId,
			};
		} );

		const out = await callTool( 'editor_move-block', {
			clientId: locked,
		} );
		expect( out.isError ).toBe( true );
		expect( out.text ).toContain( 'locked against removal' );

		const within = await callTool( 'editor_move-block', {
			clientId: locked,
			rootClientId: group,
			index: 0,
		} );
		expect( within.isError, within.text ).toBe( false );
		expect( ( await childOrder( callTool, group ) )[ 0 ] ).toBe( locked );
	} );
} );
