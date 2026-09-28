# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project purpose

This repo **is** a WordPress plugin (not an app with a nested plugin folder). The project root mounts into Playground as `wp-content/plugins/agentic-editor`.

Two goals:

1. Register **client-side** block editor abilities with `@wordpress/abilities`, then expose them to browser agents via **WebMCP** (`document.modelContext.registerTool`).
2. Ship a **chat panel** that consumes those WebMCP tools and runs prompts through the WordPress 7.0 **AI Client** (`wp_ai_client_prompt()`), so the site's own connector answers.

## Stack constraints

- **WordPress 7.0+** required (`wp_enqueue_script_module`, `@wordpress/abilities`, `wp_ai_client_prompt`), and **PHP 8.0+**. Local development runs the latest WordPress; CI runs e2e on WordPress {7.0, latest} × PHP 8.0–8.5
- **Two layers, two build stories.** The abilities and WebMCP layer under `js/` is hand-written native ESM with no build step; WordPress import maps resolve its bare specifiers. The chat panel under `src/` is a React app built with Vite into `build/`
- **React comes from WordPress, never from the bundle.** WordPress 7.0 ships React 18.3 as the `react`, `react-dom`, and `react-jsx-runtime` classic scripts. The build aliases every React specifier to a shim that re-exports those globals
- **PHP** bootstraps, enqueues, and owns the AI Client; all ability and UI logic is client-side JS
- **Playground CLI** (`@wp-playground/cli`) for local WordPress; `npm start` auto-mounts CWD as the plugin

## Key files

| Path | Responsibility |
| --- | --- |
| `agentic-editor.php` | Plugin header, includes, `enqueue_block_editor_assets` |
| `includes/chat-rest.php` | `/agentic-editor/v1/chat` — one AI Client turn per request |
| `includes/image-rest.php` | `/agentic-editor/v1/image` — generate one image, sideload it into the Media Library; `agentic_editor_image_is_available()` |
| `includes/chat-assets.php` | Script module registration, polyfill script, per-screen config |
| `js/index.js` | Bootstrap: abilities → WebMCP bridge; sets `window.agenticEditorAbilities` |
| `js/abilities.js` | Aggregates the ability modules into one `registerEditorAbilities()` |
| `js/abilities/block-editor.js` | Block tree, insert/move/update/remove, transforms, selection, undo/redo |
| `js/abilities/patterns.js` | Pattern and synced-pattern abilities |
| `js/abilities/media.js` | `editor/generate-image`, registered only when PHP says the connector can generate images |
| `js/abilities/shared.js` | Category, `registerAbilities`, store access, lock and nesting checks |
| `js/webmcp-bridge.js` | Maps abilities to WebMCP tools; feature-detects `document.modelContext` |
| `js/webmcp-polyfill.js` | `getModelContext()`: finds `document.modelContext` (or the deprecated `navigator` alias); installs nothing |
| `js/webmcp-tools.js` | Consumer side: list and call the page's tools |
| `js/chat/config.js` | Reads the server config JSON; the only hand-written chat module left |
| `js/types/globals.d.ts` | Loose types for the WordPress and WebMCP globals, for `checkJs` |
| `vite.config.ts` | Build: React aliased to WordPress globals, one entry per mount, one stylesheet |
| `src/lib/shims/*` | Re-export `window.React` / `ReactDOM` / `ReactJSXRuntime` as ES modules |
| `src/chat/transport.ts` | The AI SDK `ChatTransport`: one REST turn per round plus the tool loop |
| `src/chat/transport.test.ts` | Vitest coverage of the tool loop; `vitest.config.ts` stubs the import-map externals |
| `js/*.test.js` | Vitest coverage of the WebMCP consumer and bridge. They sit beside the modules for `checkJs`, and `bin/build-zip.sh` strips them |
| `src/chat/approval.ts` | Which tool calls wait for Approve/Deny |
| `src/components/chat-panel.tsx` | The panel: `useChat`, transcript, composer |
| `src/components/tool-call.tsx` | One tool call inline in the assistant turn, with its approval buttons |
| `src/components/reasoning.tsx` | The model's thinking, collapsed above the answer |
| `src/components/markdown.tsx` | Model output → React elements; never `dangerouslySetInnerHTML` |
| `src/lib/wp.ts` | Typed access to `window.wp` for the editor entry |
| `src/components/ui/*` | shadcn components — regenerate with the CLI, don't hand-edit |
| `src/entries/*.tsx` | One file per mount; the editor sidebar is the only one |
| `css/chat-chrome.css` | Layout for the wp-admin containers *around* the panel |
| `bin/build-zip.sh` | Packaging; runs `npm run build` and strips source maps |
| `bin/vendor-webmcp-polyfill.sh` | Re-copies the vendored polyfill from `node_modules` |
| `bin/blueprints/` | Playground blueprints; `install-google-connector.json` (pinned connector version) backs `npm run start:ai` |
| `bin/start-ai.mjs` | `npm run start:ai`: passes `GOOGLE_API_KEY` to WordPress through a private temporary blueprint, never on the command line |
| `tests/e2e/` | Playwright against Playground: abilities, bridge, chat REST, panel, permissions |
| `tests/phpunit/` | PHPUnit coverage of `chat-rest.php`: Brain Monkey for WordPress functions, the real AI Client DTOs |
| `eslint.config.mjs`, `phpcs.xml.dist`, `phpstan.neon.dist` | Lint configs; see "Linting and types" |
| `.github/workflows/` | CI (build, lint, PHPUnit, the e2e version matrix) and the release zip |

## Conventions

### Abilities

- Ability names: `editor/<slug>` (e.g. `editor/get-editor-tree`)
- Category slug: `block-editor`
- Registration must be **idempotent** (`getAbility` / `getAbilityCategory` before register). Duplicate registration throws and can abort bootstrap.
- Define `input_schema` / `output_schema` (JSON Schema) and `meta.annotations` (`readonly`, `destructive`, `idempotent`)
- Plugin-specific hints live under `meta.agenticEditor`, never in `meta.annotations`:
  - `untrustedContent: true` for anything returning content people wrote (blocks, patterns, terms). The bridge maps it to WebMCP's `untrustedContentHint`
  - `approval: '<why>'` for anything editor undo cannot take back. The chat asks the user before each call and shows this text
  - `timeoutMs: <ms>` for anything slower than the chat's 30-second tool limit (image generation). The bridge hands it to local consumers only, and the transport caps it at `MAX_TOOL_TIMEOUT_MS`
- An ability that depends on what the site's connectors can do (`editor/generate-image`) is registered only when PHP reports support through its module's `script_module_data_*` filter. A tool the model can see but never use invites it to fail, or to improvise around it
- Media must come from the Media Library. Never let an ability, or the system instruction, send the model to a URL it found or made up; generated files are sideloaded and referenced by attachment `id` and local `url`
- Every `type: 'array'` in an **input** schema needs `items`, at every depth. Gemini rejects a function declaration without it and fails the whole chat request, not just that one tool. Output schemas are never sent to a provider, so they are free to be loose
- Callbacks may assume they run in the block editor; guard with the `core/block-editor` store and throw clear errors otherwise
- Use `window.wp.data` and `window.wp.blocks` (classic globals). Only `@wordpress/abilities` is imported as a script module
- Anything backed by REST (patterns, `wp_block` posts, taxonomy terms) must be read with `wp.data.resolveSelect`, not `select` — a plain select returns nothing until the resolver finishes
- Walking the block tree must go through `getInnerBlocks()`: `getBlock()` reports no children for inner block controllers (synced patterns, template parts), so a plain `innerBlocks` walk goes blind inside them

### WebMCP bridge

- Prefer `document.modelContext`; fall back to `navigator.modelContext`
- Tool name = ability name with `/` → `_` (e.g. `editor_insert-block`)
- **Do not pass `AbortSignal`** for these page-lifetime editor tools. Aborting the signal unregisters tools and caused “tools appear then vanish” in the inspector
- WebMCP `annotations` only support `readOnlyHint` / `untrustedContentHint` — do not pass WordPress-only keys like `destructiveHint`
- Tool name charset (spec): ASCII alphanumerics, `_`, `-`, `.` (max 128). No `/`
- Treat “already registered” / `InvalidStateError` as success on re-bootstrap
- Execute path: WebMCP `execute` → `executeAbility(name, input)` → ability callback

### WebMCP polyfill

- The polyfill is vendored from `@mcp-b/webmcp-polyfill` and enqueued as a **classic script**, not a module. Its ESM build imports `@cfworker/json-schema` as a bare specifier that nothing here would resolve; the IIFE build inlines it and self-initializes on load
- Do not edit `js/vendor/` by hand — run `npm run vendor`
- Classic scripts execute before deferred modules, so `document.modelContext` is present by the time modules run. Never add `defer`/`async` to the polyfill handle
- Anything that registers or consumes WebMCP tools must enqueue `agentic-editor-webmcp-polyfill`

### Chat

- The AI Client is **PHP-only** in 7.0. Core recommends a purpose-built REST endpoint per feature rather than a generic prompt endpoint, which is what `includes/chat-rest.php` is
- The endpoint runs **one** model turn. The browser owns conversation state and the tool-call loop, which keeps the endpoint stateless and lets the chat run on any screen. That loop lives in `WordPressAiTransport`, which presents it to `useChat` as a single streaming assistant message with a step boundary per round
- The endpoint returns thought-channel text as `reasoning`, and the transport emits it as AI SDK reasoning parts, shown collapsed above the answer and left out of the live region. Whether any arrives is up to the provider plugin; the chat never requests thinking, because the option is provider-specific and would reach whichever provider the model preference picks. Thoughts stay in `wire` for native replay but never enter a `historyMode: 'text'` transcript
- Every function call in `metadata.wire` must be followed by a tool turn answering it, or providers reject the replay. A round cut short (Stop, the round limit) answers its unrun calls with a "Not run" error. Emit `wire` as a fresh snapshot each time; the AI SDK stores the array it is given, so mutating one after emitting it changes the stored message
- Replay assistant turns from the `parts` the previous response returned, so function call IDs survive the trip through the browser. That is `historyMode: 'native'` and it is what every turn tries first. Those raw parts ride on the UI message's `metadata.wire`, because anything reconstructed from the rendered message would have lost them
- Gemini requires the thought signature it issued with a function call to come back with that call. The endpoint replays `thoughtSignature` whenever a part carries one, and the Google connector carries it from 1.2.0, but an older connector or another provider may not. A turn that fails that way is retried once as `historyMode: 'text'` (tool calls and results replayed as a transcript) and the client reports the working mode back, so a conversation discovers it at most once
- Image generation is a separate endpoint (`includes/image-rest.php`), not part of the chat turn: the chat's builder carries a text model preference, a system instruction and function declarations, and every one of those is a requirement an image model would have to meet. The image builder sets only the output orientation
- Tools come from the page, not from the server: `listTools()` reads whatever WebMCP has. Never hard-code a tool list into the chat
- `src/chat/approval.ts` decides which calls wait for Approve/Deny: tools other scripts registered, tools whose ability declares `meta.agenticEditor.approval`, and arguments carrying script-capable HTML. Ordinary editor edits run without asking, because undo reverts them. The transport pauses inside the stream until `respondToApproval()`, rather than ending it the way the AI SDK's own approval flow does
- Page context (`getContext`) is attached to the latest user message as `<page_context>`, never to the system instruction, since it can quote content other people wrote
- An attached block rides as `context.attachedBlock`. Attaching is explicit: the paperclip (the panel's `attach` prop, which only `src/entries/editor-sidebar.tsx` supplies) attaches the selected block or waits for the next one clicked, and the attachment then stays until removed or the block is deleted; selection changes alone never attach anything. The panel snapshots the attachment at send, but reads its contents every round. `getEditorContext()` deliberately says nothing about the selection, so no attachment means the model hears nothing about it. The server sends the block as `JSON_HEX_TAG` JSON inside `<attached_block>`, so its markup survives but cannot close `<page_context>`
- Rewrite tool names for providers (`[^a-zA-Z0-9_-]` → `_`, 64 chars) and map them back before the browser sees them. OpenAI rejects the dots WebMCP allows
- Client schemas are third-party input, so `agentic_editor_chat_prepare_schema()` makes them safe to send: `{}` decodes to an empty PHP array that would re-encode as `[]`, an array with no `items` fails the request outright, and union types (`['string','null']`) have no place in a function declaration
- The panel mounts anywhere, so keep `src/components/` free of editor packages — only `src/entries/editor-sidebar.tsx` may read `window.wp`
- Model output is rendered through `src/components/markdown.tsx`, which returns React elements. Never put a model response through `dangerouslySetInnerHTML`

### React and the build

- Never import `react`, `react-dom`, or `react/jsx-runtime` expecting them to be bundled. The Vite aliases point them at `src/lib/shims/`, which read WordPress's globals. Shipping a second React is the documented cause of the breakage that pushed React 19 out of WordPress 7.1
- Because React is shared with the editor, the sidebar renders the panel as ordinary `PluginSidebar` children. Do not go back to mounting into a `ref`'d div
- The shims list their exports by hand, since an ES module cannot re-export an object's properties dynamically. A dependency reaching for a React export nobody has needed yet fails at build time — add the name to the shim
- After every `npx shadcn add`, review the diff to `src/styles/chat.css`. `components.json` points the CLI at it, and the CLI assumes a stylesheet that owns the page: it may add `@import "tailwindcss"` (which brings Preflight back) or put tokens on `:root` (which leaks them into wp-admin). Move tokens onto `.cdchat` and drop the import. The `hooks` alias (`@/hooks`) has no folder until a component needs one; the CLI creates it
- WordPress is on **React 18.3**, so any shadcn component that pulls in the `@shadcn/react` package (`message-scroller`, `questionnaire`) cannot be used: that package requires React 19. `src/components/chat-scroller.tsx` is the stand-in for `MessageScroller`
- `@agentic-editor/webmcp-tools` and `@agentic-editor/chat-config` are **externals**, resolved by the WordPress import map at runtime. Bundling the tool layer would give the chat a private, empty tool registry
- Tailwind is imported **without Preflight** (`tailwindcss/theme.css` + `tailwindcss/utilities.css`, never `@import "tailwindcss"`). Preflight is a global reset and this stylesheet loads in wp-admin. The parts the components need are re-applied scoped to `.cdchat` in `src/styles/chat.css`
- wp-admin's stylesheets are **not in a cascade layer**, so where they style a bare element (`p`, `code`, `ul`, `li`, `blockquote`, `textarea`) they beat the `.cdchat` reset and every utility, whatever the specificity. Use an important utility (`m-0!`, `rounded-xl!`) for the properties wp-admin sets on that element; an important declaration in a layer beats a normal unlayered one. Check the computed style, not the class list
- Tailwind breakpoints measure the viewport, not the container, so `md:` utilities fire on a wide screen even when the panel is in a 350px sidebar. Pin padding and sizing rather than relying on them
- Design tokens are defined on `.cdchat`, not `:root`, so they do not leak into the rest of the admin
- Anything styling WordPress's own markup around the panel goes in `css/chat-chrome.css`, outside the bundle and outside the `.cdchat` scope

### PHP enqueue

- Always `wp_enqueue_script_module( '@wordpress/abilities' )` so the import map exists
- Register shared modules on `init` (see `agentic_editor_register_chat_modules`) so any screen that mounts the chat can enqueue them
- Import submodules by their import-map ID, never by relative path. A relative import produces a second copy of the module under a different URL, which silently splits module-level state such as the local tool registry
- Script modules cannot be localized — pass data with the `script_module_data_{$module_id}` filter and read the JSON tag on the client
- Version scripts with `filemtime` for cache busting during development
- Any screen showing the chat must also `wp_enqueue_script()` the `react`, `react-dom`, and `react-jsx-runtime` handles. They are classic scripts, so they run before the deferred module that reads them — `agentic_editor_enqueue_chat()` already does this
- The built entry is enqueued as a **script module**, not a classic script, because it imports the two externals by their import-map IDs

## Commands

```bash
npm install          # Required first; the chat panel is compiled
npm run build        # Build the chat panel into build/ (gitignored)
npm run dev          # Same, rebuilding on change
npm run typecheck    # TypeScript 7 over src/, tests/ and configs, plus checkJs over js/
npm run lint         # ESLint (WordPress rules + wp-prettier), then composer lint
npm run format       # wp-prettier --write over JS and TS (CSS is left alone)
composer install     # PHP tooling: PHPCS (WPCS + PHPCompatibilityWP), PHPStan
composer lint        # phpcs, then phpstan at level 8
npm test             # Vitest unit tests (src/**/*.test.ts, js/**/*.test.js), no WordPress needed
composer test        # PHPUnit unit tests (tests/phpunit), no WordPress needed; also npm run test:php
npm start            # Playground at http://127.0.0.1:9400 (plugin auto-mounted)
npm run start:reset  # Reset Playground site data
npm run start:ai     # Same, with the Google connector; needs GOOGLE_API_KEY, and chats are billed
npm run start:ai:reset # start:ai on a fresh site
npm run vendor       # Re-copy the WebMCP polyfill from node_modules
npm run zip          # Build, then write dist/agentic-editor.zip (gitignored)
npm run test:e2e     # Playwright against the npm start site (started if not running)
npm run test:e2e:install # Download the Chromium Playwright uses (once per machine)
```

To run e2e against another WordPress or PHP version, as the CI matrix does, set the version and a spare port; Playwright starts a separate site there and leaves the 9400 one alone:

```bash
WP_VERSION=7.0 PHP_VERSION=8.0 WP_PORT=9401 npm run test:e2e
```

`build/` is gitignored, so a fresh checkout has no panel until `npm run build` runs. PHP shows an admin notice saying exactly that rather than rendering nothing.

## Verification checklist

After JS changes, hard-refresh the block editor (`post-new.php` or edit post):

1. Console: `[agentic-editor] Registered editor abilities with WebMCP: …` **or** a clear “WebMCP unavailable” message
2. `window.agenticEditorAbilities.webmcp.registered` lists every registered ability
3. `await document.modelContext.getTools()` returns every tool, with or without the Chrome flag
4. With WebMCP flag + inspector: tools remain visible (they must not disappear after load)
5. Spot-check one read tool (`editor_get-editor-tree`) and one write tool (`editor_move-block`)

After chat changes, run `npm run build` first, then:

1. The **AI Chat** sidebar opens from the editor's Plugins menu, and the tool count next to Send matches the ability count
2. Without a connector, the sidebar says so instead of failing on send, and `GET /wp-json/agentic-editor/v1/chat/status` reports `hasAiClient: true`
3. With a connector, a prompt that needs the editor ("summarize the blocks in this post") shows tool calls resolving to `Done` before the answer
4. `window.React.version` is WordPress's React, and the console has no "two copies of React" or invalid-hook warnings
5. wp-admin still looks like wp-admin around the chat — the editor's own chrome keeps its fonts and spacing, and `<html>` never picks up Tailwind's `ui-sans-serif` stack, which is the tell that Preflight has leaked
6. The composer stays on screen in the sidebar at a short viewport; the transcript scrolls, not the sidebar

### Linting and types

- **Two TypeScripts, on purpose.** `typescript` is pinned to 6.0 because `typescript-eslint` needs the JavaScript compiler API that TypeScript 7 removed. `typescript-native` is TypeScript 7 (an npm alias) and is what `npm run typecheck` runs. Do not bump `typescript` to 7 or point `typecheck` back at it
- `prettier` is `wp-prettier` under an npm alias. Stock Prettier drops the spaces inside parentheses that WordPress style requires, so every file would reformat
- `js/` is type-checked through `tsconfig.js.json` (`checkJs`). Its bare imports map to the files in `paths`, and `js/types/globals.d.ts` declares the WordPress and WebMCP globals loosely. Keep JSDoc types real: the lint rules reject `Function` and `any`
- PHPStan runs at level 8 with `treatPhpDocTypesAsCertain: false`, because filtered values and client JSON can be anything at runtime. `tests/phpstan/bootstrap.php` defines the plugin constants PHPStan cannot see. `wordpress/php-ai-client` is a dev dependency only so PHPStan knows the AI Client classes; core ships its own copy
- Lint excludes `js/vendor/` and `src/components/ui/` (generated). Disable a rule inline only with a comment saying why
- PHPUnit is pinned to **9.6**, the last version that runs on PHP 8.0. The tests have no WordPress: Brain Monkey stubs the functions in `tests/phpunit/TestCase.php` and `tests/phpunit/stubs.php` stands in for `WP_Error` and the REST classes. Anything that needs real roles or real screens (the permission callback against a subscriber, which screens enqueue what) belongs in e2e

## What not to do

- Do not add a build step to the abilities/WebMCP layer under `js/` — it stays native ESM + import maps. The Vite build exists for the chat panel only
- Do not bundle React, `react-dom`, or `react/jsx-runtime`. See the React section above
- Do not add a shadcn component that depends on the `@shadcn/react` package; it requires React 19 and WordPress is on 18.3
- Do not use `@import "tailwindcss"` — it pulls in Preflight and would reset wp-admin
- Do not hand-edit `src/components/ui/*`; those are shadcn output, re-addable with the CLI
- Do not register WebMCP tools with a shared `AbortController` for page-lifetime tools
- Do not call `registerAbility` / `registerAbilityCategory` without an existence check
- Do not commit `build/`, `dist/`, `*.zip`, or `node_modules/`
- Do not invent server-side PHP abilities for this plugin’s editor features — they must run against the live editor stores in the browser
- Do not use `provideContext` / `clearContext` / `unregisterTool` (removed or deprecated in current WebMCP)
- Do not use the `wordpress/wp-ai-client` JS API for the chat. It exposes arbitrary prompting to the client and is admin-only for that reason; core recommends per-feature REST endpoints instead
- Do not call an AI provider SDK directly — everything goes through `wp_ai_client_prompt()` so the site's connector and credentials stay in charge
- Do not read `window.wp` from `src/components/`; only `src/entries/editor-sidebar.tsx` may assume the editor is present

## Extending

To add an ability:

1. Add a module-level ability definition (name, schemas, meta, callback) to the module it belongs in under `js/abilities/` (`block-editor.js` or `patterns.js`), with `category: ABILITY_CATEGORY.slug`
2. Add it to that module's ability list (`BLOCK_EDITOR_ABILITIES` or `PATTERN_ABILITIES`), which `registerAbilities()` registers idempotently
3. The bridge in `js/index.js` registers all returned names automatically
4. Add the WebMCP tool name to `EXPECTED_TOOLS` in `tests/e2e/bridge.spec.ts`, which checks the exact set
5. Document the ability and WebMCP tool name in `README.md`

To add a new abilities module:

1. Create `js/abilities/<name>.js` exporting `register<Name>Abilities()` (a one-line `registerAbilities( LIST )`), importing helpers from `@agentic-editor/abilities/shared` (the import-map ID, never a relative path)
2. Register it in `agentic_editor_enqueue_editor_abilities()` in `agentic-editor.php` with `wp_register_script_module( '@agentic-editor/abilities/<name>', … )`, and add that ID to the dependencies of `@agentic-editor/abilities`
3. Spread its result into `registerEditorAbilities()` in `js/abilities.js`. `tsconfig.js.json` already maps `@agentic-editor/abilities/*` for `checkJs`

The chat picks up new abilities automatically — they are just more WebMCP tools.

To mount the chat on another screen:

1. Add `src/entries/<name>.tsx`, importing `@/styles/chat.css` and rendering `<ChatPanel getContext={…} suggestions={…} />`
2. Add the entry to `build.rollupOptions.input` in `vite.config.ts`
3. Enqueue it with `agentic_editor_enqueue_chat( '@agentic-editor/chat-<name>', 'chat-<name>.js' )`
4. Give the container a definite height in `css/chat-chrome.css`; the transcript scrolls, not the page
5. Register any page-specific tools with WebMCP; the chat will offer them

## External docs

- https://make.wordpress.org/core/2026/03/24/client-side-abilities-api-in-wordpress-7-0/
- https://make.wordpress.org/core/2026/03/24/introducing-the-ai-client-in-wordpress-7-0/
- https://make.wordpress.org/core/2026/03/18/introducing-the-connectors-api-in-wordpress-7-0/
- https://developer.wordpress.org/block-editor/reference-guides/packages/packages-abilities/
- https://developer.chrome.com/docs/ai/webmcp/imperative-api
- https://docs.mcp-b.ai/packages/webmcp-polyfill/reference
- https://make.wordpress.org/core/2026/07/24/react-19-punted-beyond-wordpress-7-1-experiment-in-gutenberg/ — why React must not be bundled
- https://ui.shadcn.com/docs/components/message — the chat components in use
- https://ai-sdk.dev/docs/ai-sdk-ui/transport — the `ChatTransport` contract
