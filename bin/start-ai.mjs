#!/usr/bin/env node
/**
 * Start Playground with the Google AI connector (`npm run start:ai`).
 *
 * The API key comes from GOOGLE_API_KEY and is handed to WordPress through a
 * temporary blueprint rather than on the command line, where `ps` would show
 * it to anyone on the machine. Playground's PHP does not see the host's
 * environment, so it has to be defined one way or the other. The blueprint is
 * readable only by you and deleted when Playground exits.
 *
 * Extra arguments pass through to `wp-playground-cli start`, e.g. `--reset`.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const key = process.env.GOOGLE_API_KEY?.trim();
if ( ! key ) {
	process.stderr.write(
		'GOOGLE_API_KEY is not set. Export a Gemini API key first, e.g.\n\n  GOOGLE_API_KEY=… npm run start:ai\n\nor use `npm start` for a site without a connector.\n'
	);
	process.exit( 1 );
}

const root = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const blueprint = JSON.parse(
	readFileSync(
		join( root, 'bin/blueprints/install-google-connector.json' ),
		'utf8'
	)
);
blueprint.steps.unshift( {
	step: 'defineWpConfigConsts',
	consts: { GOOGLE_API_KEY: key },
} );

const dir = mkdtempSync( join( tmpdir(), 'agentic-editor-ai-' ) );
const blueprintPath = join( dir, 'blueprint.json' );
writeFileSync( blueprintPath, JSON.stringify( blueprint ), { mode: 0o600 } );

const cleanup = () => rmSync( dir, { recursive: true, force: true } );
process.on( 'exit', cleanup );

const cli = join(
	root,
	'node_modules/.bin',
	process.platform === 'win32' ? 'wp-playground-cli.cmd' : 'wp-playground-cli'
);
const child = spawn(
	cli,
	[
		'start',
		'--skip-browser',
		'--wp=latest',
		'--blueprint',
		blueprintPath,
		...process.argv.slice( 2 ),
	],
	{ stdio: 'inherit', cwd: root, shell: process.platform === 'win32' }
);

for ( const signal of [ 'SIGINT', 'SIGTERM' ] ) {
	process.on( signal, () => child.kill( signal ) );
}
child.on( 'exit', ( code, signal ) => {
	cleanup();
	process.exit( code ?? ( signal ? 1 : 0 ) );
} );
