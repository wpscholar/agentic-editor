# Agentic Editor

WordPress plugin that registers **client-side block editor abilities** via [`@wordpress/abilities`](https://developer.wordpress.org/block-editor/reference-guides/packages/packages-abilities/), exposes them to browser AI agents through [WebMCP](https://developer.chrome.com/docs/ai/webmcp), and ships a chat panel that drives those tools using the site's own AI connector.

Requires **WordPress 7.0+** (client-side Abilities API and AI Client) and **PHP 8.0+**.

## What it does

On block editor screens the plugin:

1. Registers a `block-editor` ability category
2. Registers twenty-one editor abilities (inspect / query / mutate the live editor), plus `editor/generate-image` when the site's AI connector can generate images
3. Bridges each ability to `document.modelContext.registerTool()`, installing the [WebMCP polyfill](https://www.npmjs.com/package/@mcp-b/webmcp-polyfill) when the browser has no native support
4. Adds an **AI Chat** sidebar that can call those tools

| Ability | WebMCP tool name | Purpose |
| --- | --- | --- |
| `editor/get-editor-tree` | `editor_get-editor-tree` | Full hierarchical block tree (optional `maxDepth`) |
| `editor/find-editor-blocks` | `editor_find-editor-blocks` | Find blocks by text / name / attribute; returns flat summaries |
| `editor/get-block-location` | `editor_get-block-location` | Parents, root, and index for a block |
| `editor/insert-block` | `editor_insert-block` | Insert a block, with nested `innerBlocks` (optional parent / after) |
| `editor/move-block` | `editor_move-block` | Move a block within or between parents |
| `editor/update-block` | `editor_update-block` | Merge attribute changes into a block |
| `editor/transform-block` | `editor_transform-block` | Convert a block to another block type in place |
| `editor/remove-block` | `editor_remove-block` | Remove a block and everything nested inside it |
| `editor/get-editor-selection` | `editor_get-editor-selection` | Current selection state |
| `editor/select-block` | `editor_select-block` | Select a block, without touching the document |
| `editor/can-insert-block` | `editor_can-insert-block` | Whether a block type can be inserted |
| `editor/get-block-types` | `editor_get-block-types` | List registered block types, filtered by search / category / insertability |
| `editor/get-block-type` | `editor_get-block-type` | One block type in full: attribute schema, nesting rules, styles, variations |
| `editor/undo` | `editor_undo` | Undo the last change to the document |
| `editor/redo` | `editor_redo` | Redo the last undone change |
| `editor/get-patterns` | `editor_get-patterns` | List available patterns, filtered by search / category / block types / destination |
| `editor/get-pattern` | `editor_get-pattern` | One pattern as a block tree, optionally with its markup |
| `editor/get-pattern-categories` | `editor_get-pattern-categories` | Pattern categories, registered and user-created |
| `editor/insert-pattern` | `editor_insert-pattern` | Insert a pattern at a location |
| `editor/create-pattern` | `editor_create-pattern` | Save blocks as a new pattern on this site |
| `editor/search-media` | `editor_search-media` | Find files already in the Media Library by title, alt text, caption or file name |
| `editor/generate-image` | `editor_generate-image` | Generate an image with the site's AI connector and add it to the Media Library (only when the connector supports image generation) |

Ability names keep the `namespace/name` form. WebMCP tool names replace `/` with `_` (some agents reject `/` in tool names).

Behavior worth knowing when calling these:

- Unknown client IDs are an error, never a silent no-op. Passing a stale `afterClientId` to `editor/insert-block` fails instead of inserting at the top of the document.
- `editor/find-editor-blocks` returns each match once as `{ clientId, name, attributes, innerBlockCount }`, so a match nested inside another match is not duplicated. A supplied `clientId` scopes the search and includes that block itself.
- `search` is the way to find a block by the words shown in the editor: it is a case-insensitive substring match over the block's string attributes, and it also matches with markup and common HTML entities resolved, so `Chloe` finds `<strong>Chloe Nolan</strong>`. A `value` passed without an `attribute` is treated as `search` rather than matching every block.
- `attribute` matches on presence; add `value` to compare, which is done as a string (objects and arrays compare as JSON).
- `editor/move-block` takes `afterClientId` / `beforeClientId` (the sibling's parent becomes the destination) or an explicit `rootClientId` + `index`. Indexes are the block's position after the move. Moving a block into itself or a descendant is an error, as is a move the editor refuses because of a lock: the block's own move lock, a parent's template lock, or a remove lock when the move would take it out of its parent (it can still be reordered there).
- `editor/insert-block` takes `innerBlocks` (recursive `{ name, attributes, innerBlocks }`), and container blocks have to be built that way. An empty `core/columns` renders a layout placeholder rather than an inner block list, so the editor registers no block list settings for it and refuses every child until it has inner blocks — a two-column layout must be inserted as one `core/columns` holding two `core/column` blocks. Nesting the block types forbid fails before anything is inserted: a `parent` rule (`core/column` outside `core/columns`), a container's `allowedBlocks`, or an `ancestor` rule, judged against where the blocks will actually sit in the document (`core/comment-author-name` anywhere outside `core/comment-template`).
- `editor/update-block` merges the attributes you pass; anything you omit is left alone. Object attributes such as `style` merge at every depth, so `{ style: { color: { text: '#f00' } } }` keeps the block's existing typography and spacing, and a nested `null` removes that key. Arrays and other values are replaced whole. Attribute keys the block type does not define are rejected with the list of keys it accepts, since unknown keys are stored but never saved. It holds the agent to the same locks a person is held to: `metadata`, `lock` and `templateLock` cannot be set (here or through `editor/insert-block` and `editor/create-pattern`), a block in `disabled` editing mode (such as the inside of a synced pattern) cannot be updated at all, and one in `contentOnly` mode accepts only the attributes its block type marks as content.
- Attribute values are checked against the shape the block type declares, and defaults nested inside `query` sources are filled in. Those defaults are otherwise only applied while parsing saved markup, so a `core/table` cell set programmatically without its `tag` would render an undefined element and break the block.
- `editor/get-block-types` is how to discover blocks the theme or a plugin registered, which no model knows in advance. It omits attribute schemas to stay small; `editor/get-block-type` returns one block in full, including the style variations and the `is-style-*` class name that applies each, and block variations whose `innerBlocks` are in the `{ name, attributes, innerBlocks }` shape `editor/insert-block` takes. Blocks hidden from the inserter are excluded unless `includeHidden` is set, and passing `rootClientId` narrows the list to what that block will actually accept.
- `editor/remove-block` reports `removedInnerBlockCount`: every block removed along with it, at any depth, including what a synced pattern reference was showing.
- `editor/can-insert-block` treats an unknown block name as an error rather than a block that does not fit.
- `editor/transform-block` uses the block type's own registered transforms, so it keeps content that a remove-then-insert would lose. A refused target comes back with the list of types the block can become, and one transform can produce several blocks (a list becomes one paragraph per item).
- `editor/undo` and `editor/redo` drive the editor's history, so a person can also step through the agent's work with the toolbar buttons. Each editing ability lands as its own undo step; there is no batching yet, so reverting a five-call edit takes five undos.
- Ability failures come back as MCP tool errors with a readable message rather than rejecting the tool call.

### Patterns

- `editor/get-patterns` is the pattern counterpart of `editor/get-block-types`: it answers "what layouts does this site already have" before an agent assembles one block at a time. It lists registered patterns (core, theme, plugin, pattern directory) alongside the patterns saved on this site, and omits markup so the list stays small. Each entry carries `rootBlockNames` and `blockCount`, so a pattern can be judged without fetching it.
- Pattern names keep the form the editor uses. Registered patterns are named by their author (`twentytwentyfive/hero`); a pattern saved on this site is `core/block/<id>`, after the `core/block` block that references it.
- Passing `rootClientId` to `editor/get-patterns` narrows the list to patterns whose top-level blocks the destination will actually accept, which is how to avoid offering a template-part pattern inside a post.
- `editor/get-pattern` returns blocks as `{ name, attributes, innerBlocks }` — the shape `editor/insert-block` and `editor/create-pattern` accept, and deliberately without client IDs, since none of those blocks are in the document.
- `editor/insert-pattern` copies an unsynced or registered pattern in as ordinary blocks, and inserts a synced pattern as a single `core/block` reference, which is what the editor does. Pass `asReference: false` to copy a synced pattern's blocks in as an independent, editable set instead. `asReference: true` is refused for unsynced and registered patterns, since a reference would make an unsynced pattern behave as a synced one. Every top-level block is checked against the destination first, so a pattern that does not fit fails before anything is inserted.
- `editor/create-pattern` saves either blocks already in the document (`clientIds`) or a structure supplied directly (`blocks`). Sync status follows core: `unsynced` writes the `wp_pattern_sync_status` meta and inserts independent copies, `synced` omits it and keeps every instance in step. A category with no term behind it yet gets one created, the same as the editor does, and the response reports which were created. A category named twice, or by both its slug and its label, is filed once, and categories created for a pattern that then fails to save are deleted again. The pattern and any new categories are published immediately, independently of the post being edited, and editor undo does not remove them, which is why the ability is annotated as destructive.
- `replaceSource: true` swaps the source blocks for a reference to the new synced pattern, which is the editor's own "Create pattern" behavior. It needs `syncStatus: 'synced'` and blocks that sit next to each other under one parent.
- Creating anything requires an account that may create `wp_block` posts; that is checked up front so the failure reads as a permission problem rather than a REST error.
- Pattern data is fetched over REST, so the first pattern call on a page load waits on that request. Later calls are served from the store.

### Media

- `editor/search-media` finds files already in the Media Library, newest first; it looks for images unless `mediaType` says otherwise. Core's attachment search only looks at the title, caption and description, so the ability sends an `agentic_editor_search` flag, and `includes/media-search.php` widens that one query to alt text and file names too. A photo titled `IMG_1234` with the alt text "Lighthouse at dusk" is found by "lighthouse". Every search word must match somewhere. Other media queries on the site are unaffected.
- Each image result carries the same `blockAttributes` as a generated image, so placing a library image and placing a generated one are the same next step. Titles, alt text and captions are written by people, so results are marked as untrusted content.
- Searching needs no approval and is always available. Generating is only for a new image: the tool descriptions and the system instruction steer "an image from the media library" to search, and tell the model to report an empty search rather than generate unasked.
- `editor/generate-image` is registered only when a connector on the site can generate images and the user may upload files. PHP asks the AI Client (`is_supported_for_image_generation()`, which makes no request to a provider) and passes the answer to the page. On a site without an image model the tool is simply not there, so the model cannot reach for it and fail.
- The AI Client runs only in PHP, so the ability calls `POST /wp-json/agentic-editor/v1/image`. The endpoint generates one image, sideloads it into the Media Library (attached to the post being edited, when the user may edit it), sets its alt text, and records the prompt in the attachment's description and in `_agentic_editor_image_prompt` meta. It returns a local attachment, never a provider's URL.
- The ability does not place the image. It returns `blockAttributes` for a `core/image` block (`id`, `url`, `alt`, `sizeSlug`, `linkDestination`), which the model passes to `editor/insert-block`, or the `id` and `url` it passes to `editor/update-block` for an existing image, cover or media & text block. Placement is therefore an ordinary editor change that undo reverts; the attachment is not.
- `orientation` is `landscape` (the default), `portrait` or `square`. Which model draws the image is up to the connectors; `agentic_editor_image_model_preference` can name preferred models.
- Generation is billed and the attachment outlives undo, so the chat asks for approval before each call. It also waits up to three minutes for the result rather than the usual thirty seconds.
- The system instruction tells the model never to use an image URL it found or made up, so on a site without image generation it says so instead of hot-linking something.

### Synced patterns in the tree

A synced pattern (`core/block`) owns its content as a separate entity, so `editor/get-editor-tree`, `editor/find-editor-blocks`, and `editor/get-editor-selection` reach into it through the editor's controlled-inner-block plumbing rather than the block itself, and mark the block with `controlledInnerBlocks: true`. Blocks below that marker are shared: editing one changes every post using the pattern, and the change is saved with that pattern rather than with the post, so `editor/undo` does not necessarily cover it. A pattern nested inside itself stops the walk and is reported as truncated.

## Chat

The chat panel talks to whichever AI provider the site has configured under **Settings → Connectors** (Anthropic, Google, OpenAI, or anything else that registers with the AI Client). It never holds credentials of its own.

### How a turn works

WordPress 7.0 keeps the AI Client server-side, so the chat is split across the two:

1. The browser lists the WebMCP tools the current page registers and sends them, with the conversation, to `POST /wp-json/agentic-editor/v1/chat`.
2. PHP declares those tools as function declarations on `wp_ai_client_prompt()` and runs **one** model turn.
3. If the model asked for tools, the browser runs them against the live page and posts the results back. This repeats until the model answers with text (25 rounds by default).

Conversation state lives entirely in the browser, so the endpoint is stateless and the same chat works on any screen. Assistant turns are replayed verbatim from the parts the previous response returned, which keeps provider-specific details such as function call IDs intact across rounds.

Gemini is the exception: it requires the thought signature it issued with a function call to come back with that call. The chat replays signatures whenever the provider plugin returns them, which the Google connector does from version 1.2.0, but an older connector drops them. When a turn fails for that reason it is retried once with the tool calls and results replayed as a text transcript, and the browser reports the working mode back so the rest of the conversation skips the failed attempt.

### Where the tools come from

The chat offers whatever the page registered with WebMCP — nothing is hard-coded. In the block editor that is the abilities above, so the assistant can read the block tree and edit the post. Tools registered by other plugins on the same page are picked up automatically.

Tools this plugin registered are called through their own executor. Anything else goes through `document.modelContext.executeTool()`, which the polyfill always provides and native Chrome provides as an optional extension.

Tool names are rewritten server-side to the character set every provider accepts (`editor_get-editor-tree` survives as-is; dots become underscores) and mapped back before the browser sees them.

### The interface

The panel is a React app built with [shadcn/ui](https://ui.shadcn.com) components and the [AI SDK](https://ai-sdk.dev)'s `useChat`. Because WordPress 7.0 keeps the AI Client server-side, there is no AI SDK provider to point `useChat` at; instead `src/chat/transport.ts` implements a custom `ChatTransport` that calls the REST route once per round, runs the tools the model asked for against the page, and emits the whole exchange as one streaming assistant message.

React itself is **not** bundled. WordPress already puts React 18.3 on the page, and core [asks plugins not to ship a second copy](https://make.wordpress.org/core/2026/07/24/react-19-punted-beyond-wordpress-7-1-experiment-in-gutenberg/), so the build rewrites every React import to read WordPress's globals. Sharing the runtime is also what lets the editor sidebar render the panel as ordinary `PluginSidebar` children.

Tailwind is loaded without Preflight, since that reset would strip WordPress's own admin styling off any screen the chat appears on. The styles the components need are re-applied scoped to `.cdchat`.

### Using the chat elsewhere

Add an entry under `src/entries/` that renders `<ChatPanel />`, register it in `vite.config.ts`, and enqueue it:

```tsx
import '@/styles/chat.css';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from '@/components/chat-panel';

createRoot( document.getElementById( 'my-chat' )! ).render(
	<ChatPanel
		getContext={ () => ( { screen: 'my screen', notes: 'What the page is showing.' } ) }
		suggestions={ [ 'What can you do here?' ] }
	/>
);
```

Tool calls run without asking, since editor undo reverts them, except for three kinds that wait for **Approve** or **Deny** in the chat: calls to tools another script put on the page, calls that cannot be undone (`editor/create-pattern`, which publishes straight away, and `editor/generate-image`, which is billed and adds to the Media Library), and calls whose arguments carry HTML that could run script, such as a `core/html` block, a `<script>` tag, an `on…=` handler or a `javascript:` URL.

`getContext` is read on every send. Its `screen` and `notes` are attached to the user's latest message as page context, not to the system instruction, since they can quote content other people wrote.

In the editor, the paperclip next to **Send** attaches a block. It attaches the selected block, or, when nothing is selected (or the selected block is already attached), the next block you click. Nothing is attached until you ask, since the block you clicked before opening the chat is not necessarily the one you mean. While a block shows as **Attached**, every message carries it (`context.attachedBlock`: client ID, name, attributes and inner blocks, read fresh each round), so the assistant starts from that block rather than reading the whole post. It stays until you remove it with **×** or delete the block. With nothing attached, the assistant hears nothing about the selection and reads the post however it normally would. Another mount can offer the same through `<ChatPanel />`'s `attachment`, `onClearAttachment` and `attach` props.

### Hooks

| Hook | Purpose |
| --- | --- |
| `agentic_editor_chat_capability` | Capability required to use the chat. Defaults to `edit_posts` |
| `agentic_editor_chat_model_preference` | Preferred models, best first |
| `agentic_editor_image_model_preference` | Preferred image models for `editor/generate-image`, best first. Empty by default: any image model the connectors offer |
| `agentic_editor_chat_system_instruction` | The full system instruction |
| `agentic_editor_chat_max_tool_rounds` | Tool rounds per message, enforced by the browser and the endpoint. Defaults to `25` |
| `agentic_editor_chat_limits` | Per-request limits: `max_body_bytes` (1 MB), `max_messages` (500), `max_tools` (128), `max_context_chars` (2000), `max_attachment_chars` for the attached block's JSON (8000; a larger block is named for the assistant to read with a tool) and `requests_per_minute` per user (60, shared with image generation). `0` turns a limit off |

The endpoint runs prompts against the site's connector, and the conversation, tool declarations and page context all come from the browser. Anyone with the chat capability can therefore spend the site's AI credit on prompts of their choosing, within the limits above. It is gated on a capability rather than on being logged in, and the default, `edit_posts`, includes Contributors. Narrow `agentic_editor_chat_capability` if that is too broad for your site.

## Project layout

```text
agentic-editor.php        # Plugin bootstrap; enqueues editor script modules
includes/
  chat-rest.php            # /agentic-editor/v1/chat — one model turn per request
  chat-assets.php          # Script module registration + per-screen config
  image-rest.php           # /agentic-editor/v1/image — generate an image into the Media Library
  media-search.php         # Widens editor/search-media's query to alt text and file names
js/
  index.js                 # Entry: register abilities + bridge to WebMCP
  abilities.js             # Aggregates the ability modules below
  abilities/
    block-editor.js        # Block tree, edits, transforms, selection, undo/redo
    patterns.js            # Pattern and synced-pattern abilities
    media.js               # Media Library search and image generation
    shared.js              # Category, registration, store access, lock checks
  webmcp-bridge.js         # Abilities → document.modelContext.registerTool
  webmcp-polyfill.js       # getModelContext(): finds the model context; installs nothing
  webmcp-tools.js          # Consumer side: list and call the page's tools
  chat/config.js           # Server config, read from the script module data tag
  vendor/webmcp-polyfill/  # Vendored standalone build of @mcp-b/webmcp-polyfill
src/                       # The chat panel (built with Vite into build/)
  chat/transport.ts        # AI SDK ChatTransport: one REST turn per round + tool loop
  chat/approval.ts         # Which tool calls wait for Approve/Deny
  components/
    chat-panel.tsx         # The panel: useChat, transcript, composer
    chat-scroller.tsx      # Transcript scrolling that follows without hijacking
    tool-call.tsx          # One tool call, inline in the assistant turn
    reasoning.tsx          # The model's thinking, collapsed above the answer
    markdown.tsx           # Minimal Markdown → React elements
    ui/                    # shadcn components
  entries/                 # One per mount: the editor sidebar
  lib/shims/               # react / react-dom / jsx-runtime → WordPress globals
  lib/wp.ts                # Typed window.wp access for the editor entry
  styles/chat.css          # Tailwind (no Preflight) + tokens scoped to .cdchat
css/chat-chrome.css        # Layout for the wp-admin containers around the panel
vite.config.ts
bin/build-zip.sh           # Builds a distributable plugin zip
bin/vendor-webmcp-polyfill.sh
bin/blueprints/            # Playground blueprints (the Google connector for start:ai)
bin/start-ai.mjs           # npm run start:ai: Playground with the Google connector and key
tests/
  e2e/                     # Playwright against Playground
  phpunit/                 # PHPUnit unit tests for the chat and image endpoints and media search
```

Two layers with different build stories. Everything under `js/` is hand-written native ESM resolved through WordPress import maps (`@wordpress/abilities`, `@agentic-editor/*`) with no build step. The chat panel under `src/` is compiled, but keeps `@agentic-editor/webmcp-tools` and `@agentic-editor/chat-config` as import-map externals rather than bundling them — the tool layer has to be the *same* module instance the ability bridge registered into, or the chat would see an empty tool registry.

The polyfill is the one exception: its ESM build imports `@cfworker/json-schema` as a bare specifier, which the import map has no entry for, so the self-contained IIFE build is enqueued as a classic script instead. It installs itself on load and steps aside when the browser has native WebMCP. Classic scripts run before deferred modules, so `document.modelContext` exists by the time any module looks for it. Run `npm run vendor` to refresh the copy after bumping the dependency.

## Local development (WP Playground)

Requires **Node 24.18+** and **npm 11.16+**, the minimum the Playground CLI supports. `.nvmrc` pins the version CI uses, and `npm install` / `npm ci` refuse to run on anything older.

```bash
npm install
npm run build
npm start
```

Playground auto-mounts this directory as `wp-content/plugins/agentic-editor` and starts WordPress at [http://127.0.0.1:9400](http://127.0.0.1:9400) (admin login is enabled by default).

The chat panel is compiled, so `npm run build` is required before it will appear — `build/` is gitignored. If you forget, the admin says so instead of showing nothing. Use `npm run dev` while working on it.

| Script | Description |
| --- | --- |
| `npm run build` | Build the chat panel into `build/` |
| `npm run dev` | Rebuild the chat panel on change |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the Vitest unit tests |
| `composer test` | Run the PHPUnit unit tests (also `npm run test:php`) |
| `npm run lint` | ESLint with WordPress rules and formatting, then `composer lint` (PHPCS + PHPStan) |
| `npm run format` | Reformat JS and TS with WordPress's Prettier |
| `npm run test:e2e` | Run the Playwright suite against the `npm start` site. Set `WP_VERSION`, `PHP_VERSION` and `WP_PORT` to test another version on a separate site |
| `npm start` | Start Playground with this plugin mounted |
| `npm run start:reset` | Wipe stored site data and restart |
| `npm run vendor` | Re-copy the WebMCP polyfill from `node_modules` |
| `npm run zip` | Build, then create `dist/agentic-editor.zip` for distribution |
| `npm run start:ai` | Start Playground with the Google connector installed and authenticated from `$GOOGLE_API_KEY` |
| `npm run start:ai:reset` | Same, wiping stored site data first |

To exercise the chat, install one of the official provider plugins ([Anthropic](https://wordpress.org/plugins/ai-provider-for-anthropic/), [Google](https://wordpress.org/plugins/ai-provider-for-google/), [OpenAI](https://wordpress.org/plugins/ai-provider-for-openai/)) and add an API key under **Settings → Connectors**. Without one, the panel loads and says so rather than failing on send.

For local dev or CI without clicking through that screen, every connector also reads its key from an environment variable or PHP constant before the database, so no UI is required. For Google that's `GOOGLE_API_KEY` ([get a key](https://aistudio.google.com/api-keys)) — set it in your shell and run:

```bash
GOOGLE_API_KEY=your-key-here npm run start:ai
```

`npm run start:ai` installs and activates the Google connector plugin via `bin/blueprints/install-google-connector.json`, then passes `GOOGLE_API_KEY` through as a PHP constant, defined by a private temporary blueprint rather than on the command line where `ps` would show it. That constant is what `wp_get_connector( 'google' )` checks ahead of the database. The key never touches the options table, a form field, or this repo. Anthropic and OpenAI follow the same convention: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` respectively, once their connector plugins are installed.

## Testing WebMCP

The polyfill means tools register in any browser on a secure context (HTTPS or localhost). Native Chrome support (`chrome://flags/#enable-webmcp-testing`) takes precedence when present, and the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) extension is useful for confirming what an external agent would see.

Open **Posts → Add New** (or edit any post) and check DevTools:

```js
window.agenticEditorAbilities
// { abilityNames, webmcp: { supported, registered, skipped, errors }, isWebMCPSupported }

await document.modelContext.getTools();
// every registered tool, whichever implementation is in play
```

The chat sidebar shows the same count next to the Send button; hover it for the list.

## Distributable zip

```bash
npm run zip
```

Builds the panel, then writes `dist/agentic-editor.zip` containing only plugin runtime files (`agentic-editor.php`, `includes/`, `js/`, `css/`, `build/`), with source maps stripped. `build/`, `dist/`, and `*.zip` are gitignored.

## References

- [Introducing the WordPress Abilities API](https://developer.wordpress.org/news/2025/11/introducing-the-wordpress-abilities-api/)
- [Client-Side Abilities API in WordPress 7.0](https://make.wordpress.org/core/2026/03/24/client-side-abilities-api-in-wordpress-7-0/)
- [Introducing the AI Client in WordPress 7.0](https://make.wordpress.org/core/2026/03/24/introducing-the-ai-client-in-wordpress-7-0/)
- [Introducing the Connectors API in WordPress 7.0](https://make.wordpress.org/core/2026/03/18/introducing-the-connectors-api-in-wordpress-7-0/)
- [WebMCP (Chrome)](https://developer.chrome.com/docs/ai/webmcp)
- [WebMCP Imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [`@wordpress/abilities` package reference](https://developer.wordpress.org/block-editor/reference-guides/packages/packages-abilities/)
- [`@mcp-b/webmcp-polyfill`](https://www.npmjs.com/package/@mcp-b/webmcp-polyfill) ([reference](https://docs.mcp-b.ai/packages/webmcp-polyfill/reference))
- [shadcn/ui](https://ui.shadcn.com) — the chat components ([Message](https://ui.shadcn.com/docs/components/message))
- [AI SDK: Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport) — the `ChatTransport` contract
- [React 19 punted beyond WordPress 7.1](https://make.wordpress.org/core/2026/07/24/react-19-punted-beyond-wordpress-7-1-experiment-in-gutenberg/) — why React is not bundled
