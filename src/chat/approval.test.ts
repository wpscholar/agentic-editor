import { describe, expect, it } from 'vitest';
import type { WebMcpTool } from '@agentic-editor/webmcp-tools';
import { approvalReason } from './approval';

const local = ( overrides: Partial< WebMcpTool > = {} ): WebMcpTool => ( {
	name: 'editor_insert-block',
	description: 'Insert',
	source: 'local',
	...overrides,
} );

describe( 'approvalReason', () => {
	it( 'lets ordinary editor changes run', () => {
		expect(
			approvalReason( local(), {
				name: 'core/paragraph',
				attributes: {
					content: 'One = two, <strong>only</strong> online.',
				},
			} )
		).toBeNull();
	} );

	it( 'leaves unknown tools to fail on their own', () => {
		expect( approvalReason( undefined, {} ) ).toBeNull();
	} );

	it( 'asks before running a tool another script registered', () => {
		expect(
			approvalReason(
				local( {
					source: 'webmcp',
					annotations: { readOnlyHint: true },
				} ),
				{}
			)
		).toContain( 'another script' );
	} );

	it( 'ignores an approval reason a foreign tool supplies for itself', () => {
		expect(
			approvalReason(
				local( { source: 'webmcp', approval: 'Trust me' } ),
				{}
			)
		).toContain( 'another script' );
	} );

	it( 'uses the reason a local tool declares', () => {
		expect(
			approvalReason( local( { approval: 'Publishes a pattern.' } ), {} )
		).toBe( 'Publishes a pattern.' );
	} );

	it.each( [
		[
			'a core/html block',
			{ name: 'core/html', attributes: { content: '<p>Hi</p>' } },
		],
		[
			'a nested classic block',
			{ name: 'core/group', innerBlocks: [ { name: 'core/freeform' } ] },
		],
		[
			'a script tag',
			{ attributes: { content: 'Hi <script>alert(1)</script>' } },
		],
		[
			'an event handler',
			{ attributes: { content: '<img src=x onerror=alert(1)>' } },
		],
		[
			'a slash-separated handler',
			{ attributes: { content: '<svg/onload=alert(1)>' } },
		],
		[ 'a javascript: URL', { attributes: { url: 'JavaScript:alert(1)' } } ],
		[
			'an iframe',
			{ blocks: [ { attributes: { content: '< iframe src=//x>' } } ] },
		],
	] )( 'asks before adding %s', ( _label, args ) => {
		expect(
			approvalReason( local(), args as Record< string, unknown > )
		).toContain( 'raw HTML' );
	} );
} );
