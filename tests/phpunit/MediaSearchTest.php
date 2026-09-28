<?php
/**
 * Tests for the Media Library search that matches alt text and file names.
 *
 * @package AgenticEditor
 */

namespace AgenticEditor\Tests;

/**
 * Just enough of wpdb to build the search clause.
 */
class FakeWpdb {
	/** @var string */
	public $posts = 'wp_posts';

	/** @var string */
	public $postmeta = 'wp_postmeta';

	public function esc_like( $text ) {
		return addcslashes( (string) $text, '_%\\' );
	}

	public function prepare( $query, ...$args ) {
		foreach ( $args as $arg ) {
			$query = preg_replace( '/%s/', "'" . addslashes( (string) $arg ) . "'", $query, 1 );
		}
		return $query;
	}
}

class MediaSearchTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['wpdb'] = new FakeWpdb();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['wpdb'] );
		parent::tearDown();
	}

	/**
	 * @param array<string, mixed> $vars Query vars.
	 * @return string
	 */
	private function search_sql( array $vars ) {
		return agentic_editor_media_search_clauses( ' AND (core search) ', new \WP_Query( $vars ) );
	}

	public function test_an_unflagged_query_keeps_core_search() {
		$this->assertSame( ' AND (core search) ', $this->search_sql( array( 'search_terms' => array( 'lighthouse' ) ) ) );
	}

	public function test_a_flagged_query_without_terms_keeps_core_search() {
		$this->assertSame(
			' AND (core search) ',
			$this->search_sql(
				array(
					'agentic_editor_search' => true,
					'search_terms'          => array(),
				)
			)
		);
	}

	public function test_a_flagged_query_matches_alt_text_and_file_names() {
		$sql = $this->search_sql(
			array(
				'agentic_editor_search' => true,
				'search_terms'          => array( 'lighthouse', 'dusk' ),
			)
		);

		$this->assertStringNotContainsString( 'core search', $sql );
		$this->assertStringContainsString( "'_wp_attachment_image_alt', '_wp_attached_file'", $sql );
		$this->assertStringContainsString( "wp_posts.post_title LIKE '%lighthouse%'", $sql );
		$this->assertStringContainsString( "wp_postmeta.meta_value LIKE '%dusk%'", $sql );
		// Every term must match, as in core.
		$this->assertStringContainsString( ') AND (', $sql );
	}

	public function test_like_wildcards_in_a_term_are_escaped() {
		$sql = $this->search_sql(
			array(
				'agentic_editor_search' => true,
				'search_terms'          => array( '100%_off' ),
			)
		);

		$this->assertStringContainsString( '100\\%\\_off', $sql );
	}

	public function test_the_request_flag_reaches_the_query() {
		$flagged = agentic_editor_media_search_query_args( array(), new \WP_REST_Request( array( 'agentic_editor_search' => 1 ) ) );
		$plain   = agentic_editor_media_search_query_args( array(), new \WP_REST_Request( array() ) );

		$this->assertTrue( $flagged['agentic_editor_search'] );
		$this->assertArrayNotHasKey( 'agentic_editor_search', $plain );
	}
}
