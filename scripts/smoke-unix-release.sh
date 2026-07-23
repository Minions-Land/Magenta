#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
	echo "Usage: smoke-unix-release.sh <release-dir> <install-dir> <vMAJOR.MINOR.PATCH>" >&2
	exit 2
fi

release_dir_input="$1"
smoke_root="$2"
release_tag="$3"
if [ -z "${RUNNER_TEMP:-}" ]; then
	echo "RUNNER_TEMP is required for the Unix release smoke test" >&2
	exit 2
fi
if [[ ! "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Invalid release tag: $release_tag" >&2
	exit 2
fi
release_dir=$(cd "$release_dir_input" && pwd -P)

case "$(uname -s):$(uname -m)" in
	Linux:x86_64|Linux:amd64) binary_asset="magenta-linux-x64" ;;
	Darwin:arm64|Darwin:aarch64) binary_asset="magenta-macos-arm64" ;;
	Darwin:x86_64|Darwin:amd64) binary_asset="magenta-macos-x64" ;;
	*) echo "Unsupported native smoke platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

chmod 0755 "$release_dir/install.sh" "$release_dir/$binary_asset"
mkdir -p "$smoke_root"
smoke_root=$(cd "$smoke_root" && pwd -P)
smoke_home="$smoke_root/home"
payload_dir="$smoke_home/.local/lib/magenta"
bin_dir="$smoke_home/.local/bin"
entrypoint="$bin_dir/magenta"
mkdir -p "$payload_dir" "$bin_dir"
printf 'preserve payload\n' > "$payload_dir/release-smoke-sentinel"
printf 'preserve bin\n' > "$bin_dir/release-smoke-sentinel"

port="${MAGENTA_SMOKE_ASSET_PORT:-8765}"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$release_dir" >"$RUNNER_TEMP/magenta-asset-server.log" 2>&1 &
server_pid=$!
cleanup() {
	kill "$server_pid" 2>/dev/null || true
	wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
for _attempt in $(seq 1 50); do
	if curl -fsS "http://127.0.0.1:${port}/SHA256SUMS" >/dev/null; then
		break
	fi
	sleep 0.1
done
curl -fsS "http://127.0.0.1:${port}/SHA256SUMS" >/dev/null

run_installer() {
	env -u MAGENTA_INSTALL_DIR -u MAGENTA_BIN_DIR \
		HOME="$smoke_home" \
		MAGENTA_ASSET_BASE_URL="http://127.0.0.1:${port}" \
		MAGENTA_INSTALL_TEST_MODE=1 \
		MAGENTA_INSTALL_TEST_OPERATION_ID="$1" \
		MAGENTA_VERSION="$release_tag" \
		bash "$release_dir/install.sh"
}

run_fault() {
	local operation_id="$1"
	local fault_point="$2"
	if env -u MAGENTA_INSTALL_DIR -u MAGENTA_BIN_DIR \
		HOME="$smoke_home" \
		MAGENTA_ASSET_BASE_URL="http://127.0.0.1:${port}" \
		MAGENTA_INSTALL_TEST_FAULT="$fault_point" \
		MAGENTA_INSTALL_TEST_MODE=1 \
		MAGENTA_INSTALL_TEST_OPERATION_ID="$operation_id" \
		MAGENTA_VERSION="$release_tag" \
		bash "$release_dir/install.sh"; then
		echo "Fault injection unexpectedly succeeded: $fault_point" >&2
		exit 1
	fi
	test -f "$payload_dir/.magenta-install-update.json"
	test -d "$payload_dir/.magenta-update-staging-$operation_id"
	test -d "$payload_dir/.magenta-update-backup-$operation_id"
	test ! -e "$payload_dir/.magenta-install-update.lock"
	test ! -e "$bin_dir/.magenta-install-update.lock"
}

assert_clean_transaction_state() {
	test ! -e "$payload_dir/.magenta-install-update.json"
	test ! -e "$payload_dir/.magenta-install-update.json.tmp"
	test ! -e "$payload_dir/.magenta-install-update.lock"
	test ! -e "$bin_dir/.magenta-install-update.lock"
	if find "$payload_dir" -maxdepth 1 \( -name '.magenta-update-staging-*' -o -name '.magenta-update-backup-*' \) -print -quit | grep -q .; then
		echo "Unix installer left transaction directories behind" >&2
		exit 1
	fi
}

assert_installed_release() {
	test -L "$entrypoint"
	test "$(readlink "$entrypoint")" = "$payload_dir/magenta"
	test "$("$entrypoint" --version)" = "${release_tag#v}"
	"$entrypoint" --help >/dev/null
	HOME="$smoke_home" "$entrypoint" --help --offline smoke >/dev/null
	test -x "$payload_dir/_magenta/process-tools/target/release/magenta-process-tools"
	"$payload_dir/_magenta/process-tools/target/release/magenta-process-tools" --help >/dev/null
	test "$(cat "$payload_dir/release-smoke-sentinel")" = "preserve payload"
	test "$(cat "$bin_dir/release-smoke-sentinel")" = "preserve bin"
	assert_clean_transaction_state
}

run_uninstaller() {
	env -u MAGENTA_INSTALL_DIR -u MAGENTA_BIN_DIR \
		HOME="$smoke_home" \
		MAGENTA_ASSET_BASE_URL="http://127.0.0.1:${port}" \
		MAGENTA_INSTALL_TEST_MODE=1 \
		MAGENTA_VERSION="$release_tag" \
		bash "$release_dir/install.sh" --uninstall
}

assert_uninstalled_release() {
	test ! -e "$entrypoint"
	test ! -L "$entrypoint"
	test ! -e "$payload_dir/magenta"
	test ! -e "$payload_dir/_magenta"
	test ! -e "$payload_dir/magenta-release.json"
	test "$(cat "$payload_dir/release-smoke-sentinel")" = "preserve payload"
	test "$(cat "$bin_dir/release-smoke-sentinel")" = "preserve bin"
	assert_clean_transaction_state
}

run_installer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
assert_installed_release

rm "$payload_dir/magenta"
test -L "$entrypoint"
test ! -e "$entrypoint"
run_installer bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
assert_installed_release

run_fault cccccccccccccccccccccccccccccccc resource-install:README.md
run_installer dddddddddddddddddddddddddddddddd
assert_installed_release

run_fault eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee binary-install:complete
run_installer ffffffffffffffffffffffffffffffff
assert_installed_release

run_uninstaller
assert_uninstalled_release
run_uninstaller
assert_uninstalled_release

# Leave one verified installation for the calling native job to inspect.
run_installer 11111111111111111111111111111111
assert_installed_release
