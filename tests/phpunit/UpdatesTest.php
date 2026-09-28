<?php
/**
 * Tests for plugin updates from GitHub releases.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

use Brain\Monkey\Functions;

class UpdatesTest extends TestCase {

	private const PLUGIN_FILE = 'agentic-editor/agentic-editor.php';

	private const ZIP_URL = 'https://github.com/wpscholar/agentic-editor/releases/download/1.2.0/agentic-editor.zip';

	/**
	 * Site transients set during the test, keyed by name.
	 *
	 * @var array<string, mixed>
	 */
	private $site_transients = array();

	/**
	 * Every [ key, expiration ] passed to set_site_transient().
	 *
	 * @var array<int, array{0: string, 1: int}>
	 */
	private $cached = array();

	/**
	 * What the GitHub API answers: [ status, body ], or a WP_Error.
	 *
	 * @var array{0: int, 1: string}|\WP_Error
	 */
	private $github = array( 404, '{}' );

	/**
	 * How many times the GitHub API was called.
	 *
	 * @var int
	 */
	private $requests = 0;

	protected function setUp(): void {
		parent::setUp();

		$this->site_transients = array();
		$this->cached          = array();
		$this->github          = array( 404, '{}' );
		$this->requests        = 0;

		Functions\stubEscapeFunctions();
		Functions\stubs(
			array(
				'plugin_basename'                  => self::PLUGIN_FILE,
				'wpautop'                          => static function ( $text ) {
					return '<p>' . $text . '</p>';
				},
				'get_site_transient'               => function ( $key ) {
					return array_key_exists( $key, $this->site_transients ) ? $this->site_transients[ $key ] : false;
				},
				'set_site_transient'               => function ( $key, $value, $expiration ) {
					$this->site_transients[ $key ] = $value;
					$this->cached[]                = array( $key, $expiration );
					return true;
				},
				'delete_site_transient'            => function ( $key ) {
					unset( $this->site_transients[ $key ] );
					return true;
				},
				'wp_remote_get'                    => function ( $url ) {
					++$this->requests;
					$this->assertSame( 'https://api.github.com/repos/wpscholar/agentic-editor/releases/latest', $url );
					return $this->github;
				},
				'wp_remote_retrieve_response_code' => static function ( $response ) {
					return $response[0];
				},
				'wp_remote_retrieve_body'          => static function ( $response ) {
					return $response[1];
				},
			)
		);
	}

	/**
	 * GitHub's release JSON, with the plugin zip attached.
	 *
	 * @param array<string, mixed> $overrides Top-level fields to replace.
	 * @return array<string, mixed>
	 */
	private function release( array $overrides = array() ) {
		return array_merge(
			array(
				'tag_name'     => 'v1.2.0',
				'draft'        => false,
				'prerelease'   => false,
				'html_url'     => 'https://github.com/wpscholar/agentic-editor/releases/tag/v1.2.0',
				'body'         => "Fixes\n\n- A <b>bold</b> claim",
				'published_at' => '2026-10-01T12:00:00Z',
				'assets'       => array(
					array(
						'name'                 => 'agentic-editor.zip',
						'state'                => 'uploaded',
						'browser_download_url' => self::ZIP_URL,
					),
				),
			),
			$overrides
		);
	}

	/**
	 * Have the GitHub API answer with this release.
	 *
	 * @param array<string, mixed> $release Release JSON.
	 */
	private function github_returns( array $release ) {
		$this->github = array( 200, (string) json_encode( $release ) );
	}

	public function test_a_release_with_the_zip_is_offered() {
		$this->github_returns( $this->release() );

		$update = agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		$this->assertSame( 'agentic-editor', $update['slug'] );
		$this->assertSame( '1.2.0', $update['version'] );
		$this->assertSame( self::ZIP_URL, $update['package'] );
		$this->assertSame( 'https://github.com/wpscholar/agentic-editor/releases/tag/v1.2.0', $update['url'] );
		$this->assertSame( '8.0', $update['requires_php'] );
	}

	public function test_other_plugins_on_github_are_left_alone() {
		$this->github_returns( $this->release() );
		$theirs = array( 'version' => '9.9.9' );

		$this->assertSame( $theirs, agentic_editor_update_plugins( $theirs, array(), 'someone-else/plugin.php' ) );
		$this->assertFalse( agentic_editor_update_plugins( false, array(), 'someone-else/plugin.php' ) );
		$this->assertSame( 0, $this->requests );
	}

	public function test_a_release_whose_zip_is_not_uploaded_yet_is_not_offered() {
		$this->github_returns( $this->release( array( 'assets' => array() ) ) );
		$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ) );

		$this->site_transients = array();
		$release               = $this->release();
		$release['assets'][0]['state'] = 'starter';
		$this->github_returns( $release );
		$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ) );
	}

	public function test_a_zip_from_anywhere_else_is_never_offered() {
		$release = $this->release();
		$release['assets'][0]['browser_download_url'] = 'https://example.test/agentic-editor.zip';
		$this->github_returns( $release );

		$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ) );
	}

	public function test_drafts_prereleases_and_odd_tags_are_not_offered() {
		foreach ( array(
			array( 'draft' => true ),
			array( 'prerelease' => true ),
			array( 'tag_name' => 'nightly' ),
			array( 'tag_name' => '1.2.0-beta.1' ),
		) as $overrides ) {
			$this->site_transients = array();
			$this->github_returns( $this->release( $overrides ) );
			$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ), (string) json_encode( $overrides ) );
		}
	}

	public function test_a_tag_without_a_v_is_read_too() {
		$this->github_returns( $this->release( array( 'tag_name' => '1.3' ) ) );

		$this->assertSame( '1.3', agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE )['version'] );
	}

	public function test_a_release_is_cached_for_six_hours() {
		$this->github_returns( $this->release() );

		agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );
		agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		$this->assertSame( 1, $this->requests );
		$this->assertSame( array( array( 'agentic_editor_latest_release', 6 * HOUR_IN_SECONDS ) ), $this->cached );
	}

	public function test_a_malformed_cache_entry_is_fetched_again() {
		$this->site_transients['agentic_editor_latest_release'] = array( 'release' => array( 'version' => '9.9.9' ) );
		$this->github_returns( $this->release() );

		$update = agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		$this->assertSame( 1, $this->requests );
		$this->assertSame( '1.2.0', $update['version'] );
	}

	public function test_a_failed_lookup_is_cached_for_an_hour() {
		$this->github = new \WP_Error( 'http_request_failed', 'Timed out' );

		$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ) );
		$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ) );

		$this->assertSame( 1, $this->requests );
		$this->assertSame( array( array( 'agentic_editor_latest_release', HOUR_IN_SECONDS ) ), $this->cached );
	}

	public function test_no_releases_yet_is_not_an_update() {
		$this->github = array( 404, '{"message":"Not Found"}' );

		$this->assertFalse( agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE ) );
	}

	public function test_check_again_clears_the_cache() {
		$this->capabilities = array( 'update_plugins' );
		$this->github_returns( $this->release() );
		agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		$_GET['force-check'] = '1';
		try {
			agentic_editor_clear_release_cache();
		} finally {
			unset( $_GET['force-check'] );
		}
		agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		$this->assertSame( 2, $this->requests );
	}

	public function test_the_cache_stays_without_a_force_check_or_the_capability() {
		$this->github_returns( $this->release() );
		agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		agentic_editor_clear_release_cache();

		$_GET['force-check'] = '1';
		try {
			agentic_editor_clear_release_cache();
		} finally {
			unset( $_GET['force-check'] );
		}
		agentic_editor_update_plugins( false, array(), self::PLUGIN_FILE );

		$this->assertSame( 1, $this->requests );
	}

	public function test_view_details_describes_this_plugin_with_escaped_release_notes() {
		$this->github_returns( $this->release() );

		$info = agentic_editor_plugins_api( false, 'plugin_information', (object) array( 'slug' => 'agentic-editor' ) );

		$this->assertIsObject( $info );
		$this->assertSame( 'Agentic Editor', $info->name );
		$this->assertSame( '1.2.0', $info->version );
		$this->assertSame( self::ZIP_URL, $info->download_link );
		$this->assertStringContainsString( '&lt;b&gt;bold&lt;/b&gt;', $info->sections['changelog'] );
		$this->assertStringNotContainsString( '<b>', $info->sections['changelog'] );
	}

	public function test_view_details_links_to_github_when_a_release_has_no_notes() {
		$this->github_returns( $this->release( array( 'body' => '' ) ) );

		$info = agentic_editor_plugins_api( false, 'plugin_information', (object) array( 'slug' => 'agentic-editor' ) );

		$this->assertStringContainsString( 'https://github.com/wpscholar/agentic-editor/releases/tag/v1.2.0', $info->sections['changelog'] );
	}

	public function test_view_details_never_falls_through_to_wordpress_org() {
		$this->github = array( 500, '' );

		$info = agentic_editor_plugins_api( false, 'plugin_information', (object) array( 'slug' => 'agentic-editor' ) );

		$this->assertIsObject( $info );
		$this->assertSame( 'https://github.com/wpscholar/agentic-editor', $info->homepage );
		$this->assertSame( AGENTIC_EDITOR_VERSION, $info->version );
		$this->assertFalse( property_exists( $info, 'download_link' ) );
	}

	public function test_other_plugins_details_are_left_alone() {
		$this->assertFalse( agentic_editor_plugins_api( false, 'plugin_information', (object) array( 'slug' => 'akismet' ) ) );
		$this->assertFalse( agentic_editor_plugins_api( false, 'query_plugins', (object) array( 'slug' => 'agentic-editor' ) ) );
		$this->assertSame( 0, $this->requests );
	}
}
