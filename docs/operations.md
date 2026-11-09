# tencent-panorama-workbench · Operations Guide

## Run a Viewer Locally

Serve the repository over HTTP so browser `fetch` and script loading behave like GitHub Pages.

```powershell
python -m http.server 8000
```

Open `http://127.0.0.1:8000/` for the root route workbench or `http://127.0.0.1:8000/city-viewer/` for the national viewer.

## Work on the City Viewer

The viewer loads metadata scripts on demand. Keep these files together inside `city-viewer/`:

- `index.html`
- `data_meta.js`
- `data_districts.js`
- `grid_all.js`
- `data_<adcode>.js`
- `vendor/` when local browser dependencies are used

After editing `city-viewer/index.html`, run a JavaScript syntax check on the inline script before publishing.

## Scan Output

The scanner should write runtime state and downloaded media outside the published directory whenever possible. A typical local layout is:

```text
local-scan/
  data/       generated viewer metadata
  work/       resumable state
  logs/       run logs
  media/      thumbnails and panorama images
```

Only the selected, validated metadata artifacts should be copied into `city-viewer/`.

## Git Synchronization

Use the remote-tracking branch as the source of truth before publishing local changes:

```powershell
git fetch origin
git status --short --branch
git log --oneline --decorate --graph --all -20
```

Commit only intentional files. Check the staged list before committing:

```powershell
git diff --cached --name-only
git diff --cached --check
```

Push with a normal fast-forward update. Do not use force push for this repository.

## Authentication

Git operations should use a configured credential helper or an environment-managed token. Do not store a token in this repository, shell history, README files, or scanner output. If Git opens an account selector, choose the credential entry that has access to `cn171g11/tencent-panorama-workbench`; a browser account alone is not proof that Git has a usable token.

## Release Boundary

The Android project is outside this repository. Updating the viewer repository does not build or publish an APK. APK work must be requested separately and should consume a reviewed viewer snapshot.
