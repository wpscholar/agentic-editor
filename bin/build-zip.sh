#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SLUG="agentic-editor"
DIST_DIR="${ROOT}/dist"
ZIP_PATH="${DIST_DIR}/${PLUGIN_SLUG}.zip"

if ! command -v zip >/dev/null 2>&1; then
	echo "error: the zip command is not installed. Install it (e.g. apt install zip) and try again." >&2
	exit 1
fi

mkdir -p "${DIST_DIR}"
rm -f "${ZIP_PATH}"

STAGE="$(mktemp -d)"
cleanup() {
	rm -rf "${STAGE}"
}
trap cleanup EXIT

mkdir -p "${STAGE}/${PLUGIN_SLUG}"

# The chat panel is compiled from src/, so the zip is only valid after a build.
(cd "${ROOT}" && npm run build)

cp "${ROOT}/agentic-editor.php" "${ROOT}/LICENSE" "${STAGE}/${PLUGIN_SLUG}/"
cp -R "${ROOT}/js" "${STAGE}/${PLUGIN_SLUG}/js"
cp -R "${ROOT}/css" "${STAGE}/${PLUGIN_SLUG}/css"
cp -R "${ROOT}/includes" "${STAGE}/${PLUGIN_SLUG}/includes"
cp -R "${ROOT}/build" "${STAGE}/${PLUGIN_SLUG}/build"

# Source maps are a development aid and roughly double the payload.
find "${STAGE}/${PLUGIN_SLUG}/build" -name '*.map' -delete

# Type declarations and unit tests for js/ are development-only.
rm -rf "${STAGE}/${PLUGIN_SLUG}/js/types"
find "${STAGE}/${PLUGIN_SLUG}/js" -name '*.test.js' -delete

(
	cd "${STAGE}"
	zip -r "${ZIP_PATH}" "${PLUGIN_SLUG}" \
		-x "*.DS_Store" \
		-x "*/.git/*" \
		-x "*/node_modules/*"
)

echo "Created ${ZIP_PATH}"
unzip -l "${ZIP_PATH}"
