#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rid="${1:?group 1..10}"
shift
exec python3 "$here/run.py" group --root "${LIVE_ROOT:?set initialized LIVE_ROOT}" --group "$rid" "$@"
