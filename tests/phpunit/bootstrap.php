<?php
/**
 * PHPUnit bootstrap.
 *
 * These are unit tests: there is no WordPress here. Brain Monkey stands in
 * for the WordPress functions the plugin calls, `stubs.php` for the handful of
 * core classes, and the AI Client is the real library from the dev
 * dependencies. Behaviour that needs a running site (capabilities against real
 * roles, which screens enqueue what) is covered by the e2e suite instead.
 *
 * @package AgenticEditor
 */

require_once dirname( __DIR__, 2 ) . '/vendor/autoload.php';

define( 'ABSPATH', sys_get_temp_dir() . '/agentic-editor-tests/' );
define( 'MB_IN_BYTES', 1024 * 1024 );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );

define( 'AGENTIC_EDITOR_VERSION', '0.0.0' );
define( 'AGENTIC_EDITOR_PLUGIN_FILE', dirname( __DIR__, 2 ) . '/agentic-editor.php' );
define( 'AGENTIC_EDITOR_PLUGIN_DIR', dirname( __DIR__, 2 ) . '/' );
define( 'AGENTIC_EDITOR_PLUGIN_URL', 'https://example.test/wp-content/plugins/agentic-editor/' );

require_once __DIR__ . '/stubs.php';
require_once __DIR__ . '/TestCase.php';
