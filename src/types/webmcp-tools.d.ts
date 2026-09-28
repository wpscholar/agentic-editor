/**
 * Types for the WebMCP tool layer.
 *
 * The implementation lives in `js/webmcp-tools.js` and stays outside this
 * bundle so that the chat and the ability bridge share one tool registry. It is
 * resolved at runtime through the WordPress import map, so only the shape is
 * described here.
 */

declare module '@agentic-editor/webmcp-tools' {
	export interface WebMcpTool {
		name: string;
		description: string;
		inputSchema?: Record< string, unknown >;
		annotations?: Record< string, unknown >;
		source: 'local' | 'webmcp';
		/** Why each call needs a person's approval; only set on local tools. */
		approval?: string;
		/** How long to wait for a call, when longer than usual; only set on local tools. */
		timeoutMs?: number;
	}

	export interface WebMcpToolResult {
		isError: boolean;
		value: unknown;
		text: string;
	}

	export function listTools(): Promise< WebMcpTool[] >;

	export function callTool(
		name: string,
		args?: Record< string, unknown >
	): Promise< WebMcpToolResult >;

	export function onToolsChanged( listener: () => void ): () => void;
}
