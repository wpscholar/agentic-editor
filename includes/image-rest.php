<?php
/**
 * REST endpoint that generates an image and adds it to the Media Library.
 *
 * The AI Client runs only in PHP, so the `editor/generate-image` ability calls
 * this endpoint and leaves placing the image to the editor abilities. What
 * comes back is always a local attachment, never a URL from somewhere else.
 *
 * @package AgenticEditor
 */

defined( 'ABSPATH' ) || exit;

use WordPress\AiClient\Files\Enums\MediaOrientationEnum;

/**
 * Longest prompt the endpoint accepts, in characters.
 */
const AGENTIC_EDITOR_IMAGE_MAX_PROMPT_CHARS = 4000;

/**
 * Seconds the endpoint allows itself; image models are slower than text.
 */
const AGENTIC_EDITOR_IMAGE_TIME_LIMIT = 150;

/**
 * Orientations the endpoint accepts.
 *
 * @return string[]
 */
function agentic_editor_image_orientations() {
	return array( 'landscape', 'portrait', 'square' );
}

/**
 * Image models this plugin would like, best first.
 *
 * Empty by default: any image model the site's connectors offer will do, and
 * the chat's text-model preference says nothing about images.
 *
 * @return string[]
 */
function agentic_editor_image_model_preference() {
	$models = apply_filters( 'agentic_editor_image_model_preference', array() );

	return is_array( $models ) ? array_values( array_filter( $models, 'is_string' ) ) : array();
}

/**
 * Build the prompt for one image.
 *
 * Every option set here becomes a requirement the model must meet, so the
 * builder sets nothing it does not need: no system instruction, and a model
 * preference only if a site asked for one.
 *
 * @param string $prompt      Description of the image.
 * @param string $orientation One of agentic_editor_image_orientations().
 * @return WP_AI_Client_Prompt_Builder
 */
function agentic_editor_image_builder( $prompt, $orientation ) {
	switch ( $orientation ) {
		case 'portrait':
			$media_orientation = MediaOrientationEnum::portrait();
			break;
		case 'square':
			$media_orientation = MediaOrientationEnum::square();
			break;
		default:
			$media_orientation = MediaOrientationEnum::landscape();
	}

	$builder = wp_ai_client_prompt( $prompt )->as_output_media_orientation( $media_orientation );

	$models = agentic_editor_image_model_preference();
	if ( ! empty( $models ) ) {
		$builder = $builder->using_model_preference( ...$models );
	}

	return $builder;
}

/**
 * Whether the current user may generate images.
 *
 * Generating adds an attachment, so it takes upload rights as well as chat.
 *
 * @return bool
 */
function agentic_editor_user_can_generate_images() {
	return agentic_editor_user_can_chat() && current_user_can( 'upload_files' );
}

/**
 * Whether the site has an AI connector that can generate images.
 *
 * Deterministic and makes no request to a provider, like
 * agentic_editor_chat_is_available().
 *
 * @return bool
 */
function agentic_editor_image_is_available() {
	if ( ! function_exists( 'wp_ai_client_prompt' ) ) {
		return false;
	}

	return true === agentic_editor_image_builder( 'test', 'landscape' )->is_supported_for_image_generation();
}

/**
 * Register the image route.
 *
 * @return void
 */
function agentic_editor_register_image_routes() {
	register_rest_route(
		AGENTIC_EDITOR_CHAT_NAMESPACE,
		'/image',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => 'agentic_editor_handle_image_request',
			'permission_callback' => 'agentic_editor_user_can_generate_images',
			'args'                => array(
				'prompt'      => array(
					'type'      => 'string',
					'required'  => true,
					'minLength' => 1,
					'maxLength' => AGENTIC_EDITOR_IMAGE_MAX_PROMPT_CHARS,
				),
				'orientation' => array(
					'type'    => 'string',
					'enum'    => agentic_editor_image_orientations(),
					'default' => 'landscape',
				),
				'alt'         => array(
					'type'      => 'string',
					'maxLength' => 1000,
				),
				'title'       => array(
					'type'      => 'string',
					'maxLength' => 200,
				),
				'postId'      => array(
					'type'    => 'integer',
					'minimum' => 0,
				),
			),
		)
	);
}
add_action( 'rest_api_init', 'agentic_editor_register_image_routes' );

/**
 * Generate one image and add it to the Media Library.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function agentic_editor_handle_image_request( WP_REST_Request $request ) {
	if ( ! function_exists( 'wp_ai_client_prompt' ) ) {
		return new WP_Error(
			'agentic_editor_no_ai_client',
			__( 'This site does not have the WordPress AI Client. WordPress 7.0 or newer is required.', 'agentic-editor' ),
			array( 'status' => 501 )
		);
	}

	$prompt      = trim( (string) $request->get_param( 'prompt' ) );
	$orientation = (string) $request->get_param( 'orientation' );
	$orientation = in_array( $orientation, agentic_editor_image_orientations(), true ) ? $orientation : 'landscape';
	$alt         = trim( sanitize_text_field( (string) $request->get_param( 'alt' ) ) );
	$title       = trim( sanitize_text_field( (string) $request->get_param( 'title' ) ) );

	if ( '' === $prompt ) {
		return new WP_Error(
			'agentic_editor_image_no_prompt',
			__( 'Describe the image to generate.', 'agentic-editor' ),
			array( 'status' => 400 )
		);
	}

	$builder = agentic_editor_image_builder( $prompt, $orientation );

	if ( true !== $builder->is_supported_for_image_generation() ) {
		return new WP_Error(
			'agentic_editor_image_unsupported',
			__( 'None of the AI providers connected to this site can generate images.', 'agentic-editor' ),
			array( 'status' => 501 )
		);
	}

	$allowed = agentic_editor_chat_check_rate_limit();
	if ( is_wp_error( $allowed ) ) {
		$response = rest_convert_error_to_response( $allowed );
		$response->header( 'Retry-After', (string) $allowed->get_error_data()['retryAfter'] );
		return $response;
	}

	if ( function_exists( 'set_time_limit' ) ) {
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- Disabled on some hosts; the default limit then applies.
		@set_time_limit( AGENTIC_EDITOR_IMAGE_TIME_LIMIT );
	}

	$file = $builder->generate_image();

	if ( is_wp_error( $file ) ) {
		return agentic_editor_chat_generation_error( $file );
	}

	$attachment_id = agentic_editor_image_save_attachment(
		$file,
		array(
			'prompt'  => $prompt,
			'title'   => '' !== $title ? $title : wp_trim_words( $prompt, 8, '' ),
			'alt'     => '' !== $alt ? $alt : wp_trim_words( $prompt, 30 ),
			'post_id' => agentic_editor_image_parent_id( $request->get_param( 'postId' ) ),
		)
	);

	if ( is_wp_error( $attachment_id ) ) {
		return $attachment_id;
	}

	return rest_ensure_response( agentic_editor_image_describe_attachment( $attachment_id ) );
}

/**
 * The post to attach a generated image to, if the user may edit it.
 *
 * @param mixed $post_id Client-supplied post ID.
 * @return int 0 for none.
 */
function agentic_editor_image_parent_id( $post_id ) {
	$post_id = absint( $post_id );

	return $post_id && current_user_can( 'edit_post', $post_id ) ? $post_id : 0;
}

/**
 * Write a generated image to the uploads directory as an attachment.
 *
 * @param mixed                                                           $file    What the AI Client returned.
 * @param array{prompt: string, title: string, alt: string, post_id: int} $details Attachment details.
 * @return int|WP_Error Attachment ID.
 */
function agentic_editor_image_save_attachment( $file, array $details ) {
	if ( ! $file instanceof \WordPress\AiClient\Files\DTO\File || ! $file->isImage() ) {
		return new WP_Error(
			'agentic_editor_image_not_an_image',
			__( 'The AI provider did not return an image.', 'agentic-editor' ),
			array( 'status' => 502 )
		);
	}

	$mime_type = $file->getMimeType();
	$extension = agentic_editor_image_extension( $mime_type );

	if ( null === $extension ) {
		return new WP_Error(
			'agentic_editor_image_type_not_allowed',
			/* translators: %s: MIME type, such as image/png. */
			sprintf( __( 'The AI provider returned a %s image, which this site does not accept as an upload.', 'agentic-editor' ), $mime_type ),
			array( 'status' => 502 )
		);
	}

	// REST requests do not load the admin media functions.
	if ( ! function_exists( 'download_url' ) ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
	}
	if ( ! function_exists( 'media_handle_sideload' ) ) {
		require_once ABSPATH . 'wp-admin/includes/media.php';
	}
	if ( ! function_exists( 'wp_generate_attachment_metadata' ) ) {
		require_once ABSPATH . 'wp-admin/includes/image.php';
	}

	$tmp_name = agentic_editor_image_write_temp_file( $file );
	if ( is_wp_error( $tmp_name ) ) {
		return $tmp_name;
	}

	$base_name = sanitize_file_name( sanitize_title( $details['title'] ) );
	$file_name = ( '' !== $base_name ? $base_name : 'generated-image' ) . '.' . $extension;

	$file_array = array(
		'name'     => $file_name,
		'tmp_name' => $tmp_name,
	);

	$attachment_id = media_handle_sideload(
		$file_array,
		$details['post_id'],
		$details['title'],
		array(
			'post_content' => sprintf(
				/* translators: %s: the prompt the image was generated from. */
				__( 'Generated by AI from the prompt: %s', 'agentic-editor' ),
				$details['prompt']
			),
		)
	);

	if ( is_wp_error( $attachment_id ) ) {
		if ( file_exists( $tmp_name ) ) {
			wp_delete_file( $tmp_name );
		}

		return new WP_Error(
			'agentic_editor_image_upload_failed',
			sprintf(
				/* translators: %s: error message from the Media Library. */
				__( 'The image was generated but could not be added to the Media Library: %s', 'agentic-editor' ),
				$attachment_id->get_error_message()
			),
			array( 'status' => 500 )
		);
	}

	update_post_meta( $attachment_id, '_wp_attachment_image_alt', $details['alt'] );
	update_post_meta( $attachment_id, '_agentic_editor_image_prompt', $details['prompt'] );

	return (int) $attachment_id;
}

/**
 * The file extension for an image MIME type, if the site accepts it.
 *
 * @param string $mime_type MIME type.
 * @return string|null
 */
function agentic_editor_image_extension( $mime_type ) {
	foreach ( get_allowed_mime_types() as $extensions => $allowed_type ) {
		if ( $allowed_type === $mime_type && 0 === strpos( $mime_type, 'image/' ) ) {
			return explode( '|', (string) $extensions )[0];
		}
	}

	return null;
}

/**
 * Put the generated bytes in a temporary file for the sideload.
 *
 * @param \WordPress\AiClient\Files\DTO\File $file Generated image.
 * @return string|WP_Error Temporary file path.
 */
function agentic_editor_image_write_temp_file( $file ) {
	if ( $file->isRemote() ) {
		$tmp_name = download_url( (string) $file->getUrl() );

		return is_wp_error( $tmp_name )
			? new WP_Error(
				'agentic_editor_image_download_failed',
				__( 'The AI provider returned an image link that could not be downloaded.', 'agentic-editor' ),
				array( 'status' => 502 )
			)
			: $tmp_name;
	}

	// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Image data from the AI provider.
	$bytes    = base64_decode( (string) $file->getBase64Data(), true );
	$tmp_name = wp_tempnam( 'agentic-editor-image' );

	// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- A temporary file the sideload moves into uploads.
	if ( false === $bytes || '' === $bytes || ! $tmp_name || false === file_put_contents( $tmp_name, $bytes ) ) {
		if ( $tmp_name && file_exists( $tmp_name ) ) {
			wp_delete_file( $tmp_name );
		}

		return new WP_Error(
			'agentic_editor_image_write_failed',
			__( 'The generated image could not be saved.', 'agentic-editor' ),
			array( 'status' => 500 )
		);
	}

	return $tmp_name;
}

/**
 * What the ability needs to know about the new attachment.
 *
 * @param int $attachment_id Attachment ID.
 * @return array{id: int, url: string, alt: string, title: string, mimeType: string, width: int|null, height: int|null, sizes: array<string, array{url: string, width: int, height: int}>}
 */
function agentic_editor_image_describe_attachment( $attachment_id ) {
	$url      = (string) wp_get_attachment_url( $attachment_id );
	$metadata = wp_get_attachment_metadata( $attachment_id );
	$metadata = is_array( $metadata ) ? $metadata : array();
	$sizes    = array();

	if ( isset( $metadata['sizes'] ) && is_array( $metadata['sizes'] ) ) {
		$base_url = trailingslashit( dirname( $url ) );
		foreach ( $metadata['sizes'] as $size => $size_data ) {
			if ( is_array( $size_data ) && isset( $size_data['file'], $size_data['width'], $size_data['height'] ) ) {
				$sizes[ (string) $size ] = array(
					'url'    => $base_url . $size_data['file'],
					'width'  => (int) $size_data['width'],
					'height' => (int) $size_data['height'],
				);
			}
		}
	}

	return array(
		'id'       => $attachment_id,
		'url'      => $url,
		'alt'      => (string) get_post_meta( $attachment_id, '_wp_attachment_image_alt', true ),
		'title'    => get_the_title( $attachment_id ),
		'mimeType' => (string) get_post_mime_type( $attachment_id ),
		'width'    => isset( $metadata['width'] ) ? (int) $metadata['width'] : null,
		'height'   => isset( $metadata['height'] ) ? (int) $metadata['height'] : null,
		'sizes'    => $sizes,
	);
}
