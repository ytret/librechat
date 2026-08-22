#!/usr/bin/env bash
# Bump the LibreChat ytret release version across all package files.
# Usage (from repo root): bump-version.sh <current-version> <next-version>
#   e.g. bump-version.sh v0.8.7+ytret5 v0.8.7+ytret6
set -euo pipefail

old="$1"
new="$2"

files=(package.json api/package.json client/package.json package-lock.json)

for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "error: $f not found (run from the repo root)" >&2
    exit 1
  fi
done

total=0
for f in "${files[@]}"; do
  before=$(grep -c "\"$old\"" "$f" || true)
  perl -pi -e 'BEGIN{($old,$new)=splice @ARGV,0,2} s/"\Q$old\E"/"$new"/g' -- "$old" "$new" "$f"
  after=$(grep -c "\"$new\"" "$f" || true)
  echo "$f: $before occurrence(s) replaced ($after line(s) now match $new)"
  total=$((total + before))
done

if [ "$total" -eq 0 ]; then
  echo "warning: no occurrences of $old found — nothing was bumped" >&2
  exit 1
fi

echo "Done: $total occurrence(s) bumped to $new"
