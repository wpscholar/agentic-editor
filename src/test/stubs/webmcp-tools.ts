import type {
	WebMcpTool,
	WebMcpToolResult,
} from '@agentic-editor/webmcp-tools';

/** Stands in for js/webmcp-tools.js; tests replace it with `vi.mock`. */
export async function listTools(): Promise< WebMcpTool[] > {
	return [];
}

export async function callTool(): Promise< WebMcpToolResult > {
	throw new Error( 'callTool is not mocked' );
}

export function onToolsChanged(): () => void {
	return () => {};
}
