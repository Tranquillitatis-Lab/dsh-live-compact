#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$here/run.py" all --root "${LIVE_ROOT:?set new LIVE_ROOT}" --spec "${LIVE_SPEC:?set LIVE_SPEC}" "$@"
