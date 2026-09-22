# Releasing homebridge-whisker-ting

Ting plugin updates must land in **both** places:

| Target | Why |
|--------|-----|
| **GitHub** (`snaket7ds/homebridge-whisker-ting`) | Source, tags, release notes |
| **npm** (`homebridge-whisker-ting`) | What Homebridge / UI installs and updates |

Pushing only to GitHub is **not** enough — Homebridge users get the package from **npm**.

## How dual publish works

Tag push triggers `.github/workflows/publish.yml`, which:

1. Lints and tests  
2. Checks `v*` tag matches `package.json` version  
3. Checks `PLUGIN_VERSION` (from `package.json` via `src/settings.js`)  
4. Creates/updates the **GitHub Release** from `CHANGELOG.md`  
5. Runs **`npm publish --access public`** (OIDC / npm trusted publishing)

## Release checklist

From `nas-openclaw/APPs/homebridge-whisker-ting` on a clean `main`:

```bash
# 1) Bump version in package.json (e.g. 1.0.17 -> 1.0.18)
# 2) Add matching section to CHANGELOG.md:
#      ## 1.0.18
#      - ...
# 3) PLUGIN_VERSION is read from package.json — no separate bump needed

npm run lint
npm test
npm pack --dry-run

git add -A
git commit -m "1.0.18 - short description"
git push origin main

# 4) Tag must be v + package.json version
git tag v1.0.18
git push origin v1.0.18
```

Then verify:

```bash
gh run list --limit 3
gh release view v1.0.18
npm view homebridge-whisker-ting version
```

Both must show the new version.

## Current published version

- GitHub latest release: check `gh release list`
- npm latest: `npm view homebridge-whisker-ting version`

As of last sync: **1.1.0** on both (released 2026-09-21, tag `v1.1.0`, commit `99f9404`).

## Notes

- Do **not** run `npm publish` by hand unless CI is broken; prefer the tag workflow.  
- Homebridge UI may cache npm metadata briefly after publish.  
- Local install path on the Homebridge box: UI plugin list shows `homebridge-whisker-ting` from npm (see live HB plugins).
