#!/usr/bin/env sh
# Runs dbmate (the compose image) against a database on the compose postgres.
# Usage: scripts/dbmate.sh [--db NAME] <dbmate args>
#   scripts/dbmate.sh --wait up                 migrate 'leadmaker'
#   scripts/dbmate.sh --db leadmaker_test up    migrate a test database (created if missing)
#   scripts/dbmate.sh new add_some_table        new file in db/migrations
set -eu
cd "$(dirname "$0")/.."

db=leadmaker
if [ "${1:-}" = "--db" ]; then
    db="$2"
    shift 2
fi
case "$db" in
    '' | *[!a-z0-9_]*) echo "invalid database name: $db" >&2; exit 2 ;;
esac

url="postgres://${POSTGRES_USER:-leadmaker}:${POSTGRES_PASSWORD:-leadmaker}@postgres:5432/$db?sslmode=disable"
exec docker compose run --rm --no-deps -T -e DATABASE_URL="$url" dbmate "$@"
