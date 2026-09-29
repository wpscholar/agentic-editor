/**
 * Server-supplied chat configuration.
 *
 * Script modules cannot be localized, so PHP prints this as JSON through the
 * `script_module_data_*` filter and the module reads it back on load.
 */

const DATA_ELEMENT_ID = 'wp-script-module-data-@agentic-editor/chat-config';

const defaults = {
	restUrl: '',
	nonce: '',
	nonceUrl: '',
	available: false,
	connectorsUrl: null,
	maxToolRounds: 25,
	siteName: '',
};

/**
 * @return {Object}
 */
function readConfig() {
	const element = document.getElementById( DATA_ELEMENT_ID );
	if ( ! element ) {
		return { ...defaults };
	}

	try {
		return { ...defaults, ...JSON.parse( element.textContent ) };
	} catch ( error ) {
		console.warn(
			'[agentic-editor] Could not read the chat configuration:',
			error
		);
		return { ...defaults };
	}
}

export const chatConfig = readConfig();
