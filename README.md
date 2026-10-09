# TrackTube

**English** · [Français](README.fr.md)

**Your YouTube subscriptions, in order, without Shorts.**

TrackTube replaces YouTube's Subscriptions page with the full chronological list
of what the channels you follow have published. No ranking, no recommendations,
no Shorts carousels in the middle of the list. Everything stays in your browser.

![The feed, inside YouTube](screenshots/feed.jpg)

---

## Why

YouTube's Subscriptions page stopped being a list. It opens on a "For you"
block, a row of live streams, and Shorts carousels come back between the rows.
What you actually subscribed to is in there somewhere, in an order nobody can
explain, and a video that never made it to the page is indistinguishable from a
video that was never published.

TrackTube rebuilds that list from each channel's own public feed, one channel at
a time, and shows it in place of YouTube's. Nothing is filtered unless you asked
for it.

## What you get

### A feed that empties

Hide a video and it leaves for good — unlike YouTube's own "not interested", a
hidden video here is never loaded, never read, never rendered, so hiding
thousands of them costs nothing. Star the ones you mean to watch and they get
their own view. Start a video, come back the next day, and it is still in
**In progress** with the progress bar where you left it.

Hovering a thumbnail plays the video in place, muted, with a sound button if you
want it. Search covers every title and channel the extension holds, without
going through YouTube's search.

### An analysis of what you actually watch

![The history analysis](screenshots/history.png)

Time watched, channels you never miss, how long you wait before opening a video,
where you drop off, which subjects come back in the titles, when in the day you
watch. It measures what you watch from the moment you enable it, and a Google
Takeout export fills in the years before that.

Every figure says what it rests on. A total computed over 590 dated viewings out
of 876 says so on screen; a figure that would only be a guess prints a dash
instead. There are also three small games built on the same data — a year in
review, a head to head and a knockout tournament between your own channels.

### A card by card review of your subscriptions

![Sorting subscriptions](screenshots/triage.jpg)

Subscription lists grow for years. This one walks them one at a time, showing
each channel's latest videos, how often it publishes, when it last did, and how
much of it you actually watched. Right to keep, left to unsubscribe. Channels
that stopped publishing come first.

Unsubscribing really unsubscribes, so a decision only goes out five cards later
— far enough to change your mind, close enough that nothing waits for the end.

### A popup that tells you where things stand

<img src="screenshots/popup.png" alt="The popup" width="400">

What arrived in the last day, week and month, what is starred, what is in
progress, how much is hidden, and when the last collection ran.

## Install

No build step, no bundler, no dependencies to install. The folder is the
extension.

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.
4. The welcome page opens. Import your subscriptions from it, in a tab where you
   are already signed in to YouTube.

Chrome 111 or newer, Manifest V3. It also runs on Chromium based browsers such
as Edge, Brave and Opera GX.

**Keep the folder where it is.** For an unpacked extension Chrome derives the
extension id from the folder's absolute path, and the database is filed under
that id. Renaming or moving the folder gives you a different id and an empty
database. Export a backup from the popup before you move anything.

## Your data

Nothing leaves your browser. There is no server, no account, no telemetry, and
no analytics of any kind.

- Your subscriptions, the videos collected, what you hid, what you starred and
  what you watched live in this browser's IndexedDB.
- The extension asks YouTube for the public feeds it needs, and uses the YouTube
  session already open in your tab for the things that require it: reading your
  subscription list, and unsubscribing when you ask it to.
- It never asks for a password or an API key, and holds no credentials.
- The backup is a file you keep.

Permissions requested: `storage`, `unlimitedStorage`, `alarms`, and access to
`https://www.youtube.com/*`. Nothing else. See the
[privacy notice](privacy.html), also reachable from the popup's help panel.

Watch tracking is **off until you turn it on**. Turning it off later does not
erase what was already recorded; the history page has a button for that.

One YouTube account per browser profile. The database attaches itself to the
first account it sees and refuses writes from another, so that two accounts
cannot end up mixed in the same indexes. Use a separate browser profile for a
second account.

## What it does not promise

- **A Short can briefly appear.** Shorts are excluded using YouTube's own lists
  and the player's metadata, and a confirmed exclusion is permanent. But a video
  published minutes ago may not be classified yet, and a failed request excludes
  nothing rather than guessing. Nothing is ever classified from its duration.
- **Automatic collection is shallow.** It reads each channel's recent feed on a
  schedule. The **Refresh** button goes further, walking the Videos and Live
  tabs of every active channel over the last seven days, and reports partial
  coverage when something stopped it.
- **The reverse diagnostic is a comparison, not a certificate.** It tells you
  what YouTube's own page showed that the database does not hold. It cannot
  prove that either side is complete.
- **Hover previews stop at about a minute.** That is YouTube's limit, not ours,
  and it is a duration rather than a size, so no lighter format gets around it.
  The scrub bar shades the part it cannot reach from the first frame.

The [known limits](docs/LIMITES.md) go into detail.

## Development

Plain ES modules loaded by the browser. No build, no bundler, no TypeScript, no
`node_modules`. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and
[CLAUDE.md](CLAUDE.md) for why the code is shaped the way it is — it records the
decisions that were settled after a bug, which is the part you cannot get from
reading the files.

Always read and write source files as explicit UTF-8.

### Running the checks

The suites are HTML pages you open in a browser. Serve the folder:

```bash
python tools/serve-ranges.py 8731
```

Then open `test/index.html` for the regression suite, `test/modules.html` to
check that every module still imports, and `test/coverage.html` for the
collection paths. **Use a different port per page**: the benches share an
IndexedDB with everything else served from the same origin, and `?cb=N` does not
bust the ES module cache.

If you have Node and Playwright, the same benches run headlessly:

```bash
node tools/test.mjs
```

Set `TRACKTUBE_PLAYWRIGHT_PATH` and `TRACKTUBE_BROWSER_PATH` if they are
supplied from outside the project. `node tools/diagnose-videos.mjs VIDEO_ID`
inspects a video's public metadata without cookies.

`python tools/shoot.py` rebuilds the screenshots in this README, by driving a
headless Chrome over the benches. It needs the network the first time: the feed
and sorting shots use real videos read from public YouTube feeds, and it caches
the channel avatars locally so a capture does not race them.

Build a distribution candidate with `python tools/package.py`. The archive holds
runtime files only.

## Licence

[MIT](LICENSE) © Oihan Barreneche
