#!/usr/bin/env python3
"""Generate the long-task fixtures. Same turn map as the 1.0.8 fill."""
from pathlib import Path
import tempfile
from contract import FILL, NOTICE, HIDDEN, sha

def build_log(turn):
    warns = 3 + (turn % 9)
    lines = []
    for i in range(520):
        lines.append(f"INFO 2026-11-04 svc=ledger seq={turn:02d}-{i:04d} heartbeat ok")
    for i in range(warns):
        lines[180 + i * 7] = f"WARN ledger drift turn={turn} n={i}"
    if turn in NOTICE:
        lines[260] = NOTICE[turn]
    if turn in HIDDEN:
        lines[300] = HIDDEN[turn]
    return "\n".join(lines) + "\n", warns

def write_workspace(root: Path):
    root.mkdir(parents=True, exist_ok=False)
    (root / "trash").mkdir(exist_ok=True)
    (root / "vendor").mkdir(exist_ok=True)
    (root / "conf").mkdir(exist_ok=True)
    (root / "docs").mkdir(exist_ok=True)
    (root / "tests").mkdir(exist_ok=True)
    (root / "conf" / "settings.toml").write_text("port = 1111\n# old file, do not edit\n")
    (root / "conf" / "settings.local.toml").write_text("port = 8642\ncache = \"memory\"\n")
    (root / "tests" / "test_ledger.py").write_text("def test_total():\n    assert False\n")
    (root / "check.sh").write_text(
        "#!/bin/sh\necho 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)' >&2\nexit 3\n"
    )
    (root / "check.sh").chmod(0o755)
    # Turn 13's frozen update says batch_size=250. The old generator's HIDDEN[13]
    # was unreachable: add only this missing log, preserving all original bytes.
    for turn in sorted(set(FILL) | set(HIDDEN)):
        text, warns = build_log(turn)
        (root / f"part{turn}.log").write_text(text)
    return {str(p.relative_to(root)): sha(p.read_bytes())
            for p in root.rglob("*") if p.is_file()}

if __name__ == "__main__":
    import sys
    write_workspace(Path(sys.argv[1]))


def expected_inventory():
    with tempfile.TemporaryDirectory(prefix="live-fill-fixtures-") as tmp:
        return write_workspace(Path(tmp) / "work")
