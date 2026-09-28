/**
 * Client-side block editor abilities.
 *
 * These run in the browser against the live block editor stores and are
 * discoverable via `@wordpress/abilities` (and WebMCP via the bridge).
 *
 * Each ability category lives in its own module under ./abilities/, with
 * shared helpers factored into ./abilities/shared.js.
 */

import { registerBlockEditorAbilities } from '@agentic-editor/abilities/block-editor';
import { registerPatternAbilities } from '@agentic-editor/abilities/patterns';
import { registerMediaAbilities } from '@agentic-editor/abilities/media';

/**
 * Register the block-editor category and its abilities.
 *
 * @return {string[]} Registered ability names.
 */
export function registerEditorAbilities() {
	return [
		...registerBlockEditorAbilities(),
		...registerPatternAbilities(),
		...registerMediaAbilities(),
	];
}
