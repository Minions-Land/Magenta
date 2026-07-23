#!/usr/bin/env bash
#
# Build legacy per-platform archives for local diagnostics.
# The supported public asset layout is owned by .github/workflows/release.yml.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-deps] [--skip-build] [--platform <platform>] [--out <dir>] [--force]
#
# Options:
#   --skip-install      Skip npm ci
#   --skip-deps         Skip installing cross-platform dependencies
#   --skip-build        Reuse existing output instead of running the offline build
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>         Output directory (default: pi/coding-agent/binaries)
#   --force             Replace an existing output created by this script
#
# Output:
#   pi/coding-agent/binaries/
#     <binary>-darwin-arm64.tar.gz
#     <binary>-darwin-x64.tar.gz
#     <binary>-linux-x64.tar.gz
#     <binary>-linux-arm64.tar.gz
#     <binary>-windows-x64.zip
#     <binary>-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
PLATFORM=""
OUTPUT_DIR=""
FORCE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

REPO_ROOT="$(pwd -P)"
DEFAULT_OUTPUT_DIR="$REPO_ROOT/pi/coding-agent/binaries"
REQUESTED_OUTPUT_DIR="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "${OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}")"

canonicalize_output_path() {
	# JavaScript template literals in this single-quoted program belong to Node.
	# shellcheck disable=SC2016
	node -e '
        const { existsSync, lstatSync, realpathSync } = require("node:fs");
        const { basename, dirname, resolve } = require("node:path");
        const requestedPath = resolve(process.argv[1]);
        if (existsSync(requestedPath)) {
            process.stdout.write(realpathSync(requestedPath));
        } else {
            const suffix = [];
            let ancestor = requestedPath;
            while (!existsSync(ancestor)) {
                try {
                    if (lstatSync(ancestor).isSymbolicLink()) {
                        throw new Error(`Output path contains an unresolved symlink: ${ancestor}`);
                    }
                } catch (error) {
                    if (error?.code !== "ENOENT") throw error;
                }
                const parent = dirname(ancestor);
                if (parent === ancestor) break;
                suffix.unshift(basename(ancestor));
                ancestor = parent;
            }
            process.stdout.write(resolve(realpathSync(ancestor), ...suffix));
        }
    ' "$1"
}

assert_safe_output_path() {
    local output_dir="$1"

    if [[ "$output_dir" == "/" ]]; then
        echo "Refusing filesystem root as the output directory" >&2
        return 1
    fi
    case "$REPO_ROOT/" in
        "$output_dir/"*)
            echo "Refusing output directory that contains the repository: $output_dir" >&2
            return 1
            ;;
    esac
    case "$output_dir/" in
        "$REPO_ROOT/"*)
            # Keep the historical default, but do not let an alternate spelling or
            # symlink inherit its exception to the repository boundary.
            if [[ "$REQUESTED_OUTPUT_DIR" != "$DEFAULT_OUTPUT_DIR" || "$output_dir" != "$DEFAULT_OUTPUT_DIR" ]]; then
                echo "Refusing output inside the repository outside the owned build directory: $output_dir" >&2
                return 1
            fi
            ;;
    esac
}

assert_owned_output_directory() {
    local output_dir="$1"
    local sentinel="$output_dir/.magenta-binary-output"

    if [[ -L "$sentinel" || ! -f "$sentinel" ]] || ! cmp -s "$sentinel" <(printf '%s\n' 'magenta-binary-output-v1'); then
        echo "Refusing to replace a directory not owned by this script: $output_dir" >&2
        return 1
    fi
}

OUTPUT_DIR="$(canonicalize_output_path "$REQUESTED_OUTPUT_DIR")"
OUTPUT_SENTINEL="$OUTPUT_DIR/.magenta-binary-output"

assert_safe_output_path "$OUTPUT_DIR"

if [[ -L "$OUTPUT_DIR" || ( -e "$OUTPUT_DIR" && ! -d "$OUTPUT_DIR" ) ]]; then
    echo "Output path exists and is not a directory: $OUTPUT_DIR" >&2
    exit 1
fi
if [[ -d "$OUTPUT_DIR" ]]; then
    if [[ "$FORCE" != "true" ]]; then
        echo "Output directory already exists; use --force only after inspection: $OUTPUT_DIR" >&2
        exit 1
    fi
    assert_owned_output_directory "$OUTPUT_DIR"
fi

BINARY_NAME=$(node -p "const pkg=require('./pi/coding-agent/package.json'); pkg.piConfig?.binaryName || Object.keys(pkg.bin || {})[0] || 'pi'")

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    CLIPBOARD_VERSION=$(node -p "require('./pi/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")
    # npm ci only installs optional deps for the current platform
    # We need the base clipboard package and all platform bindings for bun cross-compilation
    # Use --force to bypass platform checks (os/cpu restrictions in package.json)
    # Install all in one command to avoid npm removing packages from previous installs
    npm install --include=optional --no-save --package-lock=false --force --ignore-scripts \
        @mariozechner/clipboard@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-arm64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-x64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-x64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-arm64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-x64-msvc@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-arm64-msvc@"$CLIPBOARD_VERSION"
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    echo "==> Cleaning and building all packages offline..."
    npm run clean
    npm run build:offline
else
    echo "==> Reusing prebuilt package output (--skip-build)"
fi

echo "==> Verifying branded build version..."
node scripts/verify-brand-version.mjs --require-dist

echo "==> Building binaries..."
cd pi/coding-agent

# The build can take a long time. Resolve and validate again immediately before
# deletion so a changed parent symlink cannot redirect rm into the repository.
CURRENT_OUTPUT_DIR="$(canonicalize_output_path "$OUTPUT_DIR")"
if [[ "$CURRENT_OUTPUT_DIR" != "$OUTPUT_DIR" ]]; then
    echo "Refusing output path that changed during the build: $OUTPUT_DIR -> $CURRENT_OUTPUT_DIR" >&2
    exit 1
fi
assert_safe_output_path "$CURRENT_OUTPUT_DIR"
if [[ -L "$OUTPUT_DIR" || ( -e "$OUTPUT_DIR" && ! -d "$OUTPUT_DIR" ) ]]; then
    echo "Output path exists and is not a directory: $OUTPUT_DIR" >&2
    exit 1
fi
if [[ -d "$OUTPUT_DIR" ]]; then
    if [[ "$FORCE" != "true" ]]; then
        echo "Output directory already exists; use --force only after inspection: $OUTPUT_DIR" >&2
        exit 1
    fi
    assert_owned_output_directory "$OUTPUT_DIR"
    rm -rf -- "$OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}
printf '%s\n' 'magenta-binary-output-v1' > "$OUTPUT_SENTINEL"

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    if [[ "$platform" == windows-* ]]; then
		node ../../scripts/run-bun-compile.mjs build --compile --target="bun-$platform" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/$BINARY_NAME.exe"
	else
		node ../../scripts/run-bun-compile.mjs build --compile --target="bun-$platform" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/$BINARY_NAME"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    case "$platform" in
        darwin-arm64)
            clipboard_native_package="clipboard-darwin-arm64"
            ;;
        darwin-x64)
            clipboard_native_package="clipboard-darwin-x64"
            ;;
        linux-x64)
            clipboard_native_package="clipboard-linux-x64-gnu"
            ;;
        linux-arm64)
            clipboard_native_package="clipboard-linux-arm64-gnu"
            ;;
        windows-x64)
            clipboard_native_package="clipboard-win32-x64-msvc"
            ;;
        windows-arm64)
            clipboard_native_package="clipboard-win32-arm64-msvc"
            ;;
    esac
    mkdir -p "$OUTPUT_DIR/$platform/node_modules/@mariozechner"
    cp -r ../../node_modules/@mariozechner/clipboard "$OUTPUT_DIR/$platform/node_modules/@mariozechner/"
	cp -r "../../node_modules/@mariozechner/$clipboard_native_package" "$OUTPUT_DIR/$platform/node_modules/@mariozechner/"

    # Copy terminal input native helpers next to compiled binaries.
    if [[ "$platform" == darwin-* ]]; then
        mkdir -p "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform"
		cp "../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node" "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform/"
    fi
    if [[ "$platform" == windows-* ]]; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        mkdir -p "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir"
        cp ../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir/"
    fi
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating $BINARY_NAME-$platform.zip..."
        (cd "$platform" && zip -r ../"$BINARY_NAME-$platform.zip" .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating $BINARY_NAME-$platform.tar.gz..."
        mv "$platform" "$BINARY_NAME" && tar -czf "$BINARY_NAME-$platform.tar.gz" "$BINARY_NAME" && mv "$BINARY_NAME" "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../"$BINARY_NAME-$platform.zip")
    else
        tar -xzf "$BINARY_NAME-$platform.tar.gz" && mv "$BINARY_NAME" "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh ./*.tar.gz ./*.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/$BINARY_NAME.exe"
    else
        echo "  $OUTPUT_DIR/$platform/$BINARY_NAME"
    fi
done
