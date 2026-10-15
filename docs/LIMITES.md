# Known limits — 1.4.1

Updated October 15, 2026. What follows is what TrackTube does not promise, and
why. Measurements are dated: they were true on the day they name, on the videos
they name, and YouTube owes nobody stability on any of them.

## Collection

Automatic Atom collection covers only recent entries exposed by YouTube.
It cannot recover publications that fell out of these feeds while the browser
was closed, suspended or repeatedly unable to fetch — but it now notices when
that may have happened: an Atom feed stops at fifteen entries without saying so,
and a read that brings back fifteen entries of which not one is already known
makes the channel's upload playlist be read behind it, a hundred entries in one
request. A channel read for the first time is excluded from that, since
everything is new there by construction.

Live broadcasts are read on the same cadence as ordinary videos since 0.96.0.
Until then a channel whose live feed had once answered empty was not asked again
for a fortnight, and a first broadcast inside that window was missed: measured
on 8 October 2026, `Co7jh46dJ7w` reached the reverse audit that way.

A subscription list read back from YouTube only deactivates channels when it
came back complete. A partial read — an interrupted pagination, a page that
failed — deactivates nothing, because a deactivated channel is no longer swept
and its publications stop arriving silently.

That guard was not enough. A pagination that runs to the end does not prove
YouTube returned every subscription, and a list that came back short, called
itself complete and switched off everything it omitted emptied a real profile:
measured on 14 October 2026, 930 channels known — every one ever seen, left
subscriptions included — of which 592 are real subscriptions and only 116 were
still active. Since
1.2.1 the unattended daily reconciliation also refuses any pass that would
switch off more than a quarter of the active list, and a one-time repair wakes
the channels an earlier bad read had silenced. The guard is on the unattended
path only: a manual import is somebody watching the result, and it takes effect
at once, otherwise it could never prune what the repair over-woke.

Waking channels back up reactivates ones genuinely unsubscribed from. They are
switched off again by the next believable list, after the two observations an
hour apart that confirmation already requires.

The deep read also runs by itself since 1.3.0, a few channels every couple of
minutes while the Subscriptions page is open, taking those whose last deep read
is oldest. Six hundred channels come round in about two and a half hours of
browsing, for roughly 3 MB a pass. It can be turned off in the settings, and the Refresh
button then remains the only way it happens.

YouTube’s own Subscriptions page is a collection source since 1.2.0, and the
only one that sees a publication the moment YouTube does. It carries Shorts and
recommendations, so nothing from it is inserted on the strength of the card: a
channel that is not followed and active is refused outright, a player record
that does not positively say “not a Short” inserts nothing and is retried, and
a video with no known duration is deferred rather than stored where the feed
could never show it. Its reader depends on YouTube’s page markup and can stop
returning anything without failing; the diagnostics say so when it reads no card
at all.

A video is also checked against the followed channels when the grid is drawn,
not only when it is collected: a row outlives the subscription that brought it
in, and nothing from a channel you no longer follow is painted.

Manual refresh reads each active channel's Videos and Live grids for seven days
with an extra day's margin. It is bounded by 1,200 entries and forty pages per
source. It reports incomplete walks, deferred metadata and failed requests.
Older gaps are not recovered by this window alone. The compatibility playlist
fallback is bounded and never certifies a complete time window.

YouTube's internal browse/player APIs, playlist prefixes and page templates are
undocumented dependencies. Rate limits, experiment variants, deleted/private,
age-restricted, region-restricted and members-only videos affect availability.
There is no official exhaustive-upload contract behind this implementation.

## Shorts

`UULF` and `UUSH` can contradict the canonical player classification. The public
case `RJBW_Ad_20A` demonstrated this on October 4, 2026: a confirmed Short was
present in UULF and absent from UUSH.

Confirmed Short exclusions persist and cannot be undone by a provisional
Videos-tab card. Displayed rows with stale classification are checked after
rendering, in bounded batches. Until a check succeeds, an unconfirmed Short
can be visible. Duration is a verification priority, never sufficient evidence
for exclusion; ordinary short videos must remain eligible.

The user requested this previous behaviour on October 7. The later 0.91.3/0.91.4
verification and approval-cache policies are no longer active. Restoring code
does not restore an earlier snapshot of browser data or overwritten titles.

## Dates, metadata and diagnostics

Grid labels give relative, approximate publication times. New approximate rows
can be upgraded by exact RSS/player timestamps, but old rows created before the
flag existed are not automatically migrated. Publication/day counts can therefore
contain date-boundary uncertainty.

Ordinary rows lacking duration are withheld from the main feed. Reverse comparison
reports this unresolved population separately. An absent avatar uses the visual
fallback and does not withhold a publication.

The native subscription feed is itself incomplete. Comparing it with TrackTube
detects observed gaps but cannot prove universal coverage. The historical harvest
is a cumulative observation, not a fresh snapshot of every date. Entries without
date and boundary uncertainty are excluded from the verdict.

The cost display estimates automatic feed requests only, using a fixed average
response size. Enrichment, previews, Shorts checks, manual scans and imports add
traffic. It is neither a network measurement nor a spending cap.

## Hover playback

Version 0.91.2 keeps the 0.89 reader architecture: anonymous IOS metadata and
adaptive H.264/AAC ranges fed to MediaSource. Failed metadata is retried once
per hover, cached stream addresses expire after five minutes, and up to three
supported formats may be tried. AAC LC is preferred over HE AAC. Headers are
validated before creating buffers, so a refused audio track cannot block video
through an empty audio buffer. Leaving a card aborts pending stream requests.
No native-player or iframe replacement is active.

**The readable window is about sixty seconds, and it is a duration.** Measured on
7 October 2026 by binary searching the refusal: 60, 60, 60, 61 and 65 seconds of
picture on five videos, 62 to 65 seconds of sound on the same ones, and 61, 60,
65, 65, 63, 62 seconds across every picture format of one video from 144p to
1080p while the byte boundary moved from 0.8 to 19.7 MB. Beyond it every range
answers 403, with the session as without it, with `alr=yes` as without it, and no
client offers an HLS or DASH manifest instead. So **moving the playhead past that
first minute cannot work**: the bytes are refused by Google, not lost by us. The
rail shades what lies beyond, from the first frame rather than after a click that
fails, and scrubbing still works over the whole video because the storyboards are
separate images no limit touches. Playing from an arbitrary point, as YouTube's
own interface does, needs the attestation token only its player mints — the same
wall as signed `googlevideo` playback.

Sound can fail where picture succeeds, because the two tracks are two files on
two hosts. A plain range request is sometimes rejected at the network level
rather than refused with a status, and version 0.92.0 retries exactly that case
with `alr=yes`, which answered every time where the plain form failed six times
out of eight. That form is never trusted blindly: past the readable window it
answers 200 with a `text/plain` address instead of media, and such an answer is
read as a refusal.

Within that first minute, moving the playhead works — and until version 0.93.0
it did not, for a reason of our own: the guard meant to read "no boundary known,
everything allowed" tested `reach >= 0` on a `reach` of `null`, which JavaScript
coerces to zero, so every click on a fresh preview was refused before a byte was
asked for. Both effects looked identical from the outside.

Past it a click does nothing: the rail shades the unreachable part from the
first frame, and the hover box goes on showing the frame aimed at while playback
continues underneath. A full size frozen frame was tried there and removed — it
stopped the playback one wants to keep watching while scrubbing.

YouTube can still refuse media or byte ranges, and some videos may only expose
the moving thumbnail. Full seeking is not available and universal sound is not
guaranteed.
The “Lire à … sur YouTube” preview action remains removed. The rejected sources and a short postmortem remain in
[the experiment archive](../experiments/preview-2026-10-04/README.md).

## Accounts, history and storage

The database belongs to one browser profile and extension origin. Multi-account
isolation currently fails open when identity is unavailable. Use distinct
browser profiles until that guard is hardened and tested for signed-out,
brand-account and mid-operation account switches.

Tracking is optional and disabled before explicit opt-in. Disabling it stops new
TrackTube records without clearing old ones. Native YouTube playback indicators
can still organise the feed. Takeout contents, deleted videos and unresolved
durations limit historical statistics. A failed historic lookup can be marked
settled, so unknown data must not be interpreted as zero.

Backup exports preserve user choices/history/settings; ordinary feed rows are
recollected after restore. A different extension id, browser profile or Store
installation does not inherit IndexedDB automatically.

## Validation still required

Automated tests use isolated browser contexts and mocked network failures. They
do not validate the installed profile, its 19 reported omissions, several-day
reconciliation, real unsubscribe operations, all Chromium variants or the Store
review process. Release gates are listed in [release preparation](RELEASE.md).
