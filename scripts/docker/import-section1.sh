#!/usr/bin/env sh
# One-shot 'import' service: loads the Section 1 SQLite file into Postgres. Its directory is mounted
# read-only at /seed; only the main file is copied (never opened in place, -wal/-shm never touched) and
# the copy is imported, so a WAL with frames would be lost: that is refused. Idempotent (the importer
# skips companies and rows already present); a missing file is skipped.
set -eu

src="/seed/${SECTION1_DB_FILE:-leadmaker.db}"
if [ ! -f "$src" ]; then
    echo "import: no Section 1 database at $src; skipping"
    exit 0
fi
# A WAL is a 32-byte header plus frames; frames may hold commits that are not in the main file yet.
if [ -f "$src-wal" ] && [ "$(stat -c %s "$src-wal")" -gt 32 ]; then
    name=$(basename "$src")
    echo "import: $name-wal has frames that may not be in $name yet. Stop whatever has it open, then on the host:" >&2
    echo "import:   sqlite3 data/$name 'PRAGMA wal_checkpoint(TRUNCATE)'" >&2
    exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$src" "$tmp/section1.db"
leadmaker import-sqlite "$tmp/section1.db"
