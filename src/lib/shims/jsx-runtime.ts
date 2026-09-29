/**
 * The automatic JSX runtime, taken from WordPress.
 *
 * WordPress 7.0 ships this as the `react-jsx-runtime` script, which assigns
 * `window.ReactJSXRuntime`. PHP enqueues it on every screen the chat loads on,
 * so a missing global is an enqueue bug, reported as one rather than papered
 * over with a slower runtime that also hides React's key warnings.
 */

type JsxFactory = (
	type: unknown,
	props: Record< string, unknown >,
	key?: string
) => unknown;

interface JsxRuntimeGlobal {
	jsx: JsxFactory;
	jsxs: JsxFactory;
	jsxDEV?: JsxFactory;
	Fragment: unknown;
}

declare global {
	interface Window {
		ReactJSXRuntime?: JsxRuntimeGlobal;
	}
}

const runtime = window.ReactJSXRuntime;
if ( ! runtime ) {
	throw new Error(
		'[agentic-editor] window.ReactJSXRuntime is missing. Enqueue the react-jsx-runtime script on this screen.'
	);
}

export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const jsxDEV = runtime.jsxDEV ?? runtime.jsx;
