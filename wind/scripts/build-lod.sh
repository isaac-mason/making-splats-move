#!/usr/bin/env bash
#
# Build a level-of-detail (LOD) splat file using Spark's `build-lod` tool.
#
# `build-lod` is a Rust binary that ships only in the Spark *source* repo (not
# the published @sparkjsdev/spark npm package), so this script shallow-clones
# Spark at the version we depend on into a gitignored vendor/ dir and runs it
# via cargo.
#
# Usage:
#   scripts/build-lod.sh [input-file] [-- <extra build-lod args>]
#
# Source splats live in assets/ (not served); the built LOD file is moved into
# public/ so Vite serves it. Defaults to "assets/anime-city.spz" and RAD output
# (Spark's native LOD format), producing "public/anime-city-lod.rad".
#
# NOTE: this example ships only the built .rad — the 66MB source .spz is not in the
# repo (see the README). Drop it in assets/ before running this.
#
# Examples:
#   scripts/build-lod.sh
#   scripts/build-lod.sh assets/anime-city.spz
#   scripts/build-lod.sh assets/foo.spz -- --quick --max-sh=2
set -euo pipefail

# Repo root = parent of this script's dir.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pin Spark to the version we depend on so the LOD format matches the runtime.
SPARK_VERSION="${SPARK_VERSION:-v2.1.0}"
VENDOR_DIR="vendor/spark"
MANIFEST="$VENDOR_DIR/rust/build-lod/Cargo.toml"

INPUT="${1:-assets/anime-city.spz}"
OUTPUT_DIR="public"
# Drop the consumed positional arg; the rest are passed through to build-lod.
shift || true
# Allow an optional "--" separator before passthrough args.
if [[ "${1:-}" == "--" ]]; then shift; fi
EXTRA_ARGS=("$@")
# Default to RAD output (Spark's native LOD format) if no output flag given.
if [[ ${#EXTRA_ARGS[@]} -eq 0 ]]; then
  EXTRA_ARGS=(--rad)
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo (Rust toolchain) is required. Install via https://rustup.rs/" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "error: input file not found: $INPUT" >&2
  exit 1
fi

# Clone Spark at the pinned tag if we don't already have it.
if [[ ! -f "$MANIFEST" ]]; then
  echo "==> Cloning sparkjsdev/spark@$SPARK_VERSION into $VENDOR_DIR"
  mkdir -p vendor
  rm -rf "$VENDOR_DIR"
  git clone --depth 1 --branch "$SPARK_VERSION" \
    https://github.com/sparkjsdev/spark.git "$VENDOR_DIR"
else
  echo "==> Using existing $VENDOR_DIR"
fi

echo "==> Building LOD for: $INPUT"
echo "==> build-lod args: ${EXTRA_ARGS[*]}"
cargo run --release --manifest-path "$MANIFEST" -- "${EXTRA_ARGS[@]}" "$INPUT"

# build-lod writes "<dir>/<name>-lod.<ext>" next to the input. Move any LOD
# outputs into public/ so Vite serves them.
input_dir="$(dirname "$INPUT")"
stem="$(basename "${INPUT%.*}")"
mkdir -p "$OUTPUT_DIR"
shopt -s nullglob
moved=0
for f in "$input_dir/$stem"-lod.*; do
  mv -f "$f" "$OUTPUT_DIR/"
  echo "==> Moved $(basename "$f") -> $OUTPUT_DIR/"
  moved=1
done
shopt -u nullglob

if [[ "$moved" -eq 0 ]]; then
  echo "warning: no '$stem-lod.*' output found to move into $OUTPUT_DIR/" >&2
fi

echo "==> Done. LOD file(s) in $OUTPUT_DIR/."
