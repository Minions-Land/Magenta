#!/usr/bin/env bash
set -euo pipefail

DIST_REPO="${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"
VERSION="${MAGENTA_VERSION:-latest}"
RESOURCE_ASSET="magenta-resources-universal.tar.gz"
EXPECTED_APPLE_TEAM_ID="UNCONFIGURED"
MODE="install"
# Keep the trust root deliberately small.  Release binaries and resources are
# both bounded to the same hard ceiling as the in-process updater.
CHECKSUM_MAX_BYTES=$((1 * 1024 * 1024))
ASSET_MAX_BYTES=$((512 * 1024 * 1024))

case "$#" in
	0) ;;
	1)
		case "$1" in
			--uninstall) MODE="uninstall" ;;
			--help|-h)
				cat <<'EOF'
Usage: install.sh [--uninstall]

Environment: MAGENTA_INSTALL_DIR, MAGENTA_BIN_DIR, MAGENTA_VERSION,
MAGENTA_GITHUB_TOKEN, MAGENTA_GITHUB_MIRROR.
EOF
				exit 0
				;;
			*) echo "Unknown installer argument: $1" >&2; exit 2 ;;
		esac
		;;
	*) echo "Usage: install.sh [--uninstall]" >&2; exit 2 ;;
esac

ENTRYPOINT_PATH=""
LEGACY_INSTALL_DIR=""
if [ "${MAGENTA_INSTALL_DIR+x}" = "x" ]; then
	INSTALL_DIR="$MAGENTA_INSTALL_DIR"
	if [ "${MAGENTA_BIN_DIR+x}" = "x" ]; then
		BIN_DIR="$MAGENTA_BIN_DIR"
		ENTRYPOINT_PATH="${BIN_DIR%/}/magenta"
		LEGACY_INSTALL_DIR="$BIN_DIR"
	fi
else
	INSTALL_DIR="${HOME}/.local/lib/magenta"
	BIN_DIR="${MAGENTA_BIN_DIR:-${HOME}/.local/bin}"
	ENTRYPOINT_PATH="${BIN_DIR%/}/magenta"
	LEGACY_INSTALL_DIR="$BIN_DIR"
fi
if [ -z "$INSTALL_DIR" ] || { [ -n "$ENTRYPOINT_PATH" ] && [ -z "$LEGACY_INSTALL_DIR" ]; }; then
	echo "Magenta installation paths must not be empty" >&2
	exit 2
fi

case "$DIST_REPO" in
	*/*) DIST_OWNER=${DIST_REPO%%/*}; DIST_NAME=${DIST_REPO#*/} ;;
	*) DIST_OWNER=""; DIST_NAME="" ;;
esac
case "$DIST_OWNER:$DIST_NAME" in
	*[!A-Za-z0-9_.-]*:*|*:*[!A-Za-z0-9_.-]*|:*|*:|*:*/*)
		echo "Invalid MAGENTA_DIST_REPO: $DIST_REPO" >&2
		exit 1
		;;
esac

platform=$(uname -s)
architecture=$(uname -m)
case "$platform:$architecture" in
	Darwin:arm64|Darwin:aarch64) BINARY_ASSET="magenta-macos-arm64" ;;
	Darwin:x86_64|Darwin:amd64) BINARY_ASSET="magenta-macos-x64" ;;
	Linux:x86_64|Linux:amd64) BINARY_ASSET="magenta-linux-x64" ;;
	*)
		echo "Unsupported Magenta platform: $platform $architecture" >&2
		exit 1
		;;
esac

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/magenta-install.XXXXXXXX")
cleanup() {
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

CURL_AUTH_FILE=""
if [ -n "${MAGENTA_GITHUB_TOKEN:-}" ]; then
	case "$MAGENTA_GITHUB_TOKEN" in
		*[!A-Za-z0-9_.-]*)
			echo "MAGENTA_GITHUB_TOKEN contains unsupported characters" >&2
			exit 1
			;;
	esac
	CURL_AUTH_FILE="$TMP_DIR/github.netrc"
	(umask 077; printf 'machine github.com\nlogin x-access-token\npassword %s\n' "$MAGENTA_GITHUB_TOKEN" > "$CURL_AUTH_FILE")
fi

curl_to_file() {
	local url="$1"
	local output="$2"
	local max_bytes="$3"
	local authenticated="${4:-0}"
	local partial="${output}.part"
	if [[ ! "$max_bytes" =~ ^[1-9][0-9]*$ ]]; then
		echo "Invalid download byte limit: $max_bytes" >&2
		return 2
	fi
	rm -f "$partial"
	local curl_status=0
	if [ "$authenticated" = "1" ] && [ -n "$CURL_AUTH_FILE" ] && [[ "$url" == "https://github.com/${DIST_REPO}/"* ]]; then
		curl -fL --retry 3 --connect-timeout 15 --max-time 900 --max-filesize "$max_bytes" \
			--netrc-file "$CURL_AUTH_FILE" -o "$partial" "$url" || curl_status=$?
	else
		curl -fL --retry 3 --connect-timeout 15 --max-time 900 --max-filesize "$max_bytes" \
			-o "$partial" "$url" || curl_status=$?
	fi
	if [ "$curl_status" -ne 0 ]; then
		rm -f "$partial"
		return "$curl_status"
	fi
	if [ ! -s "$partial" ]; then
		rm -f "$partial"
		return 1
	fi
	local downloaded_bytes
	downloaded_bytes=$(wc -c < "$partial") || {
		rm -f "$partial"
		return 1
	}
	if [ "$downloaded_bytes" -gt "$max_bytes" ]; then
		echo "Downloaded asset exceeds the ${max_bytes}-byte limit: $url" >&2
		rm -f "$partial"
		return 1
	fi
	if ! mv "$partial" "$output"; then
		rm -f "$partial"
		return 1
	fi
}

resolve_latest_tag() {
	local release_url="https://github.com/${DIST_REPO}/releases/latest"
	local effective
	if [ -n "$CURL_AUTH_FILE" ]; then
		effective=$(curl -fsSL --max-filesize "$CHECKSUM_MAX_BYTES" --netrc-file "$CURL_AUTH_FILE" -o /dev/null -w '%{url_effective}' "$release_url")
	else
		effective=$(curl -fsSL --max-filesize "$CHECKSUM_MAX_BYTES" -o /dev/null -w '%{url_effective}' "$release_url")
	fi
	local resolved_tag=${effective##*/}
	if [[ ! "$resolved_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		echo "Unable to resolve an exact Magenta release tag from $release_url" >&2
		exit 1
	fi
	printf '%s\n' "$resolved_tag"
}

if [ -n "${MAGENTA_ASSET_BASE_URL:-}" ]; then
	ASSET_BASE_URL="${MAGENTA_ASSET_BASE_URL%/}"
	if [[ "$ASSET_BASE_URL" != https://* ]]; then
		if [ "${MAGENTA_INSTALL_TEST_MODE:-0}" != "1" ] || [[ ! "$ASSET_BASE_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/.*)?$ ]]; then
			echo "MAGENTA_ASSET_BASE_URL must use HTTPS (test mode permits only localhost HTTP)" >&2
			exit 1
		fi
	fi
	if [ "$VERSION" = "latest" ]; then
		echo "MAGENTA_VERSION must be exact when MAGENTA_ASSET_BASE_URL is set" >&2
		exit 1
	fi
elif [ "$VERSION" = "latest" ]; then
	tag=$(resolve_latest_tag)
	ASSET_BASE_URL="https://github.com/${DIST_REPO}/releases/download/${tag}"
else
	if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		echo "MAGENTA_VERSION must be latest or an exact MAJOR.MINOR.PATCH version" >&2
		exit 1
	fi
	tag="$VERSION"
	[[ "$tag" == v* ]] || tag="v$tag"
	ASSET_BASE_URL="https://github.com/${DIST_REPO}/releases/download/${tag}"
fi

EXPECTED_VERSION="${VERSION#v}"
if [ "$VERSION" = "latest" ]; then
	EXPECTED_VERSION="${tag#v}"
fi

download_release_asset() {
	local name="$1"
	local output="$2"
	local max_bytes="$3"
	local direct_url="${ASSET_BASE_URL}/${name}"
	if [ -n "${MAGENTA_GITHUB_MIRROR:-}" ] && [ -z "${MAGENTA_ASSET_BASE_URL:-}" ]; then
		if curl_to_file "${MAGENTA_GITHUB_MIRROR%/}/${direct_url}" "$output" "$max_bytes"; then
			return
		fi
	fi
	curl_to_file "$direct_url" "$output" "$max_bytes" 1
}

BIN_FILE="$TMP_DIR/$BINARY_ASSET"
RESOURCE_FILE="$TMP_DIR/$RESOURCE_ASSET"
CHECKSUMS_FILE="$TMP_DIR/SHA256SUMS"

echo "Downloading Magenta release assets for $platform $architecture..."
download_release_asset "$BINARY_ASSET" "$BIN_FILE" "$ASSET_MAX_BYTES"
if [ "$MODE" = "install" ]; then
	download_release_asset "$RESOURCE_ASSET" "$RESOURCE_FILE" "$ASSET_MAX_BYTES"
fi

# The checksum manifest is never fetched through an unauthenticated mirror.
curl_to_file "${ASSET_BASE_URL}/SHA256SUMS" "$CHECKSUMS_FILE" "$CHECKSUM_MAX_BYTES" 1

expected_checksum() {
	local name="$1"
	awk -v target="$name" '
		$2 == target || $2 == "*" target { count += 1; hash = $1 }
		END {
			if (count != 1 || length(hash) != 64 || hash ~ /[^0-9A-Fa-f]/) exit 1
			print tolower(hash)
		}
	' "$CHECKSUMS_FILE"
}

actual_checksum() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print tolower($1) }'
	else
		shasum -a 256 "$1" | awk '{ print tolower($1) }'
	fi
}

verify_asset() {
	local file="$1"
	local name="$2"
	local expected
	expected=$(expected_checksum "$name") || {
		echo "SHA256SUMS does not contain exactly one valid checksum for $name" >&2
		exit 1
	}
	local actual
	actual=$(actual_checksum "$file")
	if [ "$actual" != "$expected" ]; then
		echo "Checksum verification failed for $name" >&2
		exit 1
	fi
}

verify_asset "$BIN_FILE" "$BINARY_ASSET"
if [ "$MODE" = "install" ]; then
	verify_asset "$RESOURCE_FILE" "$RESOURCE_ASSET"
fi

if [ "$platform" = "Darwin" ]; then
	if [[ ! "$EXPECTED_APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
		echo "macOS release trust is unconfigured; refusing to execute the downloaded candidate" >&2
		exit 1
	fi
	/usr/bin/codesign --verify --strict --check-notarization --verbose=2 "$BIN_FILE"
	/usr/sbin/spctl --assess --type execute --verbose=4 "$BIN_FILE"
	signature=$(/usr/bin/codesign --display --verbose=4 "$BIN_FILE" 2>&1)
	grep -q '^Identifier=land\.minions\.magenta$' <<<"$signature"
	grep -q '^Authority=Developer ID Application:' <<<"$signature"
	grep -q "^TeamIdentifier=${EXPECTED_APPLE_TEAM_ID}$" <<<"$signature"
	grep -Eq '^Timestamp=.+' <<<"$signature"
	grep -Eq '^CodeDirectory .*flags=.*runtime' <<<"$signature"
	if grep -q '^Signature=adhoc$' <<<"$signature"; then
		echo "Downloaded macOS binary has an ad-hoc signature" >&2
		exit 1
	fi
fi
chmod 0755 "$BIN_FILE"

mkdir -p "$INSTALL_DIR"
INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P)
if [ -n "$ENTRYPOINT_PATH" ]; then
	mkdir -p "$LEGACY_INSTALL_DIR"
	LEGACY_INSTALL_DIR=$(cd "$LEGACY_INSTALL_DIR" && pwd -P)
	ENTRYPOINT_PATH="$LEGACY_INSTALL_DIR/magenta"
	if [ "$INSTALL_DIR" = "$LEGACY_INSTALL_DIR" ]; then
		echo "MAGENTA_INSTALL_DIR and MAGENTA_BIN_DIR must identify different directories" >&2
		exit 2
	fi
fi

layout_args=(--install-dir "$INSTALL_DIR")
if [ -n "$ENTRYPOINT_PATH" ]; then
	layout_args+=(--entrypoint-path "$ENTRYPOINT_PATH" --legacy-install-dir "$LEGACY_INSTALL_DIR")
fi

if [ "$MODE" = "uninstall" ]; then
	"$BIN_FILE" _uninstall-unix "${layout_args[@]}"
else
	"$BIN_FILE" _install-unix \
		"${layout_args[@]}" \
		--resource-archive "$RESOURCE_FILE" \
		--checksums "$CHECKSUMS_FILE" \
		--binary-asset "$BINARY_ASSET" \
		--expected-version "$EXPECTED_VERSION"
fi
