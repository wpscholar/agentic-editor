/**
 * Ambient types for type-checking js/ with `checkJs`.
 *
 * The WordPress globals are loose on purpose: js/ reads them defensively and
 * reports what is missing at runtime, so the checker only needs to know they
 * may exist.
 */

declare module '@wordpress/abilities' {
	export function registerAbility( ability: Record< string, unknown > ): void;
	export function registerAbilityCategory(
		slug: string,
		args: Record< string, unknown >
	): void;
	export function getAbility( name: string ): any;
	export function getAbilityCategory( slug: string ): any;
	export function executeAbility(
		name: string,
		input?: unknown
	): Promise< unknown >;
}

interface Window {
	wp?: any;
	agenticEditorAbilities?: unknown;
	/** The vendored polyfill's IIFE global. */
	WebMCPPolyfill?: unknown;
}

/** The parts of WebMCP's ModelContext that js/ uses. */
interface ModelContext {
	registerTool: (
		tool: Record< string, unknown >
	) => Promise< unknown > | unknown;
	getTools?: () => Promise< any[] >;
	executeTool?: ( tool: unknown, inputJson: string ) => Promise< unknown >;
	addEventListener?: ( type: string, listener: () => void ) => void;
}

interface Document {
	modelContext?: any;
}

interface Navigator {
	modelContext?: any;
	modelContextTesting?: any;
}
