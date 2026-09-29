/**
 * WebMCP environment.
 *
 * Chrome only exposes `document.modelContext` behind a flag, so the polyfill is
 * enqueued as a classic script alongside anything that needs WebMCP. It
 * installs itself on load and steps aside when the browser has native support,
 * which means one code path covers flagged Chrome, unflagged Chrome, and other
 * browsers.
 *
 * This module only reports on that environment; it never installs anything.
 *
 * @see https://www.npmjs.com/package/@mcp-b/webmcp-polyfill
 */

/**
 * @return {Object|null} The model context, or null when there is none.
 */
export function getModelContext() {
	if ( typeof document !== 'undefined' && document.modelContext ) {
		return document.modelContext;
	}
	// Deprecated alias, still the only surface on older Chromium builds.
	if ( typeof navigator !== 'undefined' && navigator.modelContext ) {
		return navigator.modelContext;
	}
	return null;
}
