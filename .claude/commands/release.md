---
description: Fully automated NPM release with version detection
argument-hint: [patch|minor|major] (optional - auto-detected if omitted)
allowed-tools:
  - Bash(npm test:*)
  - Bash(npm view:*)
  - Bash(git status:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git tag:*)
  - Bash(git push:*)
  - Bash(git branch:*)
  - Bash(git log:*)
  - Bash(git describe:*)
  - Bash(git diff:*)
  - Bash(gh run list:*)
  - Bash(gh run view:*)
  - Bash(gh run watch:*)
  - Bash(node:*)
  - Read
  - Edit
  - Write
---

# Automated NPM Release for @gpriday/ask-google-mcp

Publishing is handled by the `.github/workflows/publish.yml` workflow, which runs on every `v*` tag push using NPM trusted publishing (OIDC). This command prepares and pushes the tag; CI does the actual `npm publish`.

## Current State
- Git status: !`git status`
- Current branch: !`git branch --show-current`
- Latest tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Current version: !`node -p "require('./package.json').version"`
- Changes since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD")..HEAD --oneline 2>/dev/null || echo "No previous tags"`

## Automated Release Process

This command will automatically:
1. Analyze commit history to determine version bump type
2. Run all tests locally (STOP if any fail)
3. Update `package.json` version
4. Commit the bump
5. Create an annotated git tag
6. Push `main` and the tag to origin
7. Watch the publish workflow and report when it publishes

### Step 1: Analyze Changes & Determine Version

Version bump override: $ARGUMENTS

**If $ARGUMENTS is empty, auto-detect version bump:**

Read all commits since the last git tag. Analyze commit messages following Conventional Commits:
- **MAJOR** (breaking): Look for "BREAKING CHANGE:", "!" after type (e.g., "feat!:"), or "major:" prefix
- **MINOR** (feature): Look for "feat:", "feature:", new functionality
- **PATCH** (fix): Look for "fix:", "bugfix:", "chore:", "docs:", "refactor:", "test:", "style:", improvements

Rules:
- If any BREAKING CHANGE found → MAJOR bump
- If any feat/feature found (no breaking) → MINOR bump
- Otherwise → PATCH bump
- If no commits since last tag → Ask user if they want to proceed with PATCH

Calculate new version based on current `package.json` version and bump type.

### Step 2: Pre-Release Validation

1. **Check for uncommitted changes**
   - Run `git status --porcelain`
   - If ANY uncommitted changes exist, STOP and tell the user: "Please commit or stash all changes before running release. The release process will only commit the version bump in package.json."

2. **Verify prerequisites**
   - Must be on `main` branch (STOP if not)
   - Run `npm test` — all tests must pass (STOP if any fail)

### Step 3: Update package.json

- Read `package.json`
- Update the `version` field to the new calculated version
- Write back to file

### Step 4: Commit & Tag

```bash
git add package.json
git commit -m "chore: prepare for v[NEW_VERSION] release"
git tag -a v[NEW_VERSION] -m "Release version [NEW_VERSION]

[First 3-5 key changes from commit history since last tag]"
```

### Step 5: Push to Origin

```bash
git push origin main
git push origin v[NEW_VERSION]
```

The tag push triggers `.github/workflows/publish.yml`, which:
- Asserts the tag version matches `package.json` version (fails fast on mismatch).
- Runs `npm ci`, `npm test`, and `npm publish --access public` using the workflow's OIDC identity.
- Routes pre-release tags (e.g. `v1.0.0-beta.1`) to the `next` dist-tag instead of `latest`.

No NPM login, OTP, or `NODE_AUTH_TOKEN` is required from the local machine.

### Step 6: Watch the Publish Workflow

```bash
gh run list --workflow=publish.yml --limit 1        # get the run ID
gh run watch <RUN_ID> --exit-status                 # stream until complete
```

If the workflow fails, fetch logs with `gh run view <RUN_ID> --log-failed` and report the failure to the user. Do not retry silently — diagnose first.

### Step 7: Verify & Report

```bash
npm view @gpriday/ask-google-mcp version
```

Confirm the registry version matches the newly pushed tag.

**Report to user:**
- Version published: [NEW_VERSION]
- NPM: https://www.npmjs.com/package/@gpriday/ask-google-mcp
- Install: `npm install -g @gpriday/ask-google-mcp`
- Git tagged and pushed
- **Key changes in this release:**
  [List 5-7 main changes from commit history since last tag]

## Error Handling

**If tests fail locally:**
- Report which tests failed
- STOP release process
- Tell user to fix tests first

**If git has uncommitted changes:**
- List all uncommitted files
- Tell user to commit or stash before running release
- STOP release process

**If `git push` fails:**
- Check remote access and that the branch is up to date with origin
- Package has NOT been published yet (publish only runs after the tag is on origin)
- STOP and surface the push error

**If the publish workflow fails:**
- Fetch failed step logs with `gh run view <RUN_ID> --log-failed`
- Common causes: version already exists on NPM, workflow file regression, trusted-publishing config drift
- The tag is already on origin. If the failure is in the workflow itself (not a retryable infra blip), options are:
  - Fix the workflow, then move the tag to the new HEAD (`git tag -f`, `git push --force-with-lease origin v[NEW_VERSION]`) — requires explicit user confirmation because it rewrites a pushed tag
  - Or bump to the next patch and ship a clean tag
- Retry (`gh run rerun <RUN_ID>`) only if the failure looks transient (network, registry 5xx)

## Package Details

- Package: `@gpriday/ask-google-mcp`
- Binary: `ask-google-mcp`
- License: MIT
- Minimum Node: `>=20.0.0` (from `package.json` engines)
- Scope: `@gpriday` (requires `--access public`, handled by the workflow)
