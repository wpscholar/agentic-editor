<?php
/**
 * Media Library search that matches alt text and file names.
 *
 * Core's attachment search looks at the title, caption and description only,
 * but the words people use for an image are as often in its alt text or file
 * name: a photo titled "IMG_1234" with the alt text "Lighthouse at dusk"
 * should turn up for "lighthouse". `editor/search-media` asks for this with
 * the `agentic_editor_search` parameter, so every other media query on the
 * site is left alone.
 *
 * @package AgenticEditor
 */

defined( 'ABSPATH' ) || exit;

/**
 * Query var that marks a media query as coming from `editor/search-media`.
 */
const AGENTIC_EDITOR_MEDIA_SEARCH_VAR = 'agentic_editor_search';

/**
 * Carry the request's search flag onto the attachment query.
 *
 * @param array<string, mixed> $args    WP_Query arguments.
 * @param WP_REST_Request      $request Request.
 * @return array<string, mixed>
 */
function agentic_editor_media_search_query_args( $args, $request ) {
	if ( is_array( $args ) && $request instanceof WP_REST_Request && $request->get_param( AGENTIC_EDITOR_MEDIA_SEARCH_VAR ) ) {
		$args[ AGENTIC_EDITOR_MEDIA_SEARCH_VAR ] = true;
	}

	return $args;
}
add_filter( 'rest_attachment_query', 'agentic_editor_media_search_query_args', 10, 2 );

/**
 * Widen a flagged attachment search to alt text and file names.
 *
 * Each search term must match somewhere, as in core; a term matches if it is
 * in the title, caption, description, alt text or file name.
 *
 * @param string   $search Search SQL for the WHERE clause.
 * @param WP_Query $query  Query.
 * @return string
 */
function agentic_editor_media_search_clauses( $search, $query ) {
	global $wpdb;

	if ( ! $query instanceof WP_Query || ! $query->get( AGENTIC_EDITOR_MEDIA_SEARCH_VAR ) ) {
		return $search;
	}

	$terms = $query->get( 'search_terms' );
	if ( ! is_array( $terms ) || empty( $terms ) ) {
		return $search;
	}

	$clauses = array();
	foreach ( $terms as $term ) {
		$term = (string) $term;
		if ( '' === $term || '-' === $term[0] ) {
			continue;
		}

		$like      = '%' . $wpdb->esc_like( $term ) . '%';
		$clauses[] = $wpdb->prepare(
			"({$wpdb->posts}.post_title LIKE %s OR {$wpdb->posts}.post_excerpt LIKE %s OR {$wpdb->posts}.post_content LIKE %s"
			. " OR EXISTS (SELECT 1 FROM {$wpdb->postmeta} WHERE {$wpdb->postmeta}.post_id = {$wpdb->posts}.ID AND {$wpdb->postmeta}.meta_key IN ('_wp_attachment_image_alt', '_wp_attached_file') AND {$wpdb->postmeta}.meta_value LIKE %s))",
			$like,
			$like,
			$like,
			$like
		);
	}

	return empty( $clauses ) ? $search : ' AND (' . implode( ' AND ', $clauses ) . ') ';
}
add_filter( 'posts_search', 'agentic_editor_media_search_clauses', 10, 2 );
