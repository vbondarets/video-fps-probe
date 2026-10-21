#!/usr/bin/env bash
# Extracts the ffprobe ground truth for every fixture under <rootDir>/files and <rootDir>/large.
# Usage: extract-reference.sh [rootDir]
#   rootDir   fixtures root, default <repo>/fixtures. Writes <rootDir>/ref/<file name>.ref.json.
# Pinned to ffprobe 8.1.1; set ALLOW_FFPROBE_MISMATCH=1 to run with another build anyway.
# Refs of optional files that are not present (large/) are left untouched.
# Files above 4 GiB (the sparse fixture) are probed without -count_frames.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$HERE/../../fixtures}"
ROOT="$(cd "$ROOT" && pwd)"
EXPECTED_FFPROBE="8.1.1"

FFVER="$(ffprobe -version | head -n 1)"
case "$FFVER" in
  "ffprobe version $EXPECTED_FFPROBE"*) ;;
  *)
    echo "found: $FFVER" >&2
    if [[ "${ALLOW_FFPROBE_MISMATCH:-0}" != 1 ]]; then
      echo "ERROR: references are pinned to ffprobe $EXPECTED_FFPROBE (set ALLOW_FFPROBE_MISMATCH=1 to override)" >&2
      exit 1
    fi
    ;;
esac

node "$HERE/tools/ref-extract.mjs" "$ROOT/ref" "$ROOT/files" "$ROOT/large"

if [[ -f "$ROOT/manifest.tsv" ]]; then
  for r in "$ROOT"/ref/*.ref.json; do
    n="$(basename "$r" .ref.json)"
    awk -F'\t' -v n="$n" '$1 == n { found = 1 } END { exit !found }' "$ROOT/manifest.tsv" || echo "WARN: stale reference without manifest row: ref/$n.ref.json" >&2
  done
fi
