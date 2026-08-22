---
name: release-tag
description: Cut a new LibreChat ytret release (v0.8.7+ytretN -> v0.8.7+ytretN+1) by bumping the version across all package files, then committing, and lightweight-tagging. Use when the user asks to release or tag a new version, e.g. "Release v0.8.7+ytret5" or "release as in <commit>".
---

# Release Tag (LibreChat ytret releases)

Cut a new `v0.8.7+ytretN` release: bump versions, commit, and create a lightweight tag (do not push). Follows the established pattern (reference release commit: `9fd52c3de` for v0.8.7+ytret4).

## Procedure

Run from the repo root.

### 1. Determine versions

Read `"version"` in root `package.json` — the current release, e.g. `v0.8.7+ytret5`. The next version increments the numeric suffix (`v0.8.7+ytret6`).

- If the user names a specific version, use it; sanity-check that it is exactly one ahead of the current one. If the current version does not match the `v0.8.7+ytretN` pattern, stop and ask.

### 2. Bump versions

```bash
.agents/skills/release-tag/scripts/bump-version.sh <current> <next>
```

This replaces every `"version": "<current>"` occurrence with `<next>` in `package.json`, `api/package.json`, `client/package.json`, and `package-lock.json`. Note `package-lock.json` carries the version 4 times: root version, root `packages.""` entry, `packages."api"` entry, and `packages."client"` entry.

Alternatively, bump by hand with edits, locating occurrences via `grep -rn '"version": "<current>"' --include=package.json .` plus the 4 spots in `package-lock.json`.

### 3. Verify

```bash
git diff --stat     # expect exactly: api/package.json, client/package.json, package-lock.json, package.json (7 insertions, 7 deletions)
grep -n '"version": "<next>"' package.json api/package.json client/package.json package-lock.json
```

The diff must contain only version bumps — no other changes. If the working tree has unrelated changes, stage only the four version files (never `git commit -am`).

### 4. Commit (message is exactly the new version)

```bash
git add package.json api/package.json client/package.json package-lock.json
git commit -m "<next>"
```

### 5. Tag (lightweight, no message, annotated tags are not used)

```bash
git tag <next>
```

## Reference

- Prior release commits: `0b1aed250` (ytret1), `60d9e5886` (ytret2), `db7a1d0d2` (ytret3), `9fd52c3de` (ytret4), `619ae0c05` (ytret5)
- Each is a 4-file diff (7+/7-) with only version bumps; commit message = tag name = new version
