---
description: Prepare and publish a new release version to NPM
---

# Release Process for ask-google-mcp

You are tasked with preparing and publishing a new release of the `@gpriday/ask-google-mcp` package to NPM. Follow these steps carefully:

## Pre-Release Checklist

1. **Verify Git Status**
   - Check current branch (should be `main`)
   - Ensure working directory is clean or only has expected changes
   - Verify all tests pass: `npm test`

2. **Determine Version Type**
   - Ask the user what type of release this is:
     - **patch** (0.1.0 → 0.1.1): Bug fixes, minor updates
     - **minor** (0.1.0 → 0.2.0): New features, backwards compatible
     - **major** (0.1.0 → 1.0.0): Breaking changes
   - If the user doesn't specify, infer from recent commits

3. **Update Version Number**
   - Update `version` in `package.json`
   - Follow semantic versioning (semver)

4. **Update CHANGELOG.md**
   - Move "Unreleased" section to new version with today's date
   - Format: `## [X.Y.Z] - YYYY-MM-DD`
   - Categorize changes under:
     - **Added** - New features
     - **Changed** - Changes to existing functionality
     - **Deprecated** - Soon-to-be removed features
     - **Removed** - Removed features
     - **Fixed** - Bug fixes
     - **Security** - Security improvements
   - Update version links at bottom of CHANGELOG

5. **Review Package Contents**
   - Run `npm pack --dry-run` to preview what will be published
   - Verify only intended files are included:
     - `src/`
     - `scripts/`
     - `README.md`
     - `LICENSE`
     - `CHANGELOG.md`
     - `.env.example`

6. **Run All Tests**
   - Unit tests: `npm test`
   - Verify all tests pass (currently 37 tests)
   - If tests fail, STOP and report issues to user

7. **Verify Package Metadata**
   - Package name: `@gpriday/ask-google-mcp`
   - Author: `Greg Priday <greg@siteorigin.com>`
   - License: `MIT`
   - Repository URLs are correct
   - Keywords are appropriate

## Release Steps

8. **Commit Release Changes**
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: prepare for vX.Y.Z release"
   ```

9. **Create Git Tag**
   ```bash
   git tag -a vX.Y.Z -m "Release version X.Y.Z

   [Brief summary of main changes from CHANGELOG]"
   ```

10. **Publish to NPM**
    ```bash
    npm publish --access public
    ```

    **IMPORTANT:**
    - The package is scoped (`@gpriday/`), so `--access public` is required
    - Verify you're logged in as `gpriday`: `npm whoami`
    - If not logged in: `npm login`

11. **Push to Git**
    ```bash
    git push origin main
    git push origin vX.Y.Z
    ```

12. **Verify Publication**
    - Check NPM: `npm view @gpriday/ask-google-mcp`
    - Verify version number is correct
    - Test installation: `npm install -g @gpriday/ask-google-mcp@X.Y.Z`

## Post-Release

13. **Create GitHub Release** (if GitHub repo exists)
    - Go to: https://github.com/gpriday/ask-google-mcp/releases/new
    - Tag version: `vX.Y.Z`
    - Title: `Release X.Y.Z`
    - Description: Copy from CHANGELOG.md
    - Mark as "latest release"

14. **Prepare for Next Development**
    - Add "Unreleased" section to CHANGELOG.md:
      ```markdown
      ## [Unreleased]

      ### Added

      ### Changed

      ### Fixed
      ```

15. **Report to User**
    - Summarize what was done
    - Provide NPM package URL
    - Provide installation command
    - List key changes from CHANGELOG

## Error Handling

If any step fails:
- **Tests fail**: Report failures, do not proceed with release
- **Git is dirty**: Ask user if they want to commit changes first
- **NPM publish fails**: Check if version already exists, verify login
- **Git push fails**: Check remote access, verify branch is up to date

## Important Notes

- **Never publish without running tests**
- **Never skip version bump in package.json**
- **Always update CHANGELOG.md**
- **Always create Git tag**
- **The package name is `@gpriday/ask-google-mcp` (scoped)**
- **The binary command is `ask-google-mcp`**
- **Minimum Node.js version: >=18.0.0**

## Success Criteria

A successful release includes:
1. ✅ All tests passing
2. ✅ Version bumped in package.json
3. ✅ CHANGELOG updated with release notes
4. ✅ Git commit created
5. ✅ Git tag created
6. ✅ Published to NPM
7. ✅ Pushed to Git remote
8. ✅ Verified on NPM registry

After completing all steps, provide the user with:
- NPM package URL: `https://www.npmjs.com/package/@gpriday/ask-google-mcp`
- Installation command: `npm install -g @gpriday/ask-google-mcp`
- Version published
- Summary of changes from CHANGELOG
