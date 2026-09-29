/**
 * React, taken from the copy WordPress already put on the page.
 *
 * WordPress registers React as a classic script that assigns `window.React`.
 * Bundling a second copy is the single biggest cause of plugin breakage on the
 * React 19 upgrade, because elements created by one runtime are rejected by the
 * other, so every `react` import in this bundle is aliased here instead.
 *
 * The export list is written out by hand: an ES module has no way to re-export
 * an object's properties dynamically, and the bundler needs to see each name at
 * build time to link it.
 */

import type * as ReactNamespace from 'react';

declare global {
	interface Window {
		React?: typeof ReactNamespace;
	}
}

const React = window.React;

if ( ! React ) {
	throw new Error(
		'[agentic-editor] window.React is missing. Enqueue the "react" script before this module.'
	);
}

export default React;

export const {
	Children,
	Component,
	Fragment,
	Profiler,
	PureComponent,
	StrictMode,
	Suspense,
	cloneElement,
	createContext,
	createElement,
	createRef,
	forwardRef,
	isValidElement,
	lazy,
	memo,
	startTransition,
	useCallback,
	useContext,
	useDebugValue,
	useDeferredValue,
	useEffect,
	useId,
	useImperativeHandle,
	useInsertionEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
	useTransition,
	version,
} = React;
