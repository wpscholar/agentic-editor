<?php
/**
 * Script module registration and enqueueing for the chat panel.
 *
 * The chat is a React app built with Vite (see src/ and vite.config.ts). Two
 * pieces stay outside that bundle and remain hand-written script modules:
 *
 * - `@agentic-editor/webmcp-tools`, so the chat and the ability bridge share
 *   one tool registry rather than each getting a private copy.
 * - `@agentic-editor/chat-config`, so the `script_module_data_` filter below
 *   keeps being the way per-screen configuration reaches the client.
 *
 * The bundle imports both by their import-map IDs, which is why it ships as a
 * script module rather than as a classic script.
 *
 * @package AgenticEditor
 */

defined( 'ABSPATH' ) || exit;

/**
 * Script module ID carrying the chat configuration for the current screen.
 */
const AGENTIC_EDITOR_CHAT_CONFIG_MODULE = '@agentic-editor/chat-config';

/**
 * Directory holding the built chat assets, relative to the plugin root.
 */
const AGENTIC_EDITOR_CHAT_BUILD_DIR = 'build/';

/**
 * Register every chat-related script module and style.
 *
 * Registration is separate from enqueueing so any screen that mounts the chat
 * can pull in the same graph.
 *
 * @return void
 */
function agentic_editor_register_chat_modules() {
	$modules = array(
		'@agentic-editor/webmcp-polyfill' => array( 'js/webmcp-polyfill.js', array() ),
		'@agentic-editor/webmcp-tools'    => array( 'js/webmcp-tools.js', array( '@agentic-editor/webmcp-polyfill' ) ),
		AGENTIC_EDITOR_CHAT_CONFIG_MODULE => array( 'js/chat/config.js', array() ),
	);

	foreach ( $modules as $id => $module ) {
		list( $path, $deps ) = $module;

		wp_register_script_module(
			$id,
			AGENTIC_EDITOR_PLUGIN_URL . $path,
			$deps,
			agentic_editor_asset_version( $path )
		);
	}

	// The panel's own styles, emitted by the build.
	wp_register_style(
		'agentic-editor-chat',
		AGENTIC_EDITOR_PLUGIN_URL . AGENTIC_EDITOR_CHAT_BUILD_DIR . 'chat.css',
		array(),
		agentic_editor_asset_version( AGENTIC_EDITOR_CHAT_BUILD_DIR . 'chat.css' )
	);

	/*
	 * Layout for the wp-admin containers the panel mounts into. This is
	 * deliberately not part of the build: it styles WordPress's own markup,
	 * which sits outside the `.cdchat` scope the bundled stylesheet is
	 * confined to.
	 */
	wp_register_style(
		'agentic-editor-chat-chrome',
		AGENTIC_EDITOR_PLUGIN_URL . 'css/chat-chrome.css',
		array( 'agentic-editor-chat' ),
		agentic_editor_asset_version( 'css/chat-chrome.css' )
	);

	/*
	 * The polyfill ships as a classic script rather than a module: the package's
	 * ESM build imports a bare specifier that import maps would not resolve,
	 * while this build is self-contained and installs itself on load. Classic
	 * scripts also run before deferred modules, so `document.modelContext`
	 * exists by the time any module looks for it.
	 */
	wp_register_script(
		'agentic-editor-webmcp-polyfill',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/vendor/webmcp-polyfill/webmcp-polyfill.js',
		array(),
		agentic_editor_asset_version( 'js/vendor/webmcp-polyfill/webmcp-polyfill.js' ),
		true
	);
}
add_action( 'init', 'agentic_editor_register_chat_modules' );

/**
 * Configuration handed to the chat modules for the current screen.
 *
 * Script modules cannot use wp_localize_script, so this rides along on the
 * script module data filter that core prints as JSON.
 *
 * @param array<string, mixed> $data Existing data.
 * @return array<string, mixed>
 */
function agentic_editor_chat_module_data( $data ) {
	return array_merge(
		is_array( $data ) ? $data : array(),
		array(
			'restUrl'       => rest_url( AGENTIC_EDITOR_CHAT_NAMESPACE . '/chat' ),
			'nonce'         => wp_create_nonce( 'wp_rest' ),
			// Core's endpoint for renewing the nonce in a tab left open past its lifetime.
			'nonceUrl'      => admin_url( 'admin-ajax.php?action=rest-nonce' ),
			'available'     => agentic_editor_chat_is_available(),
			'connectorsUrl' => agentic_editor_chat_connectors_url(),
			'maxToolRounds' => agentic_editor_chat_max_tool_rounds(),
			'siteName'      => wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ),
		)
	);
}
add_filter( 'script_module_data_' . AGENTIC_EDITOR_CHAT_CONFIG_MODULE, 'agentic_editor_chat_module_data' );

/**
 * Files the chat needs from the build, relative to the build directory.
 *
 * @return string[]
 */
function agentic_editor_chat_build_files() {
	return array( 'chat.css', 'chat-editor-sidebar.js' );
}

/**
 * Whether every file the chat loads has been built.
 *
 * A partial build (an interrupted `npm run dev`, say) counts as not built, so
 * the notice explains the missing panel instead of nothing showing at all.
 *
 * @return bool
 */
function agentic_editor_chat_is_built() {
	foreach ( agentic_editor_chat_build_files() as $file ) {
		if ( ! file_exists( AGENTIC_EDITOR_PLUGIN_DIR . AGENTIC_EDITOR_CHAT_BUILD_DIR . $file ) ) {
			return false;
		}
	}
	return true;
}

/**
 * Enqueue the chat panel plus a mount for the current screen.
 *
 * @param string   $module_id  Script module ID to register the mount under.
 * @param string   $build_file Built entry file name, relative to the build directory.
 * @param string[] $extra_deps Additional script module dependencies.
 * @return bool Whether the chat was enqueued; false for users who cannot chat or when there is no build.
 */
function agentic_editor_enqueue_chat( $module_id, $build_file, array $extra_deps = array() ) {
	if ( ! agentic_editor_user_can_chat() || ! agentic_editor_chat_is_built() ) {
		return false;
	}

	$path = AGENTIC_EDITOR_CHAT_BUILD_DIR . $build_file;

	wp_enqueue_style( 'agentic-editor-chat-chrome' );
	wp_enqueue_script( 'agentic-editor-webmcp-polyfill' );

	/*
	 * React comes from WordPress rather than from the bundle. Core asks plugins
	 * not to ship their own copy, since two runtimes in one page is what breaks
	 * on the React 19 upgrade, so the build rewrites every React import to read
	 * these globals instead. They are classic scripts, which run before
	 * deferred modules, so they are defined by the time the bundle executes.
	 */
	wp_enqueue_script( 'react' );
	wp_enqueue_script( 'react-dom' );
	wp_enqueue_script( 'react-jsx-runtime' );

	wp_enqueue_script_module(
		$module_id,
		AGENTIC_EDITOR_PLUGIN_URL . $path,
		array_merge(
			array(
				'@agentic-editor/webmcp-tools',
				AGENTIC_EDITOR_CHAT_CONFIG_MODULE,
			),
			$extra_deps
		),
		agentic_editor_asset_version( $path )
	);

	return true;
}

/**
 * Tell an administrator when the chat is missing because nobody built it.
 *
 * The panel is compiled from src/, so a fresh checkout has no assets to load
 * and would otherwise just show nothing.
 *
 * @return void
 */
function agentic_editor_chat_build_notice() {
	if ( ! current_user_can( 'manage_options' ) || agentic_editor_chat_is_built() ) {
		return;
	}

	wp_admin_notice(
		esc_html__( 'Agentic Editor: the chat panel has not been built yet. Run "npm install && npm run build" in the plugin directory.', 'agentic-editor' ),
		array( 'type' => 'warning' )
	);
}
add_action( 'admin_notices', 'agentic_editor_chat_build_notice' );
