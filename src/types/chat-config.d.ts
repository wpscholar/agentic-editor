/**
 * Types for the server-supplied chat configuration.
 *
 * The implementation is `js/chat/config.js`, kept outside this bundle so that
 * the `script_module_data_@agentic-editor/chat-config` filter that PHP uses to
 * print the JSON keeps working as-is.
 */

declare module '@agentic-editor/chat-config' {
	export interface ChatConfig {
		restUrl: string;
		nonce: string;
		nonceUrl: string;
		available: boolean;
		connectorsUrl: string | null;
		maxToolRounds: number;
		siteName: string;
	}

	export const chatConfig: ChatConfig;
}
