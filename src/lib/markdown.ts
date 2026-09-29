/**
 * Just enough Markdown to render a model reply, parsed into plain data.
 *
 * Parsing is kept apart from rendering so it can be tested without React.
 * Nothing here produces HTML: `src/components/markdown.tsx` turns these
 * nodes into React elements.
 */

export type Inline =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'strong'; text: string }
	| { type: 'em'; text: string }
	| { type: 'link'; text: string; href: string };

export type Block =
	| { type: 'code'; text: string }
	| { type: 'heading'; level: number; content: Inline[] }
	| { type: 'quote'; lines: Inline[][] }
	| { type: 'list'; ordered: boolean; start?: number; items: Inline[][] }
	| { type: 'paragraph'; lines: Inline[][] };

/*
 * Emphasis must hug its text, so `2 * 3 * 4` stays arithmetic. A link target
 * may hold one level of balanced parentheses, as Wikipedia URLs do.
 */
const LINK_SOURCE = String.raw`\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)`;
const INLINE_PATTERN = new RegExp(
	[
		'(`[^`]+`)',
		String.raw`(\*\*[^\s*](?:[^*]*[^\s*])?\*\*)`,
		String.raw`(\*[^\s*](?:[^*]*[^\s*])?\*)`,
		`(${ LINK_SOURCE })`,
	].join( '|' )
);
const LINK = new RegExp( LINK_SOURCE );

const FENCE = /^\s{0,3}```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const BULLET = /^\s*[-*]\s+/;
const ORDERED = /^\s*(\d+)\.\s+/;

/**
 * Only allow absolute links the browser can safely follow.
 *
 * A relative target would resolve against the admin screen the chat is on,
 * so a reply could link to an admin action; only a full http(s) URL is kept.
 *
 * @param url Link target as the model wrote it.
 */
export function safeUrl( url: string ): string | null {
	if ( ! /^https?:\/\//i.test( url ) ) {
		return null;
	}
	try {
		const parsed = new URL( url );
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
			? parsed.href
			: null;
	} catch {
		return null;
	}
}

/**
 * Whether a line starts a block other than a paragraph.
 */
function startsBlock( line: string ): boolean {
	return (
		FENCE.test( line ) ||
		HEADING.test( line ) ||
		QUOTE.test( line ) ||
		BULLET.test( line ) ||
		ORDERED.test( line )
	);
}

/**
 * Split one line into code spans, emphasis, and links.
 */
export function parseInline( text: string ): Inline[] {
	const nodes: Inline[] = [];
	let rest = text;

	while ( rest ) {
		const match = INLINE_PATTERN.exec( rest );

		if ( ! match ) {
			nodes.push( { type: 'text', text: rest } );
			break;
		}

		if ( match.index > 0 ) {
			nodes.push( { type: 'text', text: rest.slice( 0, match.index ) } );
		}

		const token = match[ 0 ];

		if ( token.startsWith( '`' ) ) {
			nodes.push( { type: 'code', text: token.slice( 1, -1 ) } );
		} else if ( token.startsWith( '**' ) ) {
			nodes.push( { type: 'strong', text: token.slice( 2, -2 ) } );
		} else if ( token.startsWith( '*' ) ) {
			nodes.push( { type: 'em', text: token.slice( 1, -1 ) } );
		} else {
			const link = LINK.exec( token );
			const label = link?.[ 1 ] ?? token;
			const href = link ? safeUrl( link[ 2 ] ) : null;

			nodes.push(
				href
					? { type: 'link', text: label, href }
					: { type: 'text', text: label }
			);
		}

		rest = rest.slice( match.index + token.length );
	}

	return nodes;
}

/**
 * Split a reply into code blocks, headings, quotes, lists, and paragraphs.
 */
export function parseMarkdown( text: string ): Block[] {
	const lines = String( text || '' ).split( '\n' );
	const blocks: Block[] = [];

	let index = 0;

	while ( index < lines.length ) {
		const line = lines[ index ];

		if ( FENCE.test( line ) ) {
			const body: string[] = [];
			index += 1;
			while ( index < lines.length && ! FENCE.test( lines[ index ] ) ) {
				body.push( lines[ index ] );
				index += 1;
			}
			index += 1;

			blocks.push( { type: 'code', text: body.join( '\n' ) } );
			continue;
		}

		const heading = HEADING.exec( line );
		if ( heading ) {
			blocks.push( {
				type: 'heading',
				level: heading[ 1 ].length,
				content: parseInline( heading[ 2 ] ),
			} );
			index += 1;
			continue;
		}

		if ( QUOTE.test( line ) ) {
			const quoted: Inline[][] = [];
			while ( index < lines.length && QUOTE.test( lines[ index ] ) ) {
				quoted.push(
					parseInline( lines[ index ].replace( QUOTE, '' ) )
				);
				index += 1;
			}

			blocks.push( { type: 'quote', lines: quoted } );
			continue;
		}

		const ordered = ORDERED.exec( line );

		if ( ordered || BULLET.test( line ) ) {
			const marker = ordered ? ORDERED : BULLET;
			const items: Inline[][] = [];

			while ( index < lines.length && marker.test( lines[ index ] ) ) {
				items.push(
					parseInline( lines[ index ].replace( marker, '' ) )
				);
				index += 1;
			}

			blocks.push(
				ordered
					? {
							type: 'list',
							ordered: true,
							start: Number( ordered[ 1 ] ),
							items,
						}
					: { type: 'list', ordered: false, items }
			);
			continue;
		}

		if ( ! line.trim() ) {
			index += 1;
			continue;
		}

		const paragraph: Inline[][] = [];
		while (
			index < lines.length &&
			lines[ index ].trim() &&
			! startsBlock( lines[ index ] )
		) {
			paragraph.push( parseInline( lines[ index ] ) );
			index += 1;
		}

		blocks.push( { type: 'paragraph', lines: paragraph } );
	}

	return blocks;
}
