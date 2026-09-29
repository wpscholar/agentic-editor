/**
 * Which tool calls wait for a person to approve them.
 *
 * Tool calls run without asking by default: editor changes are what the chat
 * is for, and undo takes them back. A call waits for approval only when undo
 * cannot help or when nothing vouches for the tool:
 *
 * - the tool says it needs approval (it does something undo cannot reverse,
 *   such as publishing a pattern);
 * - another script on the page registered it, so this plugin cannot know what
 *   it does;
 * - its arguments carry markup that can run script once the post is viewed,
 *   which is how a prompt injected through page content would do real harm.
 */

import type { WebMcpTool } from '@agentic-editor/webmcp-tools';

/** Blocks whose content is saved as raw HTML. */
const RAW_HTML_BLOCKS = new Set( [ 'core/html', 'core/freeform' ] );

/**
 * Script tags, embedding tags, inline event handlers and `javascript:` URLs.
 * Deliberately broad: a false positive costs one click, a miss costs a stored
 * script on the site.
 */
const SCRIPT_LIKE =
	/<\s*(?:script|iframe|object|embed)\b|<[^>]*[\s/"']on[a-z]+\s*=|javascript\s*:/i;

const RAW_HTML_REASON =
	'This adds raw HTML, which can run scripts for everyone who views the post.';

const FOREIGN_REASON =
	'This tool was added to the page by another script, not by Agentic Editor, so what it does cannot be vouched for.';

/**
 * Find script-capable content anywhere in a tool call's arguments.
 *
 * @param value Arguments, or any value nested in them.
 */
function carriesRawHtml( value: unknown, depth = 0 ): boolean {
	if ( depth > 64 ) {
		// Deeper than any real block tree; refuse to vouch for it.
		return true;
	}

	if ( typeof value === 'string' ) {
		return SCRIPT_LIKE.test( value );
	}

	if ( Array.isArray( value ) ) {
		return value.some( ( item ) => carriesRawHtml( item, depth + 1 ) );
	}

	if ( value && typeof value === 'object' ) {
		const record = value as Record< string, unknown >;
		if (
			typeof record.name === 'string' &&
			RAW_HTML_BLOCKS.has( record.name )
		) {
			return true;
		}
		return Object.values( record ).some( ( item ) =>
			carriesRawHtml( item, depth + 1 )
		);
	}

	return false;
}

/**
 * Why a tool call needs approval, or null when it can run straight away.
 *
 * @param tool The tool as the page lists it, if it is on the page at all.
 * @param args The arguments the model supplied.
 */
export function approvalReason(
	tool: WebMcpTool | undefined,
	args: Record< string, unknown >
): string | null {
	// A name the page does not offer fails on its own as an unknown tool.
	if ( ! tool ) {
		return null;
	}

	if ( tool.source !== 'local' ) {
		return FOREIGN_REASON;
	}

	if ( tool.approval ) {
		return tool.approval;
	}

	if ( carriesRawHtml( args ) ) {
		return RAW_HTML_REASON;
	}

	return null;
}
