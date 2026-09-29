import { test, expect } from '../fixtures';

test.describe( 'patterns', () => {
	test( 'editor/get-pattern-categories lists at least one category', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-pattern-categories' );
		expect( result.isError ).toBe( false );
		expect( result.value.count ).toBeGreaterThan( 0 );
		expect( result.value.categories ).toHaveLength( result.value.count );
	} );

	test( 'editor/get-patterns lists patterns, and editor/get-pattern reads one in full', async ( {
		callTool,
	} ) => {
		const list = await callTool( 'editor_get-patterns' );
		expect( list.isError ).toBe( false );

		// The test site's theme always registers patterns, so an empty list
		// is a failure to find them, not a site without any.
		expect( list.value.totalCount ).toBeGreaterThan( 0 );

		const first = list.value.patterns[ 0 ];
		const pattern = await callTool( 'editor_get-pattern', {
			name: first.name,
		} );
		expect( pattern.isError ).toBe( false );
		expect( pattern.value.name ).toBe( first.name );
		expect( pattern.value.blockCount ).toBeGreaterThan( 0 );
		expect( pattern.value.blocks.length ).toBeGreaterThan( 0 );
	} );

	test( 'editor/get-pattern fails for an unknown pattern name', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-pattern', {
			name: 'not/a-real-pattern',
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/create-pattern saves blocks as a pattern, and editor/insert-pattern inserts it', async ( {
		callTool,
		cleanup,
	} ) => {
		const title = `E2E pattern ${ Date.now() }`;

		const created = await callTool( 'editor_create-pattern', {
			title,
			blocks: [
				{
					name: 'core/paragraph',
					attributes: { content: 'Saved from a test' },
				},
			],
		} );
		expect( created.isError ).toBe( false );
		cleanup.pattern( created.value.id );

		expect( created.value.title ).toBe( title );
		expect( created.value.blockCount ).toBe( 1 );
		expect( created.value.syncStatus ).toBe( 'unsynced' );

		const inserted = await callTool( 'editor_insert-pattern', {
			name: created.value.name,
		} );
		expect( inserted.isError ).toBe( false );
		expect( inserted.value.count ).toBeGreaterThan( 0 );

		const found = await callTool( 'editor_find-editor-blocks', {
			search: 'Saved from a test',
		} );
		expect( found.value.count ).toBeGreaterThan( 0 );
	} );

	test( 'editor/create-pattern requires either clientIds or blocks, not both or neither', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_create-pattern', {
			title: `E2E pattern ${ Date.now() }`,
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/get-pattern reads a saved pattern by name, and reports a missing one', async ( {
		callTool,
		cleanup,
	} ) => {
		const created = await callTool( 'editor_create-pattern', {
			title: `Lookup ${ Date.now() }`,
			blocks: [
				{ name: 'core/paragraph', attributes: { content: 'Found' } },
			],
		} );
		expect( created.isError, created.text ).toBe( false );
		cleanup.pattern( created.value.id );

		const found = await callTool( 'editor_get-pattern', {
			name: created.value.name,
		} );
		expect( found.isError, found.text ).toBe( false );
		expect( found.value ).toMatchObject( {
			id: created.value.id,
			isUserPattern: true,
			syncStatus: 'unsynced',
			blockCount: 1,
		} );
		expect( found.value.blocks[ 0 ].name ).toBe( 'core/paragraph' );

		for ( const name of [ 'core/block/999999999', 'core/block/abc' ] ) {
			const missing = await callTool( 'editor_get-pattern', { name } );
			expect( missing.isError, name ).toBe( true );
			expect( missing.text ).toContain( 'Pattern not found' );
		}
	} );

	test( 'editor/create-pattern files a category once, however it is named', async ( {
		callTool,
		cleanup,
	} ) => {
		const label = `E2E Cat ${ Date.now() }`;
		const slug = label.toLowerCase().replace( / /g, '-' );
		cleanup.category( slug );

		const created = await callTool( 'editor_create-pattern', {
			title: `Filed ${ Date.now() }`,
			categories: [ label, label.toLowerCase(), ` ${ label } ` ],
			blocks: [
				{ name: 'core/paragraph', attributes: { content: 'Filed' } },
			],
		} );
		expect( created.isError, created.text ).toBe( false );
		cleanup.pattern( created.value.id );

		expect( created.value.categories ).toEqual( [ slug ] );
		expect( created.value.createdCategories ).toEqual( [ slug ] );

		// Filing another pattern under it reuses the term it now has.
		const again = await callTool( 'editor_create-pattern', {
			title: `Filed again ${ Date.now() }`,
			categories: [ slug ],
			blocks: [
				{ name: 'core/paragraph', attributes: { content: 'Again' } },
			],
		} );
		expect( again.isError, again.text ).toBe( false );
		cleanup.pattern( again.value.id );
		expect( again.value.createdCategories ).toEqual( [] );

		const filtered = await callTool( 'editor_get-patterns', {
			category: slug,
		} );
		expect(
			filtered.value.patterns
				.map( ( pattern: any ) => pattern.name )
				.sort()
		).toEqual( [ created.value.name, again.value.name ].sort() );
	} );

	test( 'editor/get-patterns filters by source, sync status, search and destination', async ( {
		callTool,
		cleanup,
	} ) => {
		const marker = `Filterable ${ Date.now() }`;
		const synced = await callTool( 'editor_create-pattern', {
			title: `${ marker } synced`,
			syncStatus: 'synced',
			blocks: [
				{ name: 'core/paragraph', attributes: { content: 'S' } },
			],
		} );
		const unsynced = await callTool( 'editor_create-pattern', {
			title: `${ marker } unsynced`,
			blocks: [
				{ name: 'core/paragraph', attributes: { content: 'U' } },
			],
		} );
		expect( synced.isError, synced.text ).toBe( false );
		expect( unsynced.isError, unsynced.text ).toBe( false );
		cleanup.pattern( synced.value.id );
		cleanup.pattern( unsynced.value.id );

		const names = async ( args: Record< string, unknown > ) => {
			const result = await callTool( 'editor_get-patterns', {
				search: marker,
				...args,
			} );
			expect( result.isError, result.text ).toBe( false );
			return result.value.patterns.map(
				( pattern: any ) => pattern.name
			);
		};

		expect( ( await names( {} ) ).sort() ).toEqual(
			[ synced.value.name, unsynced.value.name ].sort()
		);
		expect( await names( { syncStatus: 'synced' } ) ).toEqual( [
			synced.value.name,
		] );
		expect( await names( { syncStatus: 'unsynced' } ) ).toEqual( [
			unsynced.value.name,
		] );
		expect( await names( { source: 'theme' } ) ).toEqual( [] );
		expect( await names( { source: 'user' } ) ).toHaveLength( 2 );

		// A list accepts only list items, so no paragraph pattern fits in one.
		const list = await callTool( 'editor_insert-block', {
			name: 'core/list',
			innerBlocks: [
				{ name: 'core/list-item', attributes: { content: 'Item' } },
			],
		} );
		expect( await names( { rootClientId: list.value.clientId } ) ).toEqual(
			[]
		);
	} );
} );
