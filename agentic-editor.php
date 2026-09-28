<?php
/**
 * Plugin Name:       Agentic Editor
 * Description:       Registers client-side block editor abilities, bridges them to WebMCP, and adds an AI chat panel powered by the WordPress AI Client.
 * Version:           0.1.0
 * Requires at least: 7.0
 * Requires PHP:      8.0
 * Author:            Micah Wood
 * License:           GPL-2.0-or-later
 * Text Domain:       agentic-editor
 *
 * @package AgenticEditor
 */

defined( 'ABSPATH' ) || exit;

defined( 'AGENTIC_EDITOR_VERSION' ) || define( 'AGENTIC_EDITOR_VERSION', '0.1.0' );
defined( 'AGENTIC_EDITOR_PLUGIN_FILE' ) || define( 'AGENTIC_EDITOR_PLUGIN_FILE', __FILE__ );
defined( 'AGENTIC_EDITOR_PLUGIN_DIR' ) || define( 'AGENTIC_EDITOR_PLUGIN_DIR', plugin_dir_path( AGENTIC_EDITOR_PLUGIN_FILE ) );
defined( 'AGENTIC_EDITOR_PLUGIN_URL' ) || define( 'AGENTIC_EDITOR_PLUGIN_URL', plugin_dir_url( AGENTIC_EDITOR_PLUGIN_FILE ) );

/**
 * Cache-busting version for a plugin file.
 *
 * @param string $relative_path Path relative to the plugin root.
 * @return string
 */
function agentic_editor_asset_version( $relative_path ) {
	$path = AGENTIC_EDITOR_PLUGIN_DIR . $relative_path;

	return file_exists( $path )
		? (string) filemtime( $path )
		: AGENTIC_EDITOR_VERSION;
}

require_once AGENTIC_EDITOR_PLUGIN_DIR . 'includes/chat-rest.php';
require_once AGENTIC_EDITOR_PLUGIN_DIR . 'includes/image-rest.php';
require_once AGENTIC_EDITOR_PLUGIN_DIR . 'includes/media-search.php';
require_once AGENTIC_EDITOR_PLUGIN_DIR . 'includes/chat-assets.php';

/**
 * Whether the current screen is a post or site editor.
 *
 * `enqueue_block_editor_assets` also fires for the widgets screen and the
 * Customizer, where the editor store these abilities drive is not the one on
 * screen and core warns when `wp-editor` is loaded.
 *
 * @return bool
 */
function agentic_editor_is_supported_editor() {
	$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;

	return $screen instanceof WP_Screen
		&& $screen->is_block_editor()
		&& in_array( $screen->base, array( 'post', 'site-editor' ), true );
}

/**
 * Enqueue editor abilities script module on block editor screens.
 *
 * Submodules are registered as dependencies rather than imported by relative
 * path so that WordPress resolves them through the import map, where each one
 * carries its own version query.
 *
 * @return void
 */
function agentic_editor_enqueue_editor_abilities() {
	if ( ! agentic_editor_is_supported_editor() ) {
		return;
	}

	// Ensure the Abilities client (and its import map entry) are available.
	wp_enqueue_script_module( '@wordpress/abilities' );

	// Installs `document.modelContext` for the bridge to register tools into.
	wp_enqueue_script( 'agentic-editor-webmcp-polyfill' );

	wp_register_script_module(
		'@agentic-editor/abilities/shared',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/abilities/shared.js',
		array( '@wordpress/abilities' ),
		agentic_editor_asset_version( 'js/abilities/shared.js' )
	);

	wp_register_script_module(
		'@agentic-editor/abilities/block-editor',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/abilities/block-editor.js',
		array( '@wordpress/abilities', '@agentic-editor/abilities/shared' ),
		agentic_editor_asset_version( 'js/abilities/block-editor.js' )
	);

	wp_register_script_module(
		'@agentic-editor/abilities/patterns',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/abilities/patterns.js',
		array( '@wordpress/abilities', '@agentic-editor/abilities/shared' ),
		agentic_editor_asset_version( 'js/abilities/patterns.js' )
	);

	wp_register_script_module(
		'@agentic-editor/abilities/media',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/abilities/media.js',
		array( '@wordpress/abilities', '@agentic-editor/abilities/shared' ),
		agentic_editor_asset_version( 'js/abilities/media.js' )
	);

	// The apiFetch global the media abilities call the image endpoint with.
	wp_enqueue_script( 'wp-api-fetch' );

	wp_register_script_module(
		'@agentic-editor/abilities',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/abilities.js',
		array(
			'@wordpress/abilities',
			'@agentic-editor/abilities/block-editor',
			'@agentic-editor/abilities/patterns',
			'@agentic-editor/abilities/media',
		),
		agentic_editor_asset_version( 'js/abilities.js' )
	);

	wp_register_script_module(
		'@agentic-editor/webmcp-bridge',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/webmcp-bridge.js',
		array(
			'@wordpress/abilities',
			'@agentic-editor/webmcp-polyfill',
			'@agentic-editor/webmcp-tools',
		),
		agentic_editor_asset_version( 'js/webmcp-bridge.js' )
	);

	wp_enqueue_script_module(
		'@agentic-editor/editor-abilities',
		AGENTIC_EDITOR_PLUGIN_URL . 'js/index.js',
		array(
			'@wordpress/abilities',
			'@agentic-editor/abilities',
			'@agentic-editor/webmcp-bridge',
		),
		agentic_editor_asset_version( 'js/index.js' )
	);
}
add_action( 'enqueue_block_editor_assets', 'agentic_editor_enqueue_editor_abilities' );

/**
 * Tell the media abilities whether the site can generate images.
 *
 * `editor/generate-image` is only registered when it can, so a model on a site
 * without an image-capable connector never sees the tool.
 *
 * @param array<string, mixed> $data Existing data.
 * @return array<string, mixed>
 */
function agentic_editor_media_abilities_data( $data ) {
	return array_merge(
		is_array( $data ) ? $data : array(),
		array(
			'imageGeneration' => agentic_editor_user_can_generate_images() && agentic_editor_image_is_available(),
		)
	);
}
add_filter( 'script_module_data_@agentic-editor/abilities/media', 'agentic_editor_media_abilities_data' );

/**
 * Enqueue the chat sidebar in the block editor.
 *
 * The sidebar mount is the only editor-specific piece; it renders the shared
 * panel into a PluginSidebar. The classic script dependencies are what put
 * `wp.plugins`, `wp.element`, and `wp.editor` on the page for it to read.
 *
 * @return void
 */
function agentic_editor_enqueue_editor_chat() {
	if ( ! agentic_editor_is_supported_editor() ) {
		return;
	}

	$enqueued = agentic_editor_enqueue_chat(
		'@agentic-editor/chat-editor-sidebar',
		'chat-editor-sidebar.js'
	);

	if ( ! $enqueued ) {
		return;
	}

	wp_enqueue_script( 'wp-plugins' );
	wp_enqueue_script( 'wp-data' );
	wp_enqueue_script( 'wp-blocks' );
	wp_enqueue_script( 'wp-element' );
	wp_enqueue_script( 'wp-components' );
	wp_enqueue_script( 'wp-editor' );
	wp_enqueue_script( 'wp-i18n' );
}
add_action( 'enqueue_block_editor_assets', 'agentic_editor_enqueue_editor_chat' );
