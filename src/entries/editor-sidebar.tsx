/**
 * Mount the chat as a block editor sidebar.
 *
 * This is the only editor-aware part of the chat. It describes the post being
 * edited so the assistant knows what the editor tools are pointed at, attaches
 * the selected block to the user's messages, and renders the shared panel into
 * a PluginSidebar.
 *
 * The panel goes in as ordinary children rather than being mounted into a ref'd
 * div, which only works because this bundle uses the same React instance as the
 * editor. See src/lib/shims/react.ts.
 */

import '@/styles/chat.css';

import * as React from 'react';

import { ChatPanel, type ChatAttachment } from '@/components/chat-panel';
import type { BlockEditorSelectors, EditorBlock } from '@/lib/wp';

const SIDEBAR_NAME = 'agentic-editor-chat';

/**
 * Above this many characters of JSON, the attached block goes with fewer
 * levels of inner blocks. The server has its own, higher cap.
 */
const ATTACHMENT_CHARS = 6000;

/** Longest excerpt of a block's text shown in the attachment label. */
const LABEL_EXCERPT_CHARS = 40;

/** Describe what the editor is currently showing. */
function getEditorContext(): Record< string, unknown > {
	const select = window.wp?.data?.select;

	if ( typeof select !== 'function' ) {
		return { screen: 'block editor' };
	}

	const notes: string[] = [];

	try {
		const editor = select( 'core/editor' );
		const postType = editor?.getCurrentPostType?.();
		const title = editor?.getEditedPostAttribute?.( 'title' );

		if ( postType ) {
			notes.push( `The user is editing a "${ postType }".` );
		}
		if ( title ) {
			notes.push( `Its title is "${ title }".` );
		}

		// The selected block is not described here: it is the attachment's
		// to send, and leaving it out is what removing the attachment means.
	} catch {
		// A partial context is better than failing the request.
	}

	notes.push(
		'Block editor tools act on this post. Read the block tree before changing it, and use client IDs from a read tool rather than guessing.'
	);

	return { screen: 'block editor', notes: notes.join( ' ' ) };
}

interface BlockSnapshot {
	clientId: string;
	name: string;
	attributes: Record< string, unknown >;
	innerBlocks: BlockSnapshot[];
	truncatedInnerBlockCount?: number;
}

/**
 * A block and its inner blocks, to a depth. Children come from `getBlocks()`,
 * which, unlike `getBlock()`, sees inside synced patterns and template parts.
 */
function snapshotBlock(
	store: BlockEditorSelectors,
	block: EditorBlock,
	maxDepth: number,
	depth = 0
): BlockSnapshot {
	const children = store.getBlocks?.( block.clientId ) ?? [];
	const node: BlockSnapshot = {
		clientId: block.clientId,
		name: block.name,
		attributes: block.attributes ?? {},
		innerBlocks: [],
	};

	if ( depth >= maxDepth ) {
		if ( children.length ) {
			node.truncatedInnerBlockCount = children.length;
		}
		return node;
	}

	node.innerBlocks = children.map( ( child ) =>
		snapshotBlock( store, child, maxDepth, depth + 1 )
	);
	return node;
}

function isTruncated( node: BlockSnapshot | undefined ): boolean {
	return (
		!! node &&
		( !! node.truncatedInnerBlockCount ||
			node.innerBlocks.some( isTruncated ) )
	);
}

/**
 * Context for an attached block, read as it is now. Deeper inner blocks are
 * dropped until it fits; the server names a block that still does not.
 */
function getAttachedBlockContext(
	clientId: string
): Record< string, unknown > {
	try {
		const store = window.wp?.data?.select( 'core/block-editor' );
		const block = store?.getBlock?.( clientId );

		// The block may have been removed since it was attached.
		if ( ! store || ! block ) {
			return {};
		}

		let snapshot: BlockSnapshot | undefined;
		for ( const depth of [ Infinity, 2, 1, 0 ] ) {
			snapshot = snapshotBlock( store, block, depth );
			if ( JSON.stringify( snapshot ).length <= ATTACHMENT_CHARS ) {
				break;
			}
		}

		return {
			attachedBlock: { ...snapshot, truncated: isTruncated( snapshot ) },
		};
	} catch {
		return {};
	}
}

/** "Paragraph: Welcome to…", or just the block title when it has no text. */
function describeBlock( block: EditorBlock ): string {
	const blocks = window.wp?.blocks;
	const blockType = blocks?.getBlockType?.( block.name );
	const title = blockType?.title || block.name;

	let text = '';
	try {
		text =
			// The 'accessibility' context is the one where text blocks
			// report their text rather than only their title.
			blocks?.__experimentalGetBlockLabel?.(
				blockType,
				block.attributes ?? {},
				'accessibility'
			) ?? '';
	} catch {
		// The title alone is enough.
	}

	text = text
		.replace( /<[^>]*>/g, '' )
		.replace( /\s+/g, ' ' )
		.trim();

	if ( ! text || text === title ) {
		return title;
	}

	return text.length > LABEL_EXCERPT_CHARS
		? `${ title }: ${ text.slice( 0, LABEL_EXCERPT_CHARS ).trimEnd() }…`
		: `${ title }: ${ text }`;
}

/**
 * A block the user chose to attach, with the paperclip.
 *
 * Nothing is attached until they ask: people usually click a block before
 * opening the chat, so the selection alone says little about what the next
 * message is about. The paperclip attaches the selected block, or, when none
 * is selected or it is already attached, the next block the user clicks. Once
 * attached, a block stays until it is removed or deleted from the post.
 */
function useBlockAttachment(): {
	attachment: ChatAttachment | null;
	picking: boolean;
	attach: () => void;
	clear: () => void;
} {
	// registerChatSidebar() checked for it before mounting this.
	const useSelect = window.wp!.data!.useSelect!;

	const [ attachedId, setAttachedId ] = React.useState< string | null >(
		null
	);
	const [ picking, setPicking ] = React.useState( false );

	const selectedId = useSelect(
		( select ) =>
			select( 'core/block-editor' )?.getSelectedBlockClientId?.() ?? ''
	);

	// A string, so an unrelated store change does not re-render. Empty once
	// the block is gone.
	const label = useSelect( ( select ) => {
		const block = attachedId
			? select( 'core/block-editor' )?.getBlock?.( attachedId )
			: null;
		return block ? describeBlock( block ) : '';
	} );

	// Picking starts with nothing selected, so any selection is the pick.
	React.useEffect( () => {
		if ( picking && selectedId ) {
			setAttachedId( selectedId );
			setPicking( false );
		}
	}, [ picking, selectedId ] );

	// A deleted block has nothing left to attach.
	React.useEffect( () => {
		if ( attachedId && ! label ) {
			setAttachedId( null );
		}
	}, [ attachedId, label ] );

	const attach = React.useCallback( () => {
		if ( picking ) {
			setPicking( false );
			return;
		}
		if ( selectedId && selectedId !== attachedId ) {
			setAttachedId( selectedId );
			return;
		}
		// Clear the selection so that clicking even the selected block
		// counts as picking it.
		window.wp?.data
			?.dispatch?.( 'core/block-editor' )
			?.clearSelectedBlock?.();
		setPicking( true );
	}, [ attachedId, picking, selectedId ] );

	const clear = React.useCallback( () => {
		setAttachedId( null );
		setPicking( false );
	}, [] );

	const attachment = React.useMemo< ChatAttachment | null >(
		() =>
			attachedId && label
				? {
						id: attachedId,
						label,
						getContext: () => getAttachedBlockContext( attachedId ),
					}
				: null,
		[ attachedId, label ]
	);

	return { attachment, picking, attach, clear };
}

function ChatSidebar() {
	const { attachment, picking, attach, clear } = useBlockAttachment();

	return (
		<ChatPanel
			getContext={ getEditorContext }
			attachment={ attachment }
			onClearAttachment={ clear }
			attach={ {
				label: 'Attach a block',
				description:
					'Attach the selected block, or the next block you click',
				pickingLabel: 'Click a block in the editor to attach it…',
				picking,
				onToggle: attach,
			} }
			suggestions={ SUGGESTIONS }
		/>
	);
}

const SUGGESTIONS = [
	'Summarize the blocks in this post.',
	'Add a two-column layout below the first paragraph.',
];

function registerChatSidebar() {
	// Classic scripts all run before this deferred module, so what is not
	// here now was never enqueued; see src/lib/wp.ts.
	const wp = window.wp;

	if (
		! wp?.plugins?.registerPlugin ||
		! wp.data?.useSelect ||
		! ( wp.editor?.PluginSidebar || wp.editPost?.PluginSidebar )
	) {
		console.warn(
			'[agentic-editor] The block editor sidebar API is unavailable, so the chat sidebar was not added.'
		);
		return;
	}

	const PluginSidebar = ( wp.editor?.PluginSidebar ??
		wp.editPost?.PluginSidebar )!;

	wp.plugins.registerPlugin( SIDEBAR_NAME, {
		render: () => (
			<PluginSidebar
				name={ SIDEBAR_NAME }
				title="AI Chat"
				icon="format-chat"
				className="cdchat-sidebar"
			>
				<ChatSidebar />
			</PluginSidebar>
		),
	} );
}

try {
	registerChatSidebar();
} catch ( error ) {
	console.error(
		'[agentic-editor] Failed to register the chat sidebar:',
		error
	);
}
