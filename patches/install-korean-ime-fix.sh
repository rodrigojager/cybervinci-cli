#!/usr/bin/env bash
set -euo pipefail

echo "The legacy Korean IME hot-patch installer is disabled in CYBERVINCI." >&2
echo "It previously cloned and reset an unrelated fork, which is not an acceptable distribution path." >&2
echo "Build this reviewed source tree directly, then install it with:" >&2
echo "  ./install --binary /path/to/cybervinci" >&2
exit 2
