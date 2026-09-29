/** Stands in for `@wordpress/abilities`; tests replace it with `vi.mock`. */
export function getAbility(): unknown {
	throw new Error( 'getAbility is not mocked' );
}

export async function executeAbility(): Promise< unknown > {
	throw new Error( 'executeAbility is not mocked' );
}
