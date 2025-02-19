#!/bin/bash

set -euxo pipefail

# Per https://stackoverflow.com/a/16349776; go to repo root
cd "${0%/*}/../../.."

zaplib/scripts/ci/common.sh

export RUSTFLAGS="-D warnings"

# Run a check (not a build) for the various target triples.
cargo check --release --workspace --target x86_64-unknown-linux-gnu --exclude tutorial_js_rust_bridge
cargo check --release --workspace --target wasm32-unknown-unknown
# `--no-default-features` is to disable TLS since it breaks cross-compilation
# `--exclude zaplib_cef(_sys)` and `test_suite` since we currently don't support cross-compiling with CEF.
cargo check --release --workspace --target x86_64-apple-darwin --no-default-features --exclude zaplib_cef --exclude zaplib_cef_sys --exclude test_suite --exclude tutorial_js_rust_bridge
cargo check --release --workspace --target x86_64-pc-windows-msvc --no-default-features --exclude zaplib_cef --exclude zaplib_cef_sys --exclude test_suite --exclude tutorial_js_rust_bridge
cargo check --release --workspace --target x86_64-pc-windows-gnu --no-default-features --exclude zaplib_cef --exclude zaplib_cef_sys --exclude test_suite --exclude tutorial_js_rust_bridge
