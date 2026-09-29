/**
 * Agentic Editor — editor abilities + WebMCP bridge entry point.
 *
 * A module runs once per page, so this bootstraps once. Registering again
 * (from the console, say) is harmless: abilities are only registered when
 * missing, and the bridge treats a tool that already exists as registered.
 */

import { registerEditorAbilities } from '@agentic-editor/abilities';
import {
	bridgeAbilitiesToWebMCP,
	isWebMCPSupported,
	toToolName,
} from '@agentic-editor/webmcp-bridge';

async function bootstrap() {
	// Register abilities + WebMCP tools immediately. Ability callbacks already
	// guard on the block editor store when executed.
	const abilityNames = registerEditorAbilities();

	// Published before bridging so the global is inspectable while the
	// bridge registers tools.
	window.agenticEditorAbilities = {
		abilityNames,
		webmcp: null,
		isWebMCPSupported: isWebMCPSupported(),
	};

	const bridgeResult = await bridgeAbilitiesToWebMCP( abilityNames );

	window.agenticEditorAbilities = {
		abilityNames,
		webmcp: bridgeResult,
		isWebMCPSupported: isWebMCPSupported(),
	};

	if ( bridgeResult.supported ) {
		console.info(
			'[agentic-editor] Registered editor abilities with WebMCP:',
			bridgeResult.registered.map( toToolName )
		);
	} else {
		console.info(
			'[agentic-editor] Editor abilities registered, but WebMCP is unavailable and the polyfill could not install (this page may not be a secure context).',
			abilityNames
		);
	}
}

bootstrap().catch( ( error ) => {
	console.error(
		'[agentic-editor] Failed to bootstrap editor abilities:',
		error
	);
} );
