# Contributing to TrackTube

Thanks for looking. This is a small, deliberately dependency free project, so
the contribution loop is short.

## Getting it running

There is nothing to build. Clone the repository, open `chrome://extensions`,
turn on developer mode, and choose **Load unpacked** on the folder. That folder,
as it is, is the extension.

There is no `package.json`, no bundler and no TypeScript, and Node is not
required. Every module is a plain ES module loaded by the browser, so every
import path is relative and real — a wrong path only shows up at runtime.

## Running the tests

Serve the folder over HTTP and open the suites in a real browser:

```bash
python tools/serve-ranges.py 8731
```

That server rather than a plain static one: `test/preview-playback.html` asks
for its byte ranges in the query string, and a static server answers every
segment with the whole file, so the preview never plays and it looks like a
regression that is not one.

| Page | What it checks |
|---|---|
| `test/index.html` | the regression suite, 630+ assertions, no network |
| `test/modules.html` | that all 37 modules compile, catching broken paths and vanished exports |
| `test/coverage.html` | the collection paths: pagination, caps, truncated feeds, rate limits |

All three must be green before a change is considered done. The first does not
notice a module that stopped loading; the second does not notice a behaviour
regression; neither exercises a sweep.

If you have Node and Playwright, `node tools/test.mjs` drives the same benches
headlessly, on isolated contexts and a fresh origin. They are development tools
only, never a runtime dependency; see the README for the environment variables
when they come from outside the project.

Other pages under `test/` are visual benches — the feed grid, the triage
screen, the onboarding walkthrough, the popup, the analysis page — each with
fake data and a fake `chrome`. Four of them also answer a `?shot=` parameter,
which puts them in the one state `python tools/shoot.py` photographs for the
README; they are unchanged without it.

Three traps that have cost time before:

- **`?cb=N` does not bust the ES module cache.** The parameter is honoured for
  the page, not for the modules it imports. To be sure you are reading the code
  you just changed, **serve on a different port**.
- **One suite per origin.** The benches share an IndexedDB with every other page
  served from the same port. Running `index.html` and then `coverage.html` on
  one port leaves the second reading the first's rows, and it fails on
  assertions that have nothing wrong with them. A port per page, not merely a
  fresh port per run.
- On some machines `localhost` is blocked by policy; use `127.0.0.1`.

## House rules

The full picture is in [CLAUDE.md](CLAUDE.md), which is written for whoever
picks the code up without having written it. The short version:

- **No Shorts, anywhere.** Never in the feed, the durations, the averages, the
  upload lists behind the streaks, or the counted viewings. Channel upload
  playlists are always read with the `UULF` prefix, never `UU`.
- **Only per-channel sources create a video.** RSS and channel Videos/Live grids
  may create rows; the native subscriptions feed only enriches or measures.
- **Coverage is scoped.** A native comparison is not an exhaustive upload
  certificate. Failed pagination, caps and deferred metadata must be visible.
- **An action reports itself visually**, not with a status sentence. Only an
  error message is legitimate, and a progress bar must be honest.
- **Interface text is short.** Long explanations belong in `docs/` or in the
  popup's help panel.
- **A figure with a limited scope says so on screen** — "since installation",
  "over 7 days".
- **Determinism over saving requests.** No heuristic that favours popular or
  frequent channels.
- **Comments explain the why, with measured numbers.** Code already says what it
  does. Comments and identifiers are in English.
- Both locale catalogues, `src/lib/locales/fr.js` and `en.js`, are kept at
  strict parity, and a test enforces it.

## Before opening a pull request

1. `test/index.html`, `test/modules.html` and `test/coverage.html` green,
   **each on its own fresh port**.
2. `fr.js` / `en.js` parity if a key moved.
3. Version bumped in `manifest.json`.
4. `README.md` re-read if the described behaviour changed.
5. Say explicitly what the change requires of the user: an F5, or an extension
   reload. The manifest, `loader.js`, `main-world.js` and everything under
   `src/background/` are frozen at extension load; everything below the dynamic
   import of `main.js` is re-read on every page load.
