import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeUrl } from './markdown';

describe( 'safeUrl', () => {
	it( 'allows http and https', () => {
		expect( safeUrl( 'https://wordpress.org/' ) ).toBe(
			'https://wordpress.org/'
		);
		expect( safeUrl( 'http://example.com/a?b=c' ) ).toBe(
			'http://example.com/a?b=c'
		);
	} );

	it.each( [
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox',
		'file:///etc/passwd',
		'mailto:someone@example.com',
	] )( 'rejects %s', ( url ) => {
		expect( safeUrl( url ) ).toBeNull();
	} );

	it.each( [
		'/wp-admin/options.php',
		'options.php',
		'//evil.test/x',
		'#top',
	] )(
		'rejects the relative target %s, which would resolve against wp-admin',
		( url ) => {
			expect( safeUrl( url ) ).toBeNull();
		}
	);

	it( 'rejects what is not a URL at all', () => {
		expect( safeUrl( 'http://' ) ).toBeNull();
	} );
} );

describe( 'parseInline', () => {
	it( 'returns plain text as one node', () => {
		expect( parseInline( 'Hello there.' ) ).toEqual( [
			{ type: 'text', text: 'Hello there.' },
		] );
	} );

	it( 'parses code, strong, emphasis and links in order', () => {
		expect(
			parseInline(
				'Use `core/paragraph`, **not** *that*, see [docs](https://wordpress.org/).'
			)
		).toEqual( [
			{ type: 'text', text: 'Use ' },
			{ type: 'code', text: 'core/paragraph' },
			{ type: 'text', text: ', ' },
			{ type: 'strong', text: 'not' },
			{ type: 'text', text: ' ' },
			{ type: 'em', text: 'that' },
			{ type: 'text', text: ', see ' },
			{ type: 'link', text: 'docs', href: 'https://wordpress.org/' },
			{ type: 'text', text: '.' },
		] );
	} );

	it( 'keeps markup inside code spans literal', () => {
		expect( parseInline( '`**bold** <b>`' ) ).toEqual( [
			{ type: 'code', text: '**bold** <b>' },
		] );
	} );

	it( 'renders an unsafe link as its label only', () => {
		expect( parseInline( '[click](javascript:alert(1))' ) ).toEqual( [
			{ type: 'text', text: 'click' },
		] );
	} );

	it( 'keeps balanced parentheses in a URL', () => {
		expect(
			parseInline(
				'[Parens](https://en.wikipedia.org/wiki/Foo_(bar)) here'
			)
		).toEqual( [
			{
				type: 'link',
				text: 'Parens',
				href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
			},
			{ type: 'text', text: ' here' },
		] );
	} );

	it( 'does not read arithmetic as emphasis', () => {
		expect( parseInline( '2 * 3 * 4 = 24' ) ).toEqual( [
			{ type: 'text', text: '2 * 3 * 4 = 24' },
		] );
		expect( parseInline( 'a ** b ** c' ) ).toEqual( [
			{ type: 'text', text: 'a ** b ** c' },
		] );
	} );

	it( 'still reads tight emphasis', () => {
		expect( parseInline( '*a* and **b c**' ) ).toEqual( [
			{ type: 'em', text: 'a' },
			{ type: 'text', text: ' and ' },
			{ type: 'strong', text: 'b c' },
		] );
	} );

	it( 'leaves HTML as text', () => {
		expect( parseInline( '<img src=x onerror=alert(1)>' ) ).toEqual( [
			{ type: 'text', text: '<img src=x onerror=alert(1)>' },
		] );
	} );
} );

describe( 'parseMarkdown', () => {
	it( 'returns nothing for empty input', () => {
		expect( parseMarkdown( '' ) ).toEqual( [] );
		expect( parseMarkdown( '\n\n' ) ).toEqual( [] );
	} );

	it( 'joins consecutive lines into one paragraph and splits on blank lines', () => {
		expect( parseMarkdown( 'One\nTwo\n\nThree' ) ).toEqual( [
			{
				type: 'paragraph',
				lines: [
					[ { type: 'text', text: 'One' } ],
					[ { type: 'text', text: 'Two' } ],
				],
			},
			{
				type: 'paragraph',
				lines: [ [ { type: 'text', text: 'Three' } ] ],
			},
		] );
	} );

	it( 'parses fenced code verbatim', () => {
		expect( parseMarkdown( '```js\nconst a = **1**;\n\n```' ) ).toEqual( [
			{ type: 'code', text: 'const a = **1**;\n' },
		] );
	} );

	it( 'keeps an unterminated fence as code to the end', () => {
		expect( parseMarkdown( '```\nstill code' ) ).toEqual( [
			{ type: 'code', text: 'still code' },
		] );
	} );

	it( 'parses bullet and ordered lists', () => {
		expect(
			parseMarkdown( '- one\n* two\n\n1. first\n2. second' )
		).toEqual( [
			{
				type: 'list',
				ordered: false,
				items: [
					[ { type: 'text', text: 'one' } ],
					[ { type: 'text', text: 'two' } ],
				],
			},
			{
				type: 'list',
				ordered: true,
				start: 1,
				items: [
					[ { type: 'text', text: 'first' } ],
					[ { type: 'text', text: 'second' } ],
				],
			},
		] );
	} );

	it( 'keeps the start number of an ordered list', () => {
		expect( parseMarkdown( '3. third\n4. fourth' ) ).toEqual( [
			{
				type: 'list',
				ordered: true,
				start: 3,
				items: [
					[ { type: 'text', text: 'third' } ],
					[ { type: 'text', text: 'fourth' } ],
				],
			},
		] );
	} );

	it( 'recognises an indented fence', () => {
		expect( parseMarkdown( '  ```\n  code\n  ```\nAfter' ) ).toEqual( [
			{ type: 'code', text: '  code' },
			{
				type: 'paragraph',
				lines: [ [ { type: 'text', text: 'After' } ] ],
			},
		] );
	} );

	it( 'parses headings', () => {
		expect( parseMarkdown( '## Summary\nBody' ) ).toEqual( [
			{
				type: 'heading',
				level: 2,
				content: [ { type: 'text', text: 'Summary' } ],
			},
			{
				type: 'paragraph',
				lines: [ [ { type: 'text', text: 'Body' } ] ],
			},
		] );
		// Seven hashes, or none of the space after them, is not a heading.
		expect( parseMarkdown( '#hashtag' )[ 0 ].type ).toBe( 'paragraph' );
	} );

	it( 'parses blockquotes', () => {
		expect( parseMarkdown( '> Quoted *text*\n> more\nAfter' ) ).toEqual( [
			{
				type: 'quote',
				lines: [
					[
						{ type: 'text', text: 'Quoted ' },
						{ type: 'em', text: 'text' },
					],
					[ { type: 'text', text: 'more' } ],
				],
			},
			{
				type: 'paragraph',
				lines: [ [ { type: 'text', text: 'After' } ] ],
			},
		] );
	} );

	it( 'ends a paragraph where a list starts', () => {
		const blocks = parseMarkdown( 'Steps:\n- one' );

		expect( blocks.map( ( block ) => block.type ) ).toEqual( [
			'paragraph',
			'list',
		] );
	} );
} );
