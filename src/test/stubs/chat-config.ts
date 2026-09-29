import type { ChatConfig } from '@agentic-editor/chat-config';

/** Stands in for js/chat/config.js; tests may change it. */
export const chatConfig: ChatConfig = {
	restUrl: 'http://example.test/wp-json/agentic-editor/v1/chat',
	nonce: 'nonce',
	nonceUrl: 'http://example.test/wp-admin/admin-ajax.php?action=rest-nonce',
	available: true,
	connectorsUrl: null,
	maxToolRounds: 25,
	siteName: 'Test',
};
