import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelContext } from './webmcp-polyfill.js';

afterEach( () => vi.unstubAllGlobals() );

describe( 'getModelContext', () => {
	it( 'prefers a partial document context over the navigator alias', () => {
		const native = { registerTool: () => {} };
		vi.stubGlobal( 'document', { modelContext: native } );
		vi.stubGlobal( 'navigator', { modelContext: {} } );
		expect( getModelContext() ).toBe( native );
	} );

	it( 'falls back to the older navigator context', () => {
		const legacy = { registerTool: () => {} };
		vi.stubGlobal( 'document', {} );
		vi.stubGlobal( 'navigator', { modelContext: legacy } );
		expect( getModelContext() ).toBe( legacy );
	} );

	it( 'returns null when no context is available', () => {
		vi.stubGlobal( 'document', {} );
		vi.stubGlobal( 'navigator', {} );
		expect( getModelContext() ).toBeNull();
	} );
} );
