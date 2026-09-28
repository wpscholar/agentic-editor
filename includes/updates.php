<?php
/**
 * Plugin updates from GitHub releases.
 *
 * The plugin is not on WordPress.org, so its `Update URI` header points at the
 * GitHub repository. WordPress then skips WordPress.org for this plugin and
 * asks `update_plugins_github.com` instead, which reads the latest release.
 * Updates show in wp-admin like any other plugin's, auto-updates included.
 *
 * A release is offered only once `agentic-editor.zip` is attached: the release
 * workflow runs the full test suite before it uploads the zip, so a freshly
 * published release has none for several minutes.
 *
 * @package AgenticEditor
 */

defined( 'ABSPATH' ) || exit;

/**
 * The GitHub repository releases come from, as `owner/name`.
 */
const AGENTIC_EDITOR_REPOSITORY = 'wpscholar/agentic-editor';

/**
 * The release asset that holds the installable plugin.
 */
const AGENTIC_EDITOR_RELEASE_ASSET = 'agentic-editor.zip';

/**
 * The plugin slug, which is also its folder in the zip.
 */
const AGENTIC_EDITOR_SLUG = 'agentic-editor';

/**
 * Site transient that caches the latest release.
 */
const AGENTIC_EDITOR_RELEASE_TRANSIENT = 'agentic_editor_latest_release';

/**
 * The latest published release that can be installed, or null.
 *
 * Cached for six hours, and a failed lookup for one, since GitHub allows 60
 * unauthenticated API requests an hour per IP address and a shared host may
 * have many sites behind one.
 *
 * @return array{version: string, package: string, url: string, notes: string, published: string}|null
 */
function agentic_editor_latest_release() {
	$cached = get_site_transient( AGENTIC_EDITOR_RELEASE_TRANSIENT );
	if ( is_array( $cached ) && array_key_exists( 'release', $cached ) ) {
		if ( null === $cached['release'] ) {
			return null;
		}

		// The cache lives in the database, so anything unexpected in it is a
		// miss rather than a release.
		$release = $cached['release'];
		if (
			is_array( $release )
			&& is_string( $release['version'] ?? null )
			&& is_string( $release['package'] ?? null )
			&& is_string( $release['url'] ?? null )
			&& is_string( $release['notes'] ?? null )
			&& is_string( $release['published'] ?? null )
		) {
			return array(
				'version'   => $release['version'],
				'package'   => $release['package'],
				'url'       => $release['url'],
				'notes'     => $release['notes'],
				'published' => $release['published'],
			);
		}
	}

	$response = wp_remote_get(
		'https://api.github.com/repos/' . AGENTIC_EDITOR_REPOSITORY . '/releases/latest',
		array(
			'timeout' => 10,
			'headers' => array( 'Accept' => 'application/vnd.github+json' ),
		)
	);

	$release = null;
	if ( ! is_wp_error( $response ) && 200 === wp_remote_retrieve_response_code( $response ) ) {
		$release = agentic_editor_parse_release( json_decode( wp_remote_retrieve_body( $response ), true ) );
	}

	set_site_transient(
		AGENTIC_EDITOR_RELEASE_TRANSIENT,
		array( 'release' => $release ),
		null === $release ? HOUR_IN_SECONDS : 6 * HOUR_IN_SECONDS
	);

	return $release;
}

/**
 * Read an installable release out of GitHub's release JSON.
 *
 * The tag is the version (`1.2.0` or `v1.2.0`). The zip must be fully uploaded
 * and served from this repository's release downloads, so nothing else the API
 * might return is ever installed.
 *
 * @param mixed $data Decoded release JSON.
 * @return array{version: string, package: string, url: string, notes: string, published: string}|null
 */
function agentic_editor_parse_release( $data ) {
	if ( ! is_array( $data ) || ! empty( $data['draft'] ) || ! empty( $data['prerelease'] ) ) {
		return null;
	}

	$version = is_string( $data['tag_name'] ?? null ) ? ltrim( $data['tag_name'], 'vV' ) : '';
	if ( ! preg_match( '/^\d+\.\d+(\.\d+)?$/', $version ) ) {
		return null;
	}

	$downloads = 'https://github.com/' . AGENTIC_EDITOR_REPOSITORY . '/releases/download/';
	$package   = '';
	foreach ( is_array( $data['assets'] ?? null ) ? $data['assets'] : array() as $asset ) {
		if (
			is_array( $asset )
			&& AGENTIC_EDITOR_RELEASE_ASSET === ( $asset['name'] ?? null )
			&& 'uploaded' === ( $asset['state'] ?? null )
			&& is_string( $asset['browser_download_url'] ?? null )
			&& str_starts_with( $asset['browser_download_url'], $downloads )
		) {
			$package = $asset['browser_download_url'];
			break;
		}
	}
	if ( '' === $package ) {
		return null;
	}

	return array(
		'version'   => $version,
		'package'   => $package,
		'url'       => is_string( $data['html_url'] ?? null ) ? $data['html_url'] : 'https://github.com/' . AGENTIC_EDITOR_REPOSITORY . '/releases',
		'notes'     => is_string( $data['body'] ?? null ) ? $data['body'] : '',
		'published' => is_string( $data['published_at'] ?? null ) ? $data['published_at'] : '',
	);
}

/**
 * Report the latest release to WordPress's update check.
 *
 * WordPress compares the version itself: a newer one is listed as an update,
 * the same one as up to date. It also sets `id` and `plugin` from the header.
 * The slug makes the update row's "View details" link ask for this plugin,
 * which `agentic_editor_plugins_api()` answers.
 *
 * @param array<string, mixed>|false $update      Update data from an earlier filter, or false.
 * @param array<string, mixed>       $plugin_data Plugin headers.
 * @param string                     $plugin_file Plugin path relative to the plugins directory.
 * @return array<string, mixed>|false
 */
function agentic_editor_update_plugins( $update, $plugin_data, $plugin_file ) {
	if ( plugin_basename( AGENTIC_EDITOR_PLUGIN_FILE ) !== $plugin_file ) {
		return $update;
	}

	$release = agentic_editor_latest_release();
	if ( null === $release ) {
		return $update;
	}

	return array(
		'slug'         => AGENTIC_EDITOR_SLUG,
		'version'      => $release['version'],
		'url'          => $release['url'],
		'package'      => $release['package'],
		'requires'     => '7.0',
		'requires_php' => '8.0',
	);
}
add_filter( 'update_plugins_github.com', 'agentic_editor_update_plugins', 10, 3 );

/**
 * Answer "View details" for this plugin.
 *
 * Without this, WordPress would look the slug up on WordPress.org, and show
 * whichever plugin there has it.
 *
 * @param false|object|array<string, mixed> $result Result from an earlier filter.
 * @param string                            $action The plugins_api() action.
 * @param object                            $args   Request arguments.
 * @return false|object|array<string, mixed>
 */
function agentic_editor_plugins_api( $result, $action, $args ) {
	if ( 'plugin_information' !== $action || ! is_object( $args ) || AGENTIC_EDITOR_SLUG !== ( $args->slug ?? null ) ) {
		return $result;
	}

	$release = agentic_editor_latest_release();
	$home    = 'https://github.com/' . AGENTIC_EDITOR_REPOSITORY;

	$info = array(
		'name'         => 'Agentic Editor',
		'slug'         => AGENTIC_EDITOR_SLUG,
		'version'      => $release['version'] ?? AGENTIC_EDITOR_VERSION,
		'author'       => 'Micah Wood',
		'homepage'     => $home,
		'requires'     => '7.0',
		'requires_php' => '8.0',
		'sections'     => array(
			'description' => '<p>' . esc_html__( 'Client-side block editor abilities bridged to WebMCP, and an AI chat panel powered by the WordPress AI Client.', 'agentic-editor' ) . '</p>',
		),
	);

	if ( null !== $release ) {
		$info['download_link']         = $release['package'];
		$info['last_updated']          = $release['published'];
		$info['sections']['changelog'] = '' === trim( $release['notes'] )
			? '<p><a href="' . esc_url( $release['url'] ) . '">' . esc_html__( 'Release notes on GitHub', 'agentic-editor' ) . '</a></p>'
			: wpautop( esc_html( $release['notes'] ) );
	}

	return (object) $info;
}
add_filter( 'plugins_api', 'agentic_editor_plugins_api', 10, 3 );

/**
 * Forget the cached release when an admin clicks "Check again".
 *
 * Dashboard → Updates re-runs the plugin update check, but this cache would
 * still answer for up to six hours. Runs before core's own check on that
 * screen, which is hooked at the default priority.
 *
 * @return void
 */
function agentic_editor_clear_release_cache() {
	// Only drops a cache; the link that sets it carries no nonce in core either.
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended
	if ( ! empty( $_GET['force-check'] ) && current_user_can( 'update_plugins' ) ) {
		delete_site_transient( AGENTIC_EDITOR_RELEASE_TRANSIENT );
	}
}
add_action( 'load-update-core.php', 'agentic_editor_clear_release_cache', 9 );
