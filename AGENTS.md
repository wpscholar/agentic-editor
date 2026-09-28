# AGENTS.md

Guidance for AI coding agents working in this repository. `README.md` explains how the plugin works; this file holds the rules and traps.

## Project purpose

This repo **is** a WordPress plugin (not an app with a nested plugin folder). The project root mounts into Playground as `wp-content/plugins/agentic-editor`.

Two goals:

1. Register **client-side** block editor abilities with `@wordpress/abilities`, then expose them to browser agents via **WebMCP** (`document.modelContext.registerTool`).
2. Ship a **chat panel** that consumes those WebMCP tools and runs prompts through the WordPress 7.0 **AI Client** (`wp_ai_client_prompt()`), so the site's own connector answers.

## Stack constraints

- **WordPress 7.0+** required (`wp_enqueue_script_module`, `@wordpress/abilities`, `wp_ai_client_prompt`), and **PHP 8.0+**. Local development runs the latest WordPress; CI runs e2e on WordPress {7.0, latest} × PHP 8.0–8.5
- **Two layers, two build stories.** The abilities and WebMCP layer under `js/` is hand-written native ESM with no build step; WordPress import maps resolve its bare specifiers. Do not add a build step there. The chat panel under `src/` is a React app built with Vite into `build/`
- **React comes from WordPress, never from the bundle.** WordPress 7.0 ships React 18.3 as the `react`, `react-dom`, and `react-jsx-runtime` classic scripts. The build aliases every React specifier to a shim that re-exports those globals
- **PHP** bootstraps, enqueues, and owns the AI Client; all ability and UI logic is client-side JS. Do not invent server-side PHP abilities for editor features — they must run against the live editor stores in the browser
- **Node 24.18+ and npm 11.16+**, the Playground CLI's minimum. `devEngines` in `package.json` makes `npm install` and `npm ci` fail on anything older, and `.nvmrc` pins what CI runs

## Files worth knowing

`README.md` has the full layout. These carry a rule or a surprise:

| Path | Note |
| --- | --- |
| `js/chat/config.js` | The only hand-written chat module; the rest of the chat is under `src/` |
| `js/types/globals.d.ts` | Loose types for the WordPress and WebMCP globals, for `checkJs` |
| `js/*.test.js` | Vitest tests sit beside the modules so `checkJs` covers them; `bin/build-zip.sh` strips them |
| `src/chat/transport.ts` | The AI SDK `ChatTransport`, which owns the tool loop. `vitest.config.ts` stubs the import-map externals for its tests |
| `src/components/ui/*` | shadcn output. Regenerate with the CLI; never hand-edit |
| `src/lib/wp.ts` | Typed `window.wp`, for the editor entry only |
| `bin/start-ai.mjs` | Passes `GOOGLE_API_KEY` through a private temporary blueprint, never on the command line |
| `tests/phpunit/` | No WordPress: Brain Monkey for WordPress functions, the real AI Client DTOs |

## Conventions

### Abilities

- Ability names: `editor/<slug>` (e.g. `editor/get-editor-tree`); category slug `block-editor`
- Registration must be **idempotent** (`getAbility` / `getAbilityCategory` before register). Duplicate registration throws and can abort bootstrap
- Define `input_schema` / `output_schema` (JSON Schema) and `meta.annotations` (`readonly`, `destructive`, `idempotent`)
- Plugin-specific hints live under `meta.agenticEditor`, never in `meta.annotations`:
  - `untrustedContent: true` for anything returning content people wrote (blocks, patterns, terms). The bridge maps it to WebMCP's `untrustedContentHint`
  - `approval: '<why>'` for anything editor undo cannot take back. The chat asks the user before each call and shows this text
  - `timeoutMs: <ms>` for anything slower than the chat's 30-second tool limit (image generation). The bridge hands it to local consumers only, and the transport caps it at `MAX_TOOL_TIMEOUT_MS`
- An ability that depends on what the site's connectors can do (`editor/generate-image`) is registered only when PHP reports support through its module's `script_module_data_*` filter. A tool the model can see but never use invites it to fail, or to improvise around it
- Media must come from the Media Library: search it with `editor/search-media` for an existing file, and generate only when the user asks for something new. Never let an ability, or the system instruction, send the model to a URL it found or made up; generated files are sideloaded and referenced by attachment `id` and local `url`
- Every `type: 'array'` in an **input** schema needs `items`, at every depth. Gemini rejects a function declaration without it and fails the whole chat request, not just that one tool. Output schemas are never sent to a provider, so they are free to be loose
- Callbacks may assume they run in the block editor; guard with the `core/block-editor` store and throw clear errors otherwise
- Use `window.wp.data` and `window.wp.blocks` (classic globals). Only `@wordpress/abilities` is imported as a script module
- Anything backed by REST (patterns, `wp_block` posts, taxonomy terms) must be read with `wp.data.resolveSelect`, not `select` — a plain select returns nothing until the resolver finishes
- Walking the block tree must go through `getInnerBlocks()`: `getBlock()` reports no children for inner block controllers (synced patterns, template parts), so a plain `innerBlocks` walk goes blind inside them

### WebMCP bridge

- Prefer `document.modelContext`; fall back to `navigator.modelContext`
- Tool name = ability name with `/` → `_` (e.g. `editor_insert-block`). The spec allows ASCII alphanumerics, `_`, `-`, `.` (max 128), so no `/`
- **Do not pass an `AbortSignal`** for these page-lifetime editor tools. Aborting the signal unregisters tools and caused “tools appear then vanish” in the inspector
- WebMCP `annotations` only support `readOnlyHint` / `untrustedContentHint` — do not pass WordPress-only keys like `destructiveHint`
- Treat “already registered” / `InvalidStateError` as success on re-bootstrap
- Do not use `provideContext` / `clearContext` / `unregisterTool` (removed or deprecated in current WebMCP)

### WebMCP polyfill

- The polyfill is vendored from `@mcp-b/webmcp-polyfill` and enqueued as a **classic script**, not a module. Its ESM build imports `@cfworker/json-schema` as a bare specifier that nothing here would resolve; the IIFE build inlines it and self-initializes on load
- Do not edit `js/vendor/` by hand — run `npm run vendor`
- Classic scripts execute before deferred modules, so `document.modelContext` is present by the time modules run. Never add `defer`/`async` to the polyfill handle
- Anything that registers or consumes WebMCP tools must enqueue `agentic-editor-webmcp-polyfill`

### Chat

The design (one model turn per request, the browser owning the loop, native and text history modes) is in the README under "How a turn works". The rules:

- Everything goes through `wp_ai_client_prompt()`, from a purpose-built REST endpoint per feature. Never call a provider SDK directly, and never use the `wordpress/wp-ai-client` JS API, which exposes arbitrary prompting to the client
- Every function call in `metadata.wire` must be followed by a tool turn answering it, or providers reject the replay. A round cut short (Stop, the round limit) answers its unrun calls with a "Not run" error
- Emit `wire` as a fresh snapshot each time; the AI SDK stores the array it is given, so mutating one after emitting it changes the stored message
- Replay assistant turns from the raw `parts` on `metadata.wire`, never from the rendered message, which has lost function call IDs and thought signatures. Thoughts stay in `wire` for native replay but never enter a `historyMode: 'text'` transcript
- The chat never requests thinking: the option is provider-specific and would reach whichever provider the model preference picks
- Image generation stays a separate endpoint (`includes/image-rest.php`). The chat's builder carries a text model preference, a system instruction and function declarations, and each is a requirement an image model would have to meet
- Tools come from the page: `listTools()` reads whatever WebMCP has. Never hard-code a tool list into the chat
- `src/chat/approval.ts` decides which calls wait for Approve/Deny: tools other scripts registered, abilities that declare `meta.agenticEditor.approval`, and arguments carrying script-capable HTML. Ordinary editor edits run without asking, because undo reverts them
- Page context (`getContext`) is attached to the latest user message as `<page_context>`, never to the system instruction, since it can quote content other people wrote
- Attaching a block is explicit (the paperclip); selection changes alone never attach anything, and `getEditorContext()` deliberately says nothing about the selection. The server sends the block as `JSON_HEX_TAG` JSON inside `<attached_block>`, so its markup cannot close `<page_context>`
- Rewrite tool names for providers (`[^a-zA-Z0-9_-]` → `_`, 64 chars) and map them back before the browser sees them. OpenAI rejects the dots WebMCP allows
- Client schemas are third-party input; `agentic_editor_chat_prepare_schema()` makes them safe to send (`{}` re-encoding as `[]`, arrays without `items`, union types)
- The panel mounts anywhere, so keep `src/components/` free of editor packages — only `src/entries/editor-sidebar.tsx` may read `window.wp`
- Model output is rendered through `src/components/markdown.tsx`, which returns React elements. Never put a model response through `dangerouslySetInnerHTML`

### React and the build

- Never import `react`, `react-dom`, or `react/jsx-runtime` expecting them to be bundled. The Vite aliases point them at `src/lib/shims/`, which read WordPress's globals. Shipping a second React is the documented cause of the breakage that pushed React 19 out of WordPress 7.1
- Because React is shared with the editor, the sidebar renders the panel as ordinary `PluginSidebar` children. Do not go back to mounting into a `ref`'d div
- The shims list their exports by hand, since an ES module cannot re-export an object's properties dynamically. A dependency reaching for a React export nobody has needed yet fails at build time — add the name to the shim
- After every `npx shadcn add`, review the diff to `src/styles/chat.css`. The CLI assumes a stylesheet that owns the page: it may add `@import "tailwindcss"` (which brings Preflight back) or put tokens on `:root` (which leaks them into wp-admin). Move tokens onto `.cdchat` and drop the import
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
- Any screen showing the chat must also `wp_enqueue_script()` the `react`, `react-dom`, and `react-jsx-runtime` handles, and enqueue the built entry as a **script module**, since it imports the two externals by their import-map IDs. `agentic_editor_enqueue_chat()` does both

## Commands

The README lists every script. Beyond those:

- `build/` is gitignored, so a fresh checkout has no panel until `npm run build` runs. Never commit `build/`, `dist/`, `*.zip` or `node_modules/`
- `composer install` is needed for `npm run lint` and `composer test`
- `npm run start:ai` makes real, billed calls to Google. For chat tests, fake the endpoint the way `tests/e2e/chat/loop.spec.ts` does
- To run e2e against another WordPress or PHP version, as the CI matrix does, set the version and a spare port; Playwright starts a separate site there and leaves the 9400 one alone:

```bash
WP_VERSION=7.0 PHP_VERSION=8.0 WP_PORT=9401 npm run test:e2e
```

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

### Dependencies, linting and types

- **The lockfile needs npm 11.16+.** An older npm drops the `@emnapi/*` peers of Tailwind's WASM fallback when it rewrites `package-lock.json`, and CI's `npm ci` then rejects the lockfile as out of sync. `devEngines` enforces this; don't loosen it
- **`overrides` in `package.json`, each with a way out:**
  - `lightningcss` keeps one copy: Tailwind pins 1.32.0 and Vite wants ^1.33.0, and npm versions disagree on where a second copy's platform binaries belong in the lockfile
  - `express` ^4.22.3 pulls in a patched `qs` (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g). Drop it once `@wp-playground/cli` depends on 4.22.3 or later
  - `eslint-plugin-import`, `-react` and `-jsx-a11y` are pointed at the project's ESLint 10; they still declare ESLint 9 as their peer. Drop each once it declares 10
- **`allowScripts`** approves install scripts by exact version (`npm approve-scripts`). A bump of one of those packages warns again until the new version is reviewed and approved
- **Two TypeScripts, on purpose.** `typescript` is pinned to 6.0 because `typescript-eslint` needs the JavaScript compiler API that TypeScript 7 removed. `typescript-native` is TypeScript 7 (an npm alias) and is what `npm run typecheck` runs. Do not bump `typescript` to 7 or point `typecheck` back at it
- `prettier` is `wp-prettier` under an npm alias. Stock Prettier drops the spaces inside parentheses that WordPress style requires, so every file would reformat
- `js/` is type-checked through `tsconfig.js.json` (`checkJs`). Its bare imports map to the files in `paths`. Keep JSDoc types real: the lint rules reject `Function` and `any`
- PHPStan runs at level 8 with `treatPhpDocTypesAsCertain: false`, because filtered values and client JSON can be anything at runtime. `tests/phpstan/bootstrap.php` defines the plugin constants PHPStan cannot see. `wordpress/php-ai-client` is a dev dependency only so PHPStan knows the AI Client classes; core ships its own copy
- Lint excludes `js/vendor/` and `src/components/ui/` (generated). Disable a rule inline only with a comment saying why
- PHPUnit is pinned to **9.6**, the last version that runs on PHP 8.0. `tests/phpunit/TestCase.php` sets up Brain Monkey and `tests/phpunit/stubs.php` stands in for `WP_Error` and the REST classes. Anything that needs real roles or real screens (the permission callback against a subscriber, which screens enqueue what) belongs in e2e

## Extending

To add an ability:

1. Add a module-level ability definition (name, schemas, meta, callback) to the module it belongs in under `js/abilities/`, with `category: ABILITY_CATEGORY.slug`
2. Add it to the list that module passes to `registerAbilities()` (`BLOCK_EDITOR_ABILITIES`, `PATTERN_ABILITIES`, or the one in `registerMediaAbilities()`), which registers idempotently. The bridge picks it up automatically
3. Add the WebMCP tool name to `EXPECTED_TOOLS` in `tests/e2e/bridge.spec.ts`, which checks the exact set
4. Document the ability and WebMCP tool name in `README.md`

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

External documentation is linked from the README's References.
