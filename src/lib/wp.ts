/**
 * The bits of the WordPress global this bundle reads.
 *
 * These are classic scripts (`wp-plugins`, `wp-editor`, …). Script modules are
 * deferred, so they run after every classic script on the page, footer ones
 * included: if PHP enqueued them, they are already here, and there is nothing
 * to wait for.
 */

import type * as React from 'react';

interface PluginSidebarProps {
	name: string;
	title: string;
	icon?: string;
	className?: string;
	children?: React.ReactNode;
}

export interface WordPressGlobal {
	plugins?: {
		registerPlugin: (
			name: string,
			settings: { render: () => React.ReactNode; icon?: string }
		) => void;
	};
	editor?: {
		PluginSidebar?: React.ComponentType< PluginSidebarProps >;
	};
	editPost?: {
		PluginSidebar?: React.ComponentType< PluginSidebarProps >;
	};
	data?: {
		select: EditorSelect;
		useSelect?: < T >( mapSelect: ( select: EditorSelect ) => T ) => T;
		dispatch?: (
			store: 'core/block-editor'
		) => { clearSelectedBlock?: () => void } | undefined;
	};
	blocks?: {
		getBlockType?: (
			name: string
		) => { title?: string } | null | undefined;
		__experimentalGetBlockLabel?: (
			blockType: unknown,
			attributes: Record< string, unknown >,
			context?: string
		) => string;
	};
}

/** A block as `core/block-editor` stores it. */
export interface EditorBlock {
	clientId: string;
	name: string;
	attributes?: Record< string, unknown >;
}

/** The few `core/editor` selectors the sidebar reads. */
export interface EditorSelectors {
	getCurrentPostType?: () => string | null | undefined;
	getEditedPostAttribute?: ( attribute: string ) => unknown;
}

/** The few `core/block-editor` selectors the sidebar reads. */
export interface BlockEditorSelectors {
	getSelectedBlockClientId?: () => string | null | undefined;
	getBlock?: ( clientId: string ) => EditorBlock | null | undefined;
	/**
	 * Inner blocks, including those a controller such as a synced pattern
	 * owns, which `getBlock()` reports as having no children.
	 */
	getBlocks?: ( rootClientId?: string ) => EditorBlock[] | undefined;
}

interface EditorSelect {
	( store: 'core/editor' ): EditorSelectors | undefined;
	( store: 'core/block-editor' ): BlockEditorSelectors | undefined;
}

declare global {
	interface Window {
		wp?: WordPressGlobal;
	}
}
