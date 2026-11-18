#!/usr/bin/env bash
#
# Copy the standalone build of @w3c/webmcp-polyfill into js/vendor.
#
# The standalone IIFE initializes itself on load and needs no bundler.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="${ROOT}/node_modules/@w3c/webmcp-polyfill"
TARGET="${ROOT}/js/vendor/webmcp-polyfill"

if [ ! -d "${PACKAGE}/dist" ]; then
	echo "Missing ${PACKAGE}/dist. Run 'npm install' first." >&2
	exit 1
fi

# The path goes in as an argument, not into the script text, so a checkout
# path containing a quote cannot break (or inject into) the JavaScript.
VERSION="$(node -p "require(process.argv[1]).version" "${PACKAGE}/package.json")"

rm -rf "${TARGET}"
mkdir -p "${TARGET}"
cp "${PACKAGE}/dist/polyfill.js" "${TARGET}/webmcp-polyfill.js"
cp "${PACKAGE}/LICENSE" "${TARGET}/LICENSE"

# The source map is not shipped; drop the reference so DevTools does not 404.
node -e "
	const fs = require('fs');
	const path = process.argv[1];
	const source = fs.readFileSync(path, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '').trimEnd();
	fs.writeFileSync(path, source + '\n');
" "${TARGET}/webmcp-polyfill.js"

cat > "${TARGET}/VERSION" <<EOF
@w3c/webmcp-polyfill ${VERSION} (dist/polyfill.js)
Vendored by bin/vendor-webmcp-polyfill.sh — do not edit by hand.
EOF

echo "Vendored @w3c/webmcp-polyfill ${VERSION} into js/vendor/webmcp-polyfill"
