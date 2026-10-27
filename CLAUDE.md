# Working on TrackTube

This document is addressed to an agent picking the project up without having
written it. It gives what you cannot guess by reading the files in alphabetical
order: the rules that are not up for negotiation, the way the pieces talk to one
another, and the traps that have already cost time.

`README.md` describes the product from the point of view of whoever uses it.
Here it is the point of view of whoever modifies it.

Before committing agent work, use the identity of the agent that made the
change: `Claude Code <noreply@anthropic.com>` for Claude, or
`Codex (GPT-6) <codex@users.noreply.github.com>` for Codex. Set the repository's
local Git identity accordingly and verify both author and committer. Never
attribute an agent-created commit to the maintainer by inheriting the user's
Git configuration. See `AGENTS.md`.

---

## Current state

Version 1.4.8, audited in October 2026 for a first public release: the README is
the GitHub landing page, the permissions are `storage`, `unlimitedStorage`,
`alarms`, `declarativeNetRequestWithHostAccess` and `https://www.youtube.com/*`,
and the welcome flow is three steps rather than six. The fourth permission came
back in 1.4.7 for one rule and is explained below; do not remove it to make the
list look shorter.

A version number is not a certificate. `README.md` and `docs/LIMITES.md` state
what is not promised, and the one that matters most is that a Short can appear
briefly while its classification is still pending. Local watch tracking defaults
to false until explicitly enabled; the worker must enforce that choice as well
as the tab. Measured numbers elsewhere in this document are observations made on
the date they name, not guaranteed timings or YouTube contracts.

**The working notes are not in the repository.** `.gitignore` is an allowlist
for `docs/`: everything there is private except `docs/LIMITES.md`, and so are
`experiments/` and the dated audit folders. This file is the deliberate
exception, because a contributor without it will reopen decisions that were
settled after a bug. When it names a note — the release gates, the extension key
and the id it yields, the archived preview and Shorts experiments — that note is
on the author's disk beside the project, not in the clone.

## The rules that are not up for negotiation

They come from decisions taken with the user, often after a bug. Breaking them
breaks the product, not merely the style.

**No Shorts, anywhere.** Not in the feed, not in the durations, not in the
averages, not in the upload lists that feed the streaks, not in the counted
viewings. That is the very reason the extension exists. In practice: a channel's
upload playlist is always read with the `UULF` prefix, never `UU`.

**`UULF` no longer excludes Shorts at the source, and that premise is retired.**
Measured on 7 October 2026 on GOTAGA, `UCCFqUJYKT97UerMmb6DM0bw`: its `UULF`
Atom feed carried the Short `x8Jw8NGjpbY` as its **newest** entry — 19 seconds,
`canonicalUrl` reading `/shorts/`. The companion `UUSH` list did hold the video,
so the facts were available; what failed was when they were asked for.
`refreshChannelShorts` caches that list for an hour and returns without reading
while the cache is warm, so a Short published inside the hour was filtered
against a list older than itself. On a channel posting Shorts several times a
day the window is hit constantly, which is why every Short that got through came
from one channel. `withoutShorts` therefore spends one player record per feed
entry that is **unknown and less than a week old**, and that is the same call the
display screening already made on a new row's first paint, moved to collection
where a Short can still be stopped before it has a row. An inconclusive record
changes nothing and the entry is kept: nothing may withhold a video on the
strength of a failed request. The `UUSH`
prefix serves only to *identify* Shorts so they can be kept out of the Takeout
history, which does not distinguish them. The argument that "a Short still counts
as time spent" was explicitly rejected.

The current practical policy (0.89.0) is: collect UULF, exclude exact ids from
UUSH, and persist confirmed exclusions so collection cannot reinsert them.
Never classify from duration, title, a missing field, or absence from a list.
The player canonical URL can also confirm a Short when a player record is
already fetched for publication dates or history.

The current UUSH response uses `shortsLockupViewModel` and its primary
`onTap.innertubeCommand.reelWatchEndpoint.videoId`. The former parser ignored
this template: a real response with 30 Shorts produced zero extracted entries.
Do not use the /watch link in its queue menu, or unrelated recommended lockups.
The old `reelItemRenderer` and actual `playlistVideoRenderer` entries remain
supported. A recorded public example is in `test/shorts-lockup.json`.

`refreshChannelShorts` reads up to five recent Shorts pages per channel, caches
the result for an hour and persists excluded ids. Collection consults this list;
open grids request a background refresh for their channels. Existing rows are
also repaired in channel batches on the alarm. Failures exclude nothing and
have a short retry cooldown. A missing id is never evidence against a normal
video, including a 12 second one.

**Rollback on October 7, 2026:** the user explicitly requested the 0.91.2
runtime, before both Shorts patches. All 60 runtime files match its distribution
archive exactly. The rejected 0.91.3/0.91.4 code, tests and documentation are
preserved in the working notes, outside the repository. Do not reintroduce
the blocking verification or approval-cache policy without a new user request.

**YouTube refuses the worker's internal API requests unless their `Origin` is
rewritten, and that is what let Shorts through for two months.** Measured on 26
October 2026, one player request four times with only the header changing: no
`Origin`, 200; `https://www.youtube.com`, 200; `chrome-extension://<id>`, **403**
with a "Sorry…" page; the same plus the `Sec-Fetch` headers a browser adds, 403.
A worker's `fetch` cannot choose that header, so **every** `call()` in
`innertube-direct.js` was refused, in every Chromium browser: the player record,
which is the only thing able to rule on a Short absent from `UUSH`; the `UUSH`
list itself; and the direct sweep, which then falls back on Atom without a word.
With both layers dead, `withoutShorts` kept everything, every verdict stayed
unknown, the display screening asked the same refused endpoint, and every
fix to the Shorts logic in between — including the re-verification just below
— was correct and changed nothing.

`installOriginRule` in `service-worker.js` registers one `declarativeNetRequest`
session rule at every worker start: `modifyHeaders`, `origin` set to
`https://www.youtube.com`, on `||www.youtube.com/youtubei/`, with
`initiatorDomains` set to `chrome.runtime.id` so that YouTube's own pages and
the content scripts, whose requests carry the page's origin, never match. A
session rule because a static ruleset cannot name its own extension id, which
differs between the unpacked copy and the Store build.

**How this hid for two months is the part to remember.** Every measurement of
the anonymous path in this file was taken from a Python script, and Python sends
no `Origin` header, so each one measured a request the extension never sends and
found it working. It was found by loading the real extension into the reader's
own browser — Opera GX is installed on the development machine, and unlike
branded Chrome, which dropped `--load-extension` in 137, it still honours that
flag — in a throwaway `--user-data-dir`, attaching over the DevTools protocol to
an extension page, which shares the worker's origin, IndexedDB and host
permissions, and calling the real modules against the real YouTube. Before the
rule: player `null`, `UUSH` `null`, fifteen Atom entries inserted with the Short
among them. After: player `isShort: true`, `UUSH` 100 read and 100 recognised,
fourteen inserted, the Short tombstoned with no row. **A claim about what the
extension's requests receive is not checked until it has been checked from the
extension.**

**A stored row is not a settled question, and that cost a Short in the feed
every few days.** `withoutShorts` spent its one player record per feed entry
that was `!stored.has(id)` and recent — one attempt per video, ever. An attempt
coming back inconclusive, which is a refused request or a response with no
microformat, keeps the video by policy and creates the row; from that moment the
row itself exempted the video from every later collection pass. The only thing
left that could recognise the Short was the display screening, which by
definition runs on what is already painted, so the Short was **guaranteed** at
least one appearance and stayed until one of its cards happened to sit on screen
long enough for a second request to succeed.

Measured on 26 October 2026: `yjEuPhcexEs`, 78 seconds, published the day
before, in its channel's `UULF` and **absent from its `UUSH`** — the
`RJBW_Ad_20A` shape, where the canonical URL is the only thing that can rule. An
anonymous player request answers `canonicalUrl: /shorts/…` for it, with the
client version `innertube-direct.js` hardcodes (`2.20240101.00.00`) exactly as
with the live one, both verified against YouTube that day, and `UNPLAYABLE`
without a session changes nothing — `extractPlayerFacts` reads the microformat
regardless. The verdict was always available and simply never asked for twice.

The condition is now the verdict's own freshness, `hasCurrentVideoVerdict`, the
same test the display pass applies, which also covers "not stored at all" since
an absent row has no verdict. Cost is bounded by `shortVerdictLifetime`: three
hours above 200 seconds, a quarter of an hour below, against a fifteen minute
cadence and fifteen Atom entries a channel. The assertion for it is in
`test/collection.js` and it was **checked against the old condition**, where it
fails with zero player requests — write that proof down before trusting a green
suite here, because every piece of this chain reads correctly in isolation.

**Paint complete local rows first, verify stale classifications after paint.**
Feed queries stay local and ordinary cards require duration, not an avatar.
SCREEN_SHORTS refreshes UUSH and checks stale player verdicts in batches of up
 to sixty, with four concurrent requests and a failure cooldown. The canonical
URL can contradict UULF/UUSH; test/collection.html includes RJBW_Ad_20A.
Unknown classification remains visible for responsiveness, so do not claim an
absolute no-Short guarantee. Confirmed exclusions cannot be undone by tab cards.

**Refresh must recover gaps throughout its declared window.** The manual sweep
reads the actual Videos and Live tabs of every active channel over seven days,
with one extra day for relative-date uncertainty. Known ids skip enrichment,
never window pagination. Caps, unrecognised grids, cycles, request failures and
metadata deferrals report partial coverage. Fallback playlists cannot certify a
complete window. Scope the selected channel tab before parsing: Home can be
returned when Live is absent, and its recommendations must not be collected.
The grid rereads above its scroll cursor so late discoveries remain visible.
Tests cover both collection and display using isolated mocked sources.

**That window read had almost never run, and its fixtures are why nobody
saw.** `channelTabBody` refused any tab list holding something other than a
`tabRenderer`, and nearly every channel answer closes its list with Search as
an `expandableTabRenderer`. Every refused answer sent the channel to the
playlist fallback, which is `partial` by construction, so every refresh said
« Collecte partielle » on sweeps where no request had failed. Measured on the
reader's profile on 27 October 2026: 922 of 934 deep read rows since 14 October
carried `reason: 'playlist-fallback'`; the 12 others were answers that happened
to lack the Search tab. The test fixtures built tab lists of `tabRenderer` only,
so they passed against a shape YouTube does not send. The fixture in
`test/collection.js` now copies a real answer, Search included. And
`coverage.reason` in a channel row only ever says `playlist-fallback` once the
fallback ran, with `videosOk: true` because the fallback's own answer replaced
the tab's — that is what all 922 said. Since 1.4.8 the row also keeps
`videosTab` and `livesTab`, the tab reader's own reason (`boundary`, `end`,
`tab-absent`, `unexpected-tab`, `request-failed`…), so the next such question
is answered by reading the rows.

How it was found is the method to reuse: copy the extension's IndexedDB folder
from the reader's browser profile into a throwaway one (the unpacked copy's id
comes from its path, so the same folder yields the same id and the same
origin), load the extension there, and read `directCoverage` off every row; then
open a real YouTube page in a throwaway profile and run the real module inside
the content script's isolated world over the DevTools protocol. Neither touches
the reader's own profile, and neither needs their cookies.

**Since 1.3.0 the window sweep also runs by itself, a slice at a time, and the
button is no longer the only way it happens.** What it costs was measured on 14
October 2026 against YouTube, over 24 real channels and both of their tabs: a
page of a channel tab weighs **112 KB on the wire and 1.3 MB decompressed**, the
window takes **1.7 pages per tab**, so the 592 channels that profile actually
follows come to about **2000 requests and 225 MB**. At eight in flight that is
some 100 s of network alone, and it took close to five minutes end to end.
Extrapolate from the **active** count: the same profile holds 930 rows in its
channels store, every channel ever seen, and a third of them are subscriptions
it left years ago and never sweeps. Most of it was
spent confirming that channels which had published nothing still had published
nothing.

Two things follow. The concurrency is **sixteen**, not eight: the same 48
requests take 2.4 s at eight and 1.2 s at sixteen, all 200, no 429, with the
median request unchanged at 330 ms, so this is latency bound and the factor is
real. And the player verifications inside a channel go out together rather than
one after another, which they always could — they are independent and none
reads another's answer.

The slice rotation lives in the tab, on `/feed/subscriptions`, and asks the
worker through `AUTH_SWEEP_SLICE` for the channels whose deep read is the most
overdue, a channel never deep read coming before all of them. Eight channels
every two minutes covers six hundred in about two and a half hours of browsing,
for some 3 MB a slice. The order is the only thing deciding it, and it is an observation
(`directCoverage.checkedAt`), never popularity or publishing frequency. It
yields to a manual sweep, because that is somebody waiting.

**Atom cannot be used to decide which channels deserve the deep read.** It is
35 times cheaper — 6 MB against 362 for the whole list, measured the same day —
and the idea is tempting every time. It is served with fifteen minutes of CDN
cache, so a channel whose cached copy predates a publication answers that there
is nothing new. Gating on it would cost the one thing the deep read is for:
seeing a video published two minutes ago.

Automatic collection still uses shallow Atom feeds. Do not describe it as an
exhaustive traversal or assume that a manual scan has made unattended coverage
complete. The release gates are in the working notes, which are not in the
repository.

**Three ways of missing a subscribed channel's video were closed in 0.96.0, and
each of them had the same shape: a saving taken on a request, paid for in a
video.** They are worth knowing before taking another one.

*The Atom feed stops at fifteen entries and does not say so.* No page link, no
total: fifteen published and forty published give the same answer. A read whose
fifteen entries are **all** new is therefore ambiguous, and the upload playlist
is read behind it, which answers a hundred in one request. `lastSuccessAt`
excludes a channel read for the first time, or a fresh profile would make one
playlist read per subscription. When the playlist refuses, `overflowAt` keeps
the debt on the channel row: by the next tick the fifteen are stored and the
saturation can no longer be derived from anything.

*Lives had a blind fortnight.* `UULV` is a separate playlist, and a channel
whose live feed answered empty or 404 was not asked again for fourteen days.
Measured on 8 October 2026 over thirteen channels, a 404 costs **1612 bytes**
and seven of those thirteen had a real live feed, so the saving was 1.6 KB per
silent channel per sweep and the cost was `Co7jh46dJ7w`. The live feed now
follows the main one, and `livesNextDueAt` was removed rather than aligned: a
second due date on the same row is a second thing to keep in step, and
`markAllDue` — the manual "re-read everything now" — never knew about it, so
even an explicit full refresh skipped the live feeds.

*A truncated subscription list deactivated real subscriptions.*
`listSubscriptions` walks the account page by page and says `complete: false`
when a page fails; the daily reconciliation handed that partial list to
`reconcileChannels` anyway, and everything past the break was deactivated — no
longer swept, no publication arriving, nothing on screen. Deactivation is now
subject to the same `complete` flag that already guarded the video purge.

**A guard that cannot be satisfied is a bug, and this one took three tries.**
The `complete` flag was not enough — a pagination that runs to the end does not
prove YouTube returned everything — so 1.2.1 added a second condition, and both
later versions of it failed in the same way: they measured the suspect list
against **our own active count**, which is whatever an earlier bad read or a
repair happened to leave it at.

`reactivateAllChannels` had woken a profile's 930 rows against a real list of
592, so every daily pass wanted to switch off 36 % of the active list. At first
that tripped a quarter-of-the-active-list refusal on both paths, which also
refused the manual import — a deadlock, fixed by exempting the attended path.
That fix was mistaken for the whole fix. The automatic path is the only one that
runs by itself, it was still refused, every day, for ever, and nothing else
prunes: `UCLS4wuBNQTIr4RAAG_stxOQ` was still painting 42 minute videos into a
grid of channels the reader does not follow on 16 October 2026, nine days later.

Since 1.4.2 the yardstick is **the last list YouTube returned**, held in
`meta` under `subs.listBaseline`. 592 after 592 is a believable afternoon's
pruning however many rows we hold; 116 after 592 is a bad read. A refused read
is remembered separately, under `subs.listDoubt`, and never becomes the
baseline — writing it would ratchet the yardstick down to whatever the broken
read returned, and the guard would then wave through the list it had just
refused. And the refusal expires: the same size an hour later is a second
observation and is acted on, which is the rule `confirmAbsent` already applies
channel by channel. Without that, a reader who genuinely unsubscribed from a
third of their list would be refused for good — the same deadlock, one level up.

Two consequences worth stating before touching this again. Any guard here must
be checkable against something YouTube said, never against a count of our own
that our own bugs write. And a departure takes two reconciliations to leave the
feed, which at one a day is **two days**, because the paint guard reads
`active`; the remedy offered to a reader in a hurry is the settings panel's
« Réimporter depuis YouTube », the attended path, which prunes and purges at
once.

**And before fixing the pruning logic a fourth time, check that it has ever
run.** Three repairs went into it over nine days while the reader went on seeing
a channel they had left, and none of them could have helped, because every one
of them is downstream of a list the reader's browser may be unable to fetch:
`maybeReconcile` calls `innertubeAvailable()`, which requires `authorization()`,
which requires a readable `SAPISID` — and Opera GX is documented three sections
below as exposing `ytcfg` without it. When that gate fails the function returns,
silently, and nothing else in the product ever sets `active` to 0. The paint
guard then reads a flag that nothing maintains, which is the whole explanation
and it is not a bug in the guard.

The silence was the real defect. The gate now logs why it gave up, `getStats`
carries `lastListAt` from `subs.listBaseline`, and the popup's diagnostics print
when the subscription list was last read with **"never"** as a real answer —
the one line that would have ended this on day one.

And the reader gets a way out that depends on none of it: `FORGET_CHANNEL`, on a
card's menu as « Je ne suis plus abonné à … », calls `forgetChannel` to switch
the local row off and `deleteChannelVideos` to take its videos with it. No list,
no request, no guard to satisfy. Do not route it through `applyToChannel`: that
helper folds away the exact thumbnails named in `changedIds`, and this removes
rows no card is showing, so the grid is reloaded instead.

**A feed never switches a channel off, and the list guard was not the only
thing that could.** Until 1.4.8 `applyOutcome` deactivated a channel at its
third 404, every guard above being about the subscription list, and an
inactive channel is never read again, so no success could undo it. Overnight on
26 to 27 October 2026 YouTube's Atom feeds answered 404 for 408 of the reader's
597 subscriptions, all back to 200 by the morning; the 408 rows were found with
`failCount: 4`, `missingSince: 0`, last fetched between 00:29 and 00:38 UTC. The
four, not three, is the other half: `reconcileChannels` at 00:29:14 woke them
with `nextDueAt: 0` but left the counter, and the read six seconds later was the
fourth 404. A 404 now resets the counter and keeps the ordinary cadence, a wake
resets it too, and `reconcileAfterFeedOutageOnce` forgets
`ytfeed:lastReconcileAt` once so the next YouTube page reads the list and wakes
exactly what it holds. Do not repair this by waking every row whose counter
reached three: only the list knows which of them the reader still follows. The
14 October collapse to 116 active was blamed on bad list reads; nothing
measured then rules this rule out instead.

**The reverse audit only judges channels the extension follows.** It used to
count every dated card of YouTube's subscriptions page that we did not hold,
which accuses the collector of missing videos it was never asked to fetch —
YouTube mixes recommendations into that page, which is the whole reason this
project exists. Nothing is dropped: an observation is filed under followed and
active (the headline figure), followed but deactivated, or absent from the list,
and the last two are reported with their channel names, because only the reader
knows whether a channel they are not following is a recommendation to ignore or
a subscription the import lost.

**The native subscriptions feed creates videos since 1.2.0, and the rule that
said it never does is retired.** It did enrich and measure only, passing
`allowInsert: false`, on the grounds that the page carries Shorts and nothing in
its DOM rules them out. That reason was written before 0.89.0 brought
`videoClassifications`, the `UUSH` exclusions and player verification: the
verdict no longer comes from the card, so the card no longer has to be refused.
What the source is worth is the delay — it is the only one that sees a
publication at the moment YouTube does, where an Atom read waits for its
channel's turn and the manual sweep waits for a click, and it was measuring what
it was forbidden to collect, so a video could be observed there, filed by the
audit as missing, and still never reach the grid.

The enrichment pass stays `allowInsert: false`. Creation is a second pass that
writes nothing itself: it groups the cards by channel and hands them to
`ingestAuthenticatedUploads`, the function the manual sweep already creates
through, so one policy governs both paths rather than two that drift. Three
refusals follow from it and none may be loosened — a channel that is not
followed and active is refused outright, which is what keeps out the
recommendations YouTube mixes into that page; a player record that does not
positively say "not a Short" inserts nothing and is retried; and a video with no
duration is deferred rather than stored invisible.

**Its source field is `native-verified`, never `native`.** `purgeNativeInserted`
deletes every row whose source is exactly `native` — it is the one-time cleanup
of the unscreened inserts this harvest used to make, Shorts among them. It has
already run on installed profiles, but it runs at startup on a fresh one, and
reusing the word would arm a cleanup against the rows it is meant to protect.

Automatic collection also creates from `UULF` Atom, and a manual authenticated
sweep from a channel's actual Videos tab. The grid card carries the relative publication
time, while its lockup carries the duration; merge both representations by video
id. Tab membership is provisional. Cards at or below 200 seconds require player
verification before insertion; duration prioritises verification, never
classifies a Short. Other complete cards may use tab metadata, followed by the
separate display check. Relative publication timestamps are marked approximate
and may be upgraded by exact RSS/player data.

**Public channel collection must remain possible without a readable YouTube cookie.** Opera
GX may expose `ytcfg` but not `SAPISID` to the isolated content world. Channel
Videos tabs, upload playlists, owner avatars use a minimal client context with `credentials: omit`. Player
facts try the authenticated session when available and fall back to public
requests; subscriptions, history and
subscribe actions remain authenticated. Requiring `authorization()` for a
public channel read silently sends Opera back to stale RSS.

**Present in IndexedDB is not the same as ready for the feed.** RSS can create a
recent row without a duration; the strict display guard then withholds it. Such
a row must not be skipped by authenticated enrichment, and
`ingestAuthenticatedUploads` must update it instead of treating every existing
primary key as finished. Since 1.2.0 that function also refuses to *create* one:
a player record carrying no duration, on a video that is neither live nor
upcoming, is deferred and retried rather than inserted. Inserting it produced a
video that existed in the database and could never reach the grid, which is the
failure mode that makes a publication look lost rather than late, and the test
is the one `videoIncomplete` and `factsFromVideosTab` already apply.
Explicit Members-only badges are stored in
`videoClassifications` as `membersOnly`, separately from `isShort`, so Atom
cannot resurrect them and the reverse audit never calls them Shorts. An
unbadged card clears that flag when a Members-first publication becomes public.
The same channel-tab response carries the owner avatar. Always pass it through
`AUTH_SWEEP_CHANNEL`, even when there is no candidate video: this supplies cosmetic avatar data without withholding a complete publication. This signed channel response is authoritative:
it may replace a nonempty stored avatar because YouTube image URLs expire.
Authenticated responses also carry the current account's avatar and channel
banners on the same `yt3` host. `extractOwnerAvatar` must only accept explicit
channel metadata, page-header avatar, microformat thumbnail or video-owner
structures. A generic image traversal corrupts every channel with one avatar.

**Never keep a one-shot Chrome message response open for a whole sweep.** A
per-channel refresh can outlive the message channel even while its tab remains
open. `AUTH_SWEEP_RUN` acknowledges synchronously, the content script persists
each channel through `AUTH_SWEEP_CHANNEL`, then `AUTH_SWEEP_DONE` closes the
progress operation. Completion must stay separate from the launch response.

**An action reports itself visually.** A progress ring, cards appearing, a
thumbnail fading out. No status sentence, no banner saying "search finished, 3
new videos". Only an error message is legitimate. And a progress bar has to be
honest: reaching 100 % while the work continues is a defect, not cosmetics.

**No dashes, hyphens or underscores as separators in visible text.** French
compounds are written without a hyphen in the interface and in the comments:
« arrière plan », « celle ci », « elle même », « au dessus », « peut être », « au
delà ».

**The database belongs to an account, and says so.** IndexedDB is attached to the
browser profile, not to the Google account: with no guard, signing in elsewhere
in the same window would mix two accounts into the same indexes, and the daily
reconciliation would deactivate one account's subscriptions because they do not
appear in the other's. The first account seen adopts the database; everything a
tab causes to be written carries its key (`DATASYNC_ID`, see
`src/lib/account.js`) and the worker refuses what comes from elsewhere. A missing
key means "we do not know" and passes: the previous behaviour is better than a
lock up on a failed read.

**The screenshots are real, and they are built by a command.**
`python tools/shoot.py` drives a headless Chrome over the benches and writes
`screenshots/` at 1280 wide, which is also the Chrome Web Store's required size.
It exists because a capture taken out of a window is whatever that window
happened to be, and because three of the four shots need a state nobody should
have to click their way to: the analysis framed from its eight headline figures
down to the rhythm charts, the triage caught in mid gesture, the popup at its
own size. Each bench knows that state through a `?shot=` parameter and is
unchanged without it.

The feed and the triage show **real videos from real channels**, read on
8 October 2026 through the same `UULF` Atom feeds the extension collects with,
plus one public player record per id for the duration. They are in
`test/fixtures/real-feed.json`. An earlier version invented the names, on the
reasoning that a real channel in a published image reads as an endorsement
nobody gave; the user asked for the opposite and that is their call, because a
reader recognises MrBeast and does not recognise `Atelier Cosmos`. What stays
invented is the viewer's own state — what is hidden, starred, part watched, how
many of a channel's videos were watched — since no feed carries it and it is the
half of the picture the product is about. Nothing is ever attributed to a
channel that did not publish it.

Avatars are cached under `test/fixtures/.avatars/`, which is **not** in the
repository: they are other people's pictures. `tools/shoot.py` downloads them on
first run. Without that cache the grid's avatar probe races the network and
paints a different channel as a coloured initial on every run.

**Interface text is short.** Long explanations live in `docs/` or in the popup's
help panel, not under every setting.

**The welcome flow is three steps, and the reserves are not on the first one.**
It had six: why, what you can do, import, how collection works with its FAQ,
what you watch, and the triage. Four of those described hiding, starring,
searching, the collection cadence, the live feeds and the card by card review —
all of which the popup's help panel already explained, at greater length. The
cost was paid twice. The one action that has to happen, reading the subscription
list, sat on screen three of six; and the first screen promised a feed without
Shorts and hedged it in the same paragraph, which is the first sentence anyone
reads about the product. The reserves moved to the help panel beside what they
qualify, `docs.what.p3` for a Short that slips through while unclassified and
`docs.hide.p4` for YouTube never seeing what you hide. Do not put a caveat back
on step one, and do not re-explain in the flow what the help panel holds.

**A figure whose scope is limited says so on screen.** "since installation",
"over 7 days". A figure silent about its window is a wrong figure.

**Settings are global, or filed in their own tab.** The popup's settings panel
carries only what holds everywhere; what holds only for one feature is set at the
bottom of that feature's own tab.

**Determinism before saving requests.** No heuristic that favours popular or
frequent channels. No cadence justified by a bandwidth estimate that has not been
measured. Measurement has already contradicted intuition twice on this point, see
the header of `src/background/scheduler.js`.

**A design validated with the user is authoritative.** If a constraint discovered
along the way makes it difficult, say so and propose an alternative. Never change
approach silently and present the result as the expected step.

**Comments explain the why, with measured numbers.** The code already says what
it does. A comment paraphrasing the next line is noise; a comment saying "this
threshold was at 90 days, which put a channel publishing every four months to
sleep" is what stops the next agent from making the mistake again. Everything is
in English.

---

## What the project does not have

No build. No bundler. No TypeScript. No `node_modules`. **Node is not installed
on the machine.** The folder as it is, is the extension: you load it in
`chrome://extensions` in developer mode.

Direct consequence: every module is an ES module loaded by the browser, every
import path is relative and real, and a wrong path only shows up at runtime.

---

## The map

### Four execution contexts

| Context | What runs there | What it is allowed to do |
|---|---|---|
| **Service worker** | `src/background/*` | IndexedDB, `chrome.alarms`, unauthenticated `fetch` |
| **Content script, isolated world** | `src/content/loader.js` then everything it imports | the extension API, YouTube's DOM |
| **Content script, MAIN world** | `src/content/main-world.js` | the page's Polymer properties, nothing else |
| **Extension pages** | `welcome.html`, `history.html`, `journal.html`, `src/popup/` | the extension API, not the YouTube session |

The MAIN world exists for one reason only: YouTube is a Polymer application, and
an element's real data (`channelId`, duration, playback progress) lives in its
`.data` property, invisible from the isolated world. `main-world.js` does nothing
but read and forward through `postMessage`. **The isolated world treats
everything coming from it as untrusted** and validates the shape of every record:
the page could forge those messages.

### Start up sequence on a YouTube page

```
manifest.json (document_start)
├── src/content/main-world.js        classic script, MAIN world
└── src/content/loader.js            classic script, isolated world
      └── dynamic import() of src/content/main.js
            ├── feed-view.js  + feed-view.css   the replacement grid
            ├── triage.js     + triage.css      triage by swipe
            ├── batch.js      + batch.css       applying a list
            ├── watch-tracker.js                the viewing measurement
            └── (on demand) innertube.js        the internal API, session side
```

`loader.js` is a classic script because MV3 forbids declaring a content script as
an ES module. It loads the real module dynamically, which requires the target to
be listed in `web_accessible_resources` — which is the case for
`src/content/*.js`, `src/lib/*.js` and `src/lib/locales/*.js`.

**What requires an extension reload and what does not.** The manifest,
`loader.js`, `main-world.js` and everything under `src/background/` are frozen at
extension load: you have to click the reload icon in `chrome://extensions`.
Everything descending from the dynamic import of `main.js`, that is to say most
of the interface code, is re read on every page load: a plain F5 is enough.

### The modules, one line each

**`src/lib/` — shared by every context**

| File | Role |
|---|---|
| `db.js` | the whole IndexedDB layer, six stores, no network request |
| `messages.js` | the `MSG` contract plus `send` / `broadcast` / `route` |
| `rss.js` | `UULF` URL, fetching, Atom parsing done by hand |
| `innertube-parse.js` | pure reading of the internal API's JSON, no network, no DOM, including the order the preview offers its sound tracks in |
| `util.js` | concurrency `pool`, XML entities, formatting, `broadcastKind`, `videoIncomplete` |
| `i18n.js` / `i18n-dom.js` | catalogues and translation of `data-i18n` markup |
| `locales/fr.js`, `locales/en.js` | the two catalogues, at strict parity |
| `history.js` | Takeout history analysis: statistics, streaks, themes, topics, the day journal, the delays, the sittings, the rewatches, the drop off, the publishing rhythm |
| `feed-options.js` | the list of options `getFeedPage` accepts, isolated to be testable |
| `triage-order.js` | order of appearance and suspicion score for the triage, pure functions |
| `subscriptions-csv.js` | reading Takeout's `subscriptions.csv` |
| `audit-format.js` | text rendering of the audit report, separate from the engine |
| `account.js` | identity of the signed in account, pure functions |
| `log.js` | `log.debug/info/warn/error`, level set through `tracktubeLog.level` |

**`src/background/`**

| File | Role |
|---|---|
| `service-worker.js` | life cycle, alarms, routing of every message |
| `sync-engine.js` | the collection loop, the two sweep paths |
| `scheduler.js` | when to re read a channel, pure functions checkable from the console |
| `innertube-direct.js` | the internal API called from the worker, without cookies |
| `audit.js` | comparison of our index against the native feed |

**`src/content/`**

| File | Role |
|---|---|
| `loader.js` | the bootstrap, sixteen lines |
| `active-account.js` | the tab's account key, shared without an import cycle |
| `main.js` | MAIN bridge, harvesting, subscription import, enrichments, SPA routing |
| `main-world.js` | reading the Polymer properties, MAIN world |
| `feed-view.js` | the replacement grid, the toolbar, the selection, the menu |
| `triage.js` | the swipe based subscription triage screen |
| `batch.js` | applying a list of channels to the account |
| `watch-tracker.js` | measuring a viewing session on `/watch` |
| `innertube.js` | the internal API called from the tab, with the session |

**`src/pages/` and the root**: `welcome.html` (the welcome page, at the root, with
`src/pages/onboarding.js` and `.css`), `history.html` (the analysis, at the root,
with `src/pages/history.js` and `.css`), `journal.html` (the detailed history, at
the root, with `src/pages/journal.js` and `.css`), plus the three games
`retro.js`, `duel-game.js`, `tournament.js`.

`history.html` holds three views, switched by the hash and nothing else: the
overview, a channel's report (`#chaine=UC…`) and a comparison
(`#comparer=UC…,UC…`).

`journal.html` is a page of its own and not a fourth view of that one, which it
briefly was: sharing the analysis page meant carrying its whole top — the range
bar, the channel search, the game cards — above a screen that reads one day at a
time and no range at all. It is the only screen that does not aggregate: it shows
a row of the history as it is stored, next to what the feed index holds for the
same video, which is what makes it the first place to look when a figure
elsewhere looks wrong. It takes the day from the hash (`#jour=2026-08-20`), and
with none it opens on the most recent day that holds something rather than on
today — someone whose last viewing is a week old would otherwise land on an empty
screen and read it as a broken page. Its arithmetic lives in `buildDayJournal`,
pure and tested; the page only draws it.

Three decisions on that page are worth not undoing. **Its arrows do not step one
day at a time**: they land on the next day that actually holds something, because
a day with no history teaches nothing and a quiet week meant seven empty screens
in a row. **It has no tooltip at all**: a badge whose meaning has to be hovered
for is a badge that has not been named properly, so everything readable is
written — the one figure revealed on hover, on the bars of the two charts, is
drawn by the page and not handed to the browser as a `title`.

And **its headline figure is the measurement alone, not the mixed model**. That
model credits a video no opening of which was measured with its whole length, and
on a Wednesday of four two hour videos merely opened it announced eleven hours
watched. It is the right answer over a range of months, where the unmeasured
openings average out; it is a guess on one day, and this page exists to show what
is not a guess. Under the three figures a sentence says what the day rests on:
how many of its videos have a known length, what those lengths add up to, how
much of that was really measured, and how many videos no percentage can speak
for. The `coverage` block of `buildDayJournal` holds it, capped video by video
because a measurement can exceed a length that is only a channel average.

---

## The data

Database `ytfeed`, version 8. Seven stores, including `videoClassifications` for
player verdicts and durable Short exclusions.

**The name kept its old spelling, and so did every persisted key.** The product
was renamed to TrackTube in August 2026; the database name, the `ytfeed:` keys
of `chrome.storage` (`ytfeed:settings`, `ytfeed:onboarded`, `ytfeed:lang`,
`ytfeed:pendingImport`…), the alarm name and the maintenance keys under `meta`
did not move. Renaming any of them would make an installed profile look empty:
its settings lost, its onboarding never done, its collection restarted from
nothing. What did move is everything structural — the `tracktube-` prefix of the
class names, dom ids and custom properties — and everything visible.

Two of those keys are only caches and may be thrown away without consequence:
`ytfeed:histSummary` holds the last answer of `HISTORY_SUMMARY` and
`ytfeed:feedPulse` the last of `GET_FEED_PULSE`. The popup draws its History
figures and its Feed carousel from them the instant it opens, then replaces them
when the worker answers.

The reason is measured. `HISTORY_SUMMARY` reads every measured session to date;
on a store of fifty seven thousand rows the pass alone costs about 700 ms with
`getAll` — and it cost 1.1 to 1.3 s with the cursor it used until September 2026,
which is the trap `getAllHistory` documents and which had simply not been applied
there. `GET_FEED_PULSE` reads thirty days of videos and the whole channel list.
On top of that the service worker is killed after some thirty seconds idle, so
nearly every popup opening also pays for its start. The History tab showed two
dashes for close to five seconds and read as broken.

Three things follow, and none of them is optional. The keys are written **by the
worker**, on every answer, so that a popup closed before its refresh ended still
leaves the next one something to draw — writing them from the popup was the first
attempt and it did not hold. `refreshHistory()` runs beside `refresh()` and not
inside it, so those two figures no longer queue behind the sync state, the feed
counts and the triage. And `invalidateAnalysis` removes `ytfeed:histSummary`: a
wiped history that went on announcing forty thousand viewings for one more
opening would read as a failed wipe.

A failed call leaves the cached figures alone rather than turning a real history
into a zero.

| Store | Key | Content | Indexes |
|---|---|---|---|
| `channels` | `id` (`UC…`) | one subscription and its collection state | `by_due`, `by_active` |
| `videos` | `id` | one video of the feed | `by_published`, `by_channel`, `by_visible`, `by_live`, `by_upcoming` |
| `meta` | `key` | cursors, settings, timestamps | — |
| `history` | `key` | one viewing session, imported or measured | `by_time`, `by_channel`, `by_video` |
| `durations` | `videoId` | durations fetched for the history analysis | — |
| `histoChannels` | `channelId` | what we learned about a channel while enriching it | — |

Three things to know before touching them.

**`by_visible` carries the whole rendering of the feed.** It is the composite
index `[hidden, publishedAt]`. Hidden videos are filtered inside the cursor: a
hidden video is never read, never deserialised, never rendered. That is what
makes the cost of hiding constant, and it is the central defect of the competing
extensions that is corrected here. Do not replace it with a JavaScript filter
after reading.

**The bin has its own index, `by_hidden_at`, and it is not that one.**
`[hidden, hiddenAt]`, walked backwards, because someone opening the Hidden view
after putting a run of videos there is looking for that run. Ordered by
publication date it sat under whatever happened to be most recently published
among everything they had ever hidden, which on an old bin means it never
reached the top at all. The page cursor therefore carries whichever key the
active index is ordered on, not always `publishedAt`; the field keeps that name
because the caller only hands it back untouched. A composite key half of which
is `undefined` is not a valid key and IndexedDB silently leaves the record out
of the index, so the migration gives every row a numeric `hiddenAt` before
building it — a row missing from the bin would be worse than a row in the wrong
order.

**Two installed copies hold two databases, and the page is how they find out
about each other.** An unpacked copy loaded from a folder and the same extension
installed from the Store have different ids, therefore different
`chrome-extension://<id>/` origins, therefore separate IndexedDB. Both inject
`loader.js` into YouTube, both replace the subscriptions page, and whichever
paints last wins. Hiding a video then writes to the database of whichever grid
owned that card, so a cold start painted by the other copy shows it again, and
there is nothing in either database to explain it: each one is internally
consistent, and `setHidden`'s durability is pinned by an assertion that reads a
hidden row back through a **second IndexedDB connection** rather than the one
the module caches. That assertion is what ruled the storage layer out, after
three days of auditing writers that were all correct.

The guard is an attribute on `<html>`, `data-tracktube-owner`, carrying
`chrome.runtime.id`. It has to be the DOM: each extension's content script runs
in its own isolated world, so a marker on `window` set by one copy does not
exist for the other. A different id already present means stand down and say
so; the same id is re-entrant on purpose, because an extension reload
re-injects into a document that may still carry our own marker and must not
disable the extension until the next full page load.

**A hiding is recorded even when there is no row to record it on.** `setHidden`
read the row, found nothing and moved on, writing nothing at all — and the grid
can perfectly well hand it an id whose row is gone, because it holds its
thumbnails until the next paint while a channel purge deletes the videos of
every channel a reconciliation switches off. Collection then recreates that row
from the feed, and the insert path reads `hidden` from the classification
store's `userHiddenAt`, which nothing had written. Fifteen videos hidden one
evening were back the next morning. The decision is now written for every id,
present or not; `writeHiddenState` was always meant to carry exactly that, and
every deletion path already called it. `setHidden` returns `{changed, recorded,
missing}` rather than a count, because "no row was flipped" and "no decision was
taken" are not the same event and only the second one is a loss.

**And the gesture may not confirm itself before the write has answered.**
`hideVideos` folded the thumbnails away, then sent the message, then on failure
wrote one console line and returned — leaving them folded, so the gesture
reported itself as done and the videos came back on the next paint. That is the
worst shape a defect can take here: hiding is the feature, and a hiding that
silently does nothing reads as an unreliable product rather than a failed
request. The cards go back and an error is shown. The rule that an action
reports itself visually does not license reporting a success that did not
happen, and the four `SET_HIDDEN` call sites in `feed-view.js` each need their
own failure path.

**Whose videos these are is settled at paint time, by `activeChannelIds`.**
Collection already refuses a channel that is not followed, but a row outlives
the subscription that brought it in — a channel left since, one woken by a
repair — and until something prunes it, it fills the grid. `getScreenedFeedPage`
reads the followed ids from `by_active` and `getFeedPage` drops anything else.
That option is in `FEED_PAGE_INTERNAL_OPTIONS` and never in `FEED_PAGE_OPTIONS`:
a tab allowed to name the channels it considers followed would walk straight
through the one guarantee the product sells.

**The history has three sources, and `source` says which.** `live` is what the
extension measured, `takeout` what an export supplied, `yt` what was read off
YouTube's own history page. Precedence goes in that order, and the reason is
precision: the first two date a viewing to the second, the third gives a date
heading and nothing else. A `yt` row is therefore written at **local noon**,
only when nothing already covers that video on that day, and it is deleted the
moment a precise row turns up for the same day — see `dropScrapedTwins`.

The consequence to keep in mind before adding a statistic: **a `yt` row has no
hour**. `hasClock` in `history.js` is what keeps it out of the hourly curve, and
`withClock` is what lets the page say how many viewings that curve was drawn on.
Counting those rows in would put a spike at midday nobody ever watched.

**A total of hours never mixes a measurement and a length on the same video.**
`computeStats` counts a measured opening at its measured seconds, a video no
opening of which was measured at its length, once, and never both — that is the
`mixed` model, the default since September 2026. What it replaced chose one unit
for the whole range from the measured coverage, and that is how a week the
extension had measured almost entirely came out at **eleven hours a day**: the
`yt` rows can never carry a measurement, so collecting them pushed the range
under the threshold for good and every video went back to its full length, with
nothing on screen saying the unit had changed. The old behaviour survives as
`timeModel: 'auto'`, a setting at the bottom of the analysis page with an
adjustable `realThreshold`, and the reader is told in figures what rests on a
measurement and what rests on a length. The middle ground that was ruled out,
and stays ruled out, is extrapolating the observed completion rate onto the rows
nothing is known about: that invents hours indistinguishable from observed ones.

**The same rule governs a sitting's length: unknown is not zero.**
`computeSessions` groups two viewings less than half an hour apart, and a sitting
none of whose videos was measured has **no** length — not a length of zero. Kept
in, those sittings dragged the median to `0 h` on the bench of a history where
one row in four carries a measurement, which reads as a broken figure and not as
a missing one. The function returns `timed` beside `count`, and `medianSpan` and
`longest` are `null` rather than zero; the page prints `—` and says on how many
sittings the two figures were computed. `hasClock` also applies here: a `yt` row
has no hour and cannot be grouped, so it is counted in `total` and named on
screen. The same reasoning gives `computeUploadRhythm` its `covered` flag — a
window reaching further back than the feed index is not a low rhythm, it is an
unanswerable question, and the page drops it instead of printing it.

The third source exists because the first two leave a hole, and the measurement
is not close. On one real account, on 28 August 2026: the Takeout export held
12 764 viewings from 23 May 2024, the history page paged back to 24 March 2020
and gave 44 349, in 255 requests and about four minutes. The date headings are
asked for with `hl: 'en'` forced on that call and no other — they are the only
date the page gives, and one parsing table beats one per interface language.
`Date.parse` is checked against a shape first: asked for `Playlists, 2026` it
answers the first of January rather than refusing.

**`durations` and `histoChannels` are kept apart from `videos` on purpose.** The
history goes back years and cites thousands of videos from channels one is not
subscribed to. Writing them into `videos` would make them all appear in the feed.

**An index migration must happen outside the first opening block.** The
`if (!db.objectStoreNames.contains(...))` only runs on a brand new database. An
index added only there would never exist on installed profiles, that is to say
precisely the ones that have data. See `indexBroadcasts` and the addition of
`by_video` in `openDb`.

`withTx(stores, mode, fn)` resolves when the transaction is **committed**, not
when `fn` has handed control back. `fn` must never await anything other than an
`IDBRequest`, otherwise the transaction closes by itself.

`upsertVideos` never overwrites user state: `hidden`, `watched`, `watchProgress`,
`starred` and `discoveredAt` survive any re reading of a feed.

---

## The messages

A single contract, `MSG` in `src/lib/messages.js`, with a comment per family.
Without TypeScript, that is what prevents silent typos: **never write a message
string inline.**

Three functions and one convention.

- `send(type, payload)` — towards the service worker. Always returns an object,
  never an exception: `{ok: true, …}` or `{ok: false, error}`. A single retry is
  done automatically when Chrome reports a closed channel, because the worker can
  be killed mid processing — the work happened, only the answer was lost.
- `broadcast(type, payload)` — without awaiting an answer and without failing if
  nobody is there to hear it.
- `route(handlers)` — installs the router. Each handler's return value is wrapped
  in `{ok: true, …}`, an exception in `{ok: false, error}`.

**The service worker does not know the chosen language.** It returns identifiers
(`err.badbackup`, `no-harvest`) that the display side passes to `t()`. Never
return a sentence from the background.

One particular direction of travel: some tasks can only run in a YouTube tab,
because it alone has the session. The worker then only supplies the context and
the batches, the tab makes the calls and sends the results back. That is the case
for the subscription import, the enrichment of the history durations, the
unsubscribing and the applying of a list (`HISTORY_ENRICH_*`, `RUN_IMPORT`,
`BULK_CONTEXT`).

---

## The two collection paths

These are two distinct mechanisms, for two distinct needs. The measurements
justifying each are in the headers of `scheduler.js` and `innertube-direct.js`.

### Automatic — Atom feeds, every 15 minutes

`https://www.youtube.com/feeds/videos.xml?playlist_id=UULF{id without UC}`

Measured in August 2026: `Cache-Control: public, max-age=900`, **no ETag, no
Last-Modified**, ~10 KB on the wire gzipped, ~230 ms median. Three hundred
requests at twenty four in flight run at 164 per second without a single 429.

There is therefore **no way to ask "what is new?"**: every check downloads the
whole feed again, and change detection is done afterwards, by fingerprinting the
content. That fingerprint deliberately ignores the view counters, which move
constantly.

**The consequence is paid elsewhere, and it has cost twice.** Since the
fingerprint does not move when only the views change, **no write may ever be
gated on "the fingerprint changed"**. The feed is downloaded and parsed anyway by
the time the question arises: re reading its entries costs nothing more on the
network, and `upsertVideos` only writes the records that actually changed. This
guard existed on the main feed, then, once removed there, it remained on the
lives one: a rebroadcast discovered at a hundred and twenty four views still
showed a hundred and twenty four the next day, when it had forty five thousand.

The cadence is not an aesthetic choice: below the quarter hour of cache, the
request returns exactly the same bytes. Since version 0.49, the re read is phase
locked on the `Age` header of the copy received, which makes it possible to fall
back exactly on the instant it expires.

The worker wakes every 5 minutes, which is a **granularity, not a cadence**: at
each wake up, only the channels whose time has come are read.

### Manual — internal API, on a click of the ⟳ button

`POST /youtubei/v1/browse` with `browseId: 'VL' + playlistId`.

Measured: ~61 KB gzipped, 394 ms median, **no cache header at all**. Two hundred
requests at sixteen in flight, zero 429. Extrapolated to 900 channels: 25 seconds
and 56 MB. The call works **without a session and without cookies** — and it goes
out with `credentials: 'omit'`, because one does not sign a sweep of the whole
subscription list. Those figures were measured from a script; from the worker
the same call is refused with a 403 unless the `Origin` rule described under the
Shorts rules is installed, see `installOriginRule`.

It is this path, and this path alone, that sees a video published two minutes
ago.

Two things to know if you touch it.

**The response carries no exact date**, only relative text ("2 months ago"). The
date comes from an extra call to `youtubei/v1/player`, per new video, which gives
`microformat.playerMicroformatRenderer.publishDate` to the second. It is capped:
`MAX_DATES_PER_CHANNEL = 15`, `MAX_DATES_PER_CLICK = 300`. The
`playabilityStatus: 'UNPLAYABLE'` returned without a session is of no
consequence, we are reading a record card, not a video.

**The shape of the response has changed.** The modern rendering is
`lockupViewModel`, a hundred per page, and no longer `playlistVideoRenderer`.
`extractPlaylistVideos` handles both; do not remove the older branch.

**This path is deliberately the second one.** The internal API is undocumented
and can change without notice: `runDirectSweep` probes three channels before
launching and returns `{fallback: true}` if the API stays silent, in which case
the click falls back on the Atom feeds. And at 15 minutes, the internal API would
represent roughly 5 GB a day against 1.4 GB for Atom — that is why it does not
drive the automatic collection.

**Preview rollback (0.91.1), hardened in 0.91.2.** The user rejected both replacement attempts.
`feed-view.js`, `feed-view.css` and `innertube.js` match the 0.89.0 runtime ZIP
byte-for-byte in 0.91.1. Version 0.91.2 fixes cache lifetime, bounded metadata/header
retries, original audio alternatives and buffer initialization within that reader.
Keep this architecture until a replacement is validated inside YouTube on the
installed Opera GX profile. Existing server-side seek/audio limitations remain.
Do not delete display snapshots on ordinary history/session writes. Popup and
analysis pages paint the last answer first, then refresh it. Explicit history
wipe clears its snapshots; restore clears all display snapshots. Caches contain
data, not markup, and are excluded from exported settings.

Controllers were removed from active source. Archived code/tests and a short
postmortem live in the working notes, outside the repository. The timestamp action
opening YouTube was explicitly rejected. Localhost embed success does not
validate a youtube.com parent; the restored reader already documents error 152
there. Do not repeat that mistake or call the rollback a new playback guarantee.

**The hover preview is readable for about sixty seconds and no further.**
Measured on 7 October 2026, binary searching the refusal across five videos and
across every format of one of them: 60 to 65 seconds every time, while the byte
boundary moved from 0.8 to 19.7 MB. The cap is a **duration**, so picking a
lighter format buys nothing — do not try it again. Cookies do not lift it,
`alr=yes` does not lift it, and no client returns an HLS or DASH manifest
instead. Seeking past that first minute is therefore impossible without the
attestation token YouTube's own player mints, and the rail shades the unreachable
part from the first frame instead of waiting for a click to fail.

A plain range request is sometimes rejected at the network level rather than
refused with a status, and it is not always the same address: picture can play
while sound never starts. `bytes()` retries that case once with `alr=yes`, which
answered eight times out of eight where the plain form failed six times out of
eight. It must never be trusted blindly: past the readable window `alr=yes`
answers **200 with a `text/plain` address** rather than media, so a text answer
is treated as a refusal and marks the boundary like a 403.

**`null >= 0` is `true`, and it cost the rail its whole gesture.** `withinReach`
read `!(reach >= 0) || seconds < reach`, meant as "no boundary known, everything
allowed". With `reach` at `null` — which is every preview that has not yet been
refused anything, that is to say every fresh one — `null` coerces to zero, the
first half is false, and the second asks `seconds < null`, false for every
instant. **Clicking the rail therefore did nothing at all**, on every video, from
the first frame; it looked like the server's sixty second limit and it was ours.
Both this and `paintReach`, which would have shaded the entire rail for the same
reason, now test with `Number.isFinite`. Do not write `x >= 0` to mean "x is a
number" anywhere near this file.

**Which audio format the edge serves moves from minute to minute, so offer them
all.** The preview came out silent on some videos because `audioCandidates`
threw away the DRC twin of each track — the same sound compressed for a noisy
place, excluded as a duplicate bringing nothing. True of how it sounds, false of
whether it can be fetched. Measured on 7 October 2026 over thirteen videos: three
were silent, and on all three every original non DRC mp4 track failed at the
network level while itag 140 DRC answered 200 with a readable segment map.
Allowing it took the sample to none. Re measured twenty minutes later the pairs
had swapped, so the rule is not "prefer DRC": it is that **no usable format may
be filtered out before the probe has tried it**, only ordered behind the others.
The list holds each track twice because of this, hence four attempts and not
three. The dubbed tracks stay out even as a last resort — English over a French
video is not a better preview than a silent one. WebM Opus stays out too, and no
longer for the reason first written: mixing containers in one `MediaSource` is
accepted by Chromium, measured, but a WebM track indexes itself with Matroska
cues and `readSidx` reads an `sidx` box.

**The sound is asked for one thumbnail at a time, and never carries over.**
Every preview is born muted and stays muted until its own button is pressed;
leaving it and coming back asks again. The choice used to hold for the whole page
once made, on the reasoning that unmuting each thumbnail in turn would be its own
irritation. The user reversed it on 8 October 2026 after living with it: one
click, and every thumbnail the cursor crossed afterwards started talking, which
is exactly what a grid of previews must never do. Do not make it sticky again,
and do not add a setting for it.

**A full size frozen frame has now been tried twice there, and refused twice.**
The storyboards do cover the whole video on a host no refusal touches, so the
part no stream reaches can be shown as a picture — that much is true and stays
true. What was wrong both times is covering the thumbnail with it. The first
version painted it on **hover** and hid playback outright; the second, in
0.93.0, waited for a click past the readable window, which is narrower, and the
user refused it in the same terms as the first: the small carousel scrolling over
a video that goes on playing underneath is the rendering wanted, and a picture
that stops that playback is a loss whatever triggers it. The rail shades what
cannot be reached and the hover box shows the frame aimed at; a click outside
reach does nothing at all, deliberately. Do not propose a third variant.

**Aiming is not scrubbing, and the box needs its own size.** One report — the
stills no longer appear while running across a preview — covered two separate
defects, and fixing either alone changes nothing on screen.

The first was *when*. `is-scrubbing` says the cursor is down in the rail's band,
the only band that moves playback, and the frame was shown on that class alone,
so it existed only during the gesture that already does something else. Aiming
got its own class, `is-aiming`, set as soon as the cursor is anywhere over the
thumbnail; the band keeps `is-scrubbing` and keeps the timestamp on the link,
because a click above the band must open the video where it starts.

The second was *what*. `placeSheet` writes `background-image`, `background-size`
and `background-position` onto an `<i>` and nothing else, and no rule in
`feed-view.css` ever gave that `<i>` a size: an `<i>` is inline, it measured
**158 x 0** with the sheet loaded and correctly positioned, and there was
nothing to see at any cursor position. `.tracktube-scrub i` now carries
`display: block`, `height: 89px` — 158 x 89 is the cell of the storyboard level
YouTube's own player uses on hover, hence `PREVIEW_SHEET_PX` — and
`background-repeat: no-repeat`, which is required and not tidiness: the
background is sized at `columns * 100%` by `rows * 100%` to bring one cell into
view, and the default `repeat` tiles that whole grid, landing a neighbouring
cell in every corner of the box.

**A browser pane that does not paint freezes a transition at its first frame,
and reads as a cascade bug.** Diagnosing the above cost an hour on a false
trail: `getComputedStyle(scrub).opacity` answered `0` while the matching rule
said `1`, the rule was present in both loaded stylesheets, `matches()` was true
and no inline style or `!important` was in the way. The element's
`CSSTransition` had `currentTime` stuck at `0` after seconds of wall clock, with
keyframes reading `0` then `1`: the cascade had always been right and the clock
was not running, because the pane had stopped drawing — a screenshot of it timed
out at the same moment. Read `effect.getKeyframes()` rather than the computed
value when a transition is involved, or call `finish()` first.

**Never let a signed `googlevideo` URL reach the disk or a tool's output.**

---

## Translation

`chrome.i18n` is not used, and that is not an oversight: that API follows the
browser's language, whereas we want the language to be a setting. The catalogues
are ordinary JavaScript modules, statically imported, which work identically in
the worker, the popup and the content scripts.

- Interface built in JavaScript: call `t('key')` at the moment the node is
  created.
- Static HTML pages: the French text stays written in the document and serves as
  the fallback, an attribute carries the key. `data-i18n` for the content,
  `data-i18n-placeholder`, `data-i18n-label` (rendered as `aria-label`),
  `data-i18n-alt`, `data-i18n-value`, and `data-i18n-arg-…` for the values to
  insert. `translateDom()` replaces everything at once after `initLocale()`.
  Nothing is ever injected as HTML: a catalogue therefore cannot introduce a
  tag.
- `data-i18n-title` no longer exists, and `data-i18n-info` no longer does
  either: the browser's grey tooltip is slow and clashes with the page, and an
  explanation nobody sees until they hover is an explanation that has not been
  written. What was only a name became an `aria-label`; the paragraphs that hung
  off the analysis figures are written under them instead. `data-info` survives,
  but only where the script sets it, and only to carry a reading no cell could
  hold: a bar's label and its count, how many openings a mean averages, why a
  dash is a dash. No headline figure has one.

**The two catalogues are at strict parity** and a test checks it: a key added on
one side only makes the suite fail instead of silently falling back on French.

**Trap: some keys are built dynamically** and therefore appear nowhere in plain
text. `t(\`hist.wd.${j}\`)`, `hist.wd1.*`, `hist.step.*` — eighteen keys in all.
A tool looking for orphan keys will report them as dead. They are not.

---

## Testing

No Node, hence no test runner. Two pages, opened in a real browser, plus a few
mock up benches.

Serving the folder:

```bash
cd <the project folder> && python -m http.server 8890 --directory .
```

`tools/serve.ps1` does the same thing in PowerShell, on port 8731.

**`test/preview-playback.html` cannot play under either of them.** The reader
asks for its byte ranges in the query string, `?range=start-end`, and a plain
static server ignores that and returns the whole file for every segment, so
`MediaSource` never gets a usable append and the thumbnail stays on its looping
animation. It is not a regression when that bench shows no video. Serve it with
`python tools/serve-ranges.py <port>`, which honours that parameter, and the
preview plays and can be driven by hand.

| Page | What it checks |
|---|---|
| `test/index.html` | the regression suite, more than 630 assertions, no network |
| `test/modules.html` | that the thirty seven modules really import, which catches broken paths and vanished exports |
| `test/coverage.html` | the collection paths: pagination, caps, truncated feeds, rate limits |
| `test/preview-playback.html` | restored reader, decoded sound, first-row controls and cleanup |
| `test/feed-view-preview.html` | the grid with fake data, inside a mock up of the YouTube shell |
| `test/triage-preview.html` | the triage screen with four characteristic fake channels |
| `test/onboarding-preview.html` | the welcome walkthrough with a fake `chrome` |
| `test/popup-preview.html` | the real popup in an iframe, with a fake `chrome` |
| `test/history-preview.html`, `history-live.html` | the analysis page |
| `test/journal-preview.html` | the detailed history, on a synthetic day holding every case a row can be |
| `test/batch-preview.html`, `watch-tracker.html`, `subscription-probe.html` | the isolated benches |

Three traps that have already cost time.

1. **`localhost` is blocked by the machine's policy. Use `127.0.0.1`.**
2. **`?cb=N` does not bust the ES module cache.** The parameter is honoured for
   the page, not for the modules it imports. To be sure of re reading the changed
   code, **change port** on every run.
3. `test/index.html` and `test/modules.html` must both be green before
   considering a change finished. The first does not detect a module that no
   longer loads, the second does not detect a behaviour regression.
4. **One suite per origin.** The bench pages share an IndexedDB with every other
   page served from the same port. Running `index.html` and then `coverage.html`
   on one port leaves the second reading the first's nine thousand rows, and it
   fails on assertions that have nothing wrong with them. A port per page, not
   merely a fresh port per run.

What can only be checked on the real, signed in account has to be checked by
driving the user's real browser, not by having them paste diagnostics.

---

## Where the data actually lives, and how a rename destroys it

Nothing is stored in this folder. IndexedDB and `chrome.storage` belong to the
browser profile, filed under the extension's **origin**,
`chrome-extension://<id>/`. For an extension loaded unpacked, Chrome derives
that id from the **absolute path of the folder**. Renaming the folder therefore
produces a different id, a different origin, and an empty database — the old one
still sitting in the profile under an id nothing points to any more. It has
already happened once, in August 2026, on a rename that looked harmless. Moving
the folder, or loading the same code from a second copy, has exactly the same
effect.

**No document here names the folder**, and that is deliberate: it has moved
twice, and every absolute path written down became a lie the day it moved.

The remedy is a `key` in `manifest.json`: a base64 RSA public key, from which
Chrome computes the id instead of using the path. With it the extension keeps
its identity wherever the folder goes. **Adding, changing or removing that key
changes the id one last time**, so the sequence is not negotiable: export a
backup first, add the key, reload, restore.

The key generated for this project, and the id it yields, are in the working
notes, outside the repository: a published key would let anyone build an
extension claiming this id.

## Known traps

**Always specify UTF-8 when reading and writing source files.** On this Windows
runtime, Python `Path.read_text()` without an encoding decoded UTF-8 as Windows
1252. Writing that result as UTF-8 corrupted the feed's button glyphs in 0.87.0.
Use explicit encodings, preserve line endings, and run the rendered glyph checks
in `test/shorts-view.html`; compilation alone cannot detect this regression.

**A dead code search has to cover `test/`.** A function was once deleted
wrongly because the search stopped at `src/` while three assertions exercised it:
the suite went red at runtime, not on reading. An export with no caller in `src/`
is not dead until `test/` and the dynamic imports have been looked at.

**Dynamic imports escape naive analyses.** `innertube.js` is loaded by
`await import(chrome.runtime.getURL(…))` from seven places; its exports will look
unused to a tool that only looks for `import` statements at the top of files.

**Two functions bear the same name without being the same function.**
`formatDuration` exists in `feed-view.js` and in the history page: one produces a
clock on a thumbnail, the other a sentence. Do not merge them.

**Atom parsing is done by hand.** `DOMParser` does not exist in an MV3 service
worker, and `decodeEntities` in `util.js` exists for the same reason.

**The repository link is read from the manifest, and hides itself.** The popup's
help panel and the welcome page both carry an `<a class="repo-link">`, wired by
`wireRepoLink()` in `popup.js` and `onboarding.js` from
`chrome.runtime.getManifest().homepage_url`. That is the standard field, Chrome
already shows it on the extensions page, and it leaves one line to change when
the repository moves. While that address still contains `your-account` the link
is not rendered at all: a dead link in a help panel is worse than no link, and
the placeholder is what tells the author the line is still theirs to fill.

**An inline `<script>` in an extension page never runs, and says nothing.**
Manifest V3 applies `script-src 'self'` to extension pages by default, so a
`<script>` with code between its tags is blocked outright: no exception reaches
the page, no handler is installed, and whatever the markup says stays on screen
as though the code had run and chosen that. `privacy.html` carried its language
switch inline, verified over `http://127.0.0.1` where inline scripts do run, and
inside the extension it opened in French with a dead `English` button and the
version number written in the markup rather than the manifest's. The code lives
in `src/pages/privacy.js` now, a classic script and not a module, because that
page is also served on its own for a store listing with nothing of the extension
loaded. The same goes for an `onclick=` attribute. **A page behaves differently
under `chrome-extension://` than under a static server, so a check that only
loaded it over http has not checked it.**

**`popup-guard.js` deliberately has no imports.** It is a classic script: if the
`popup.js` module fails to load, none of its code runs, not even an error
handler. The guard is the only one able to say so. Do not convert it to a module.

---

## Committing

The repository is the folder itself, and the folder is the extension: it is
loaded unpacked from this very path, so the working tree is the running product.
A destructive git command therefore breaks a live installation, not merely a
checkout. No `git clean`, no `reset --hard`, no `checkout --` over a file
somebody is using.

**One commit per finished body of work, not per edit.** A typo, a comment, a
single renamed variable, a version bump on its own: none of those is a commit.
Group the significant changes, run the three suites, and commit the whole of it
once it holds together. The author's reason is simple and worth respecting — a
history of forty commits saying "fix" tells nobody what happened, while one
saying what changed and why is the only readable record of a project this
document exists to explain.

**Commits are made in the name of Claude Code**, per commit and not in the
repository's configuration:

```bash
git -c user.name="Claude Code" -c user.email="noreply@anthropic.com" commit -F <message file>
```

Setting it in `git config` would sign the author's own commits with it too. The
message is written to a file and passed with `-F`: the shell used here must not
be given a heredoc.

**Pushing is the author's decision, never an agent's.** The sequence agreed on
is: they report what they see from using the extension, the fix lands and is
committed, and the push happens when they judge the build stable. Do not push,
do not tag, and do not open a pull request without being asked for it.

The nested clone of 8 October 2026 is excluded through `.git/info/exclude`,
which is local to the checkout and not pushed. `.gitattributes` forces LF
everywhere because `core.autocrlf` is true on the development machine and would
otherwise rewrite every file in the live extension.

---

## Before considering a change finished

1. `test/index.html` and `test/modules.html` green, **on a fresh port**.
2. `fr.js` / `en.js` parity if a key moved.
3. Version bumped in `manifest.json`.
4. `README.md` re read if the described behaviour changed.
5. What the change requires of the user, said explicitly: an F5, or an extension
   reload.
