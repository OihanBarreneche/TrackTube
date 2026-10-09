/**
 * Script injected into the MAIN world of the YouTube page.
 *
 * Why a separate world: YouTube is a Polymer application. An element's real
 * data (`channelId`, duration, playback progress) lives in the `.data` property
 * of its custom elements, not in the DOM. A content script in the isolated
 * world sees the DOM but not those properties. We therefore need a foot in the
 * page's own context.
 *
 * This script only ever *reads* and forwards. All the logic and every access to
 * the extension APIs stay in the isolated world, which treats whatever arrives
 * from here as untrusted data — the page could forge these messages.
 */

(() => {
  'use strict';

  const CHANNEL_TO_ISOLATED = 'tracktube-main';
  const CHANNEL_FROM_ISOLATED = 'tracktube-iso';

  function post(type, payload) {
    window.postMessage({ source: CHANNEL_TO_ISOLATED, type, payload }, window.location.origin);
  }

  // -------------------------------------------------------------------------
  // Extraction
  // -------------------------------------------------------------------------

  /** "12:34" or "1:02:03" → seconds. */
  function parseDuration(text) {
    if (!text) return null;
    const parts = String(text).trim().split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }

  /**
   * "il y a 3 jours" / "3 days ago" → approximate epoch ms.
   *
   * Deliberately coarse: this value only serves the rare videos the native feed
   * shows and RSS has not seen. Everywhere else the exact date comes from the
   * Atom feed, and we never overwrite it with this.
   */
  function parseRelativeTime(text) {
    if (!text) return null;
    const m = /(\d+)\s*([^\s]+)/.exec(String(text));
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();

    const SECOND = 1000, MINUTE = 60e3, HOUR = 3600e3, DAY = 86400e3;
    const table = [
      [/^(seconde|second)/, SECOND],
      [/^(minute)/, MINUTE],
      [/^(heure|hour)/, HOUR],
      [/^(jour|day)/, DAY],
      [/^(semaine|week)/, 7 * DAY],
      [/^(mois|month)/, 30 * DAY],
      [/^(an|ann[ée]e|year)/, 365 * DAY],
    ];
    for (const [re, ms] of table) {
      if (re.test(unit)) return Date.now() - n * ms;
    }
    return null;
  }

  const textOf = (node) =>
    node?.simpleText ?? node?.runs?.map((r) => r.text).join('') ?? null;

  const bestThumb = (thumbnail) => {
    const list = thumbnail?.thumbnails;
    if (!Array.isArray(list) || !list.length) return '';
    return list[list.length - 1].url ?? '';
  };

  /** Playback progress, if YouTube shows it on the thumbnail. */
  function watchProgressOf(renderer) {
    const overlays = renderer?.thumbnailOverlays;
    if (!Array.isArray(overlays)) return null;
    for (const o of overlays) {
      const pct = o?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched;
      if (typeof pct === 'number') return Math.min(1, Math.max(0, pct / 100));
    }
    return null;
  }

  /**
   * Normalises a `videoRenderer` / `richItemRenderer` into a video record.
   * Returns null if the element is not a usable video.
   */
  function extractVideo(renderer) {
    if (!renderer) return null;
    const vr = renderer.videoRenderer
      ?? renderer.richItemRenderer?.content?.videoRenderer
      ?? renderer.content?.videoRenderer
      ?? (renderer.videoId ? renderer : null);
    if (!vr?.videoId) return null;

    // Shorts must never enter the database, not even through this path: they
    // are rendered by a distinct renderer, and we rule them out explicitly.
    if (renderer.reelItemRenderer || renderer.shortsLockupViewModel) return null;

    const channelId =
      vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      ?? vr.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      ?? vr.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      ?? null;
    if (!channelId) return null;

    // Broadcasts come from the `UULV` feed, but that one does not say which are
    // ongoing: an Atom feed carries neither a "live" badge nor a start time.
    // The native feed is the only source for those two states, hence the
    // importance of identifying them formally rather than by deduction.
    const isLive = Boolean(
      vr.badges?.some((b) => b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW'),
    );

    const startSeconds = Number(vr.upcomingEventData?.startTime);
    const isUpcoming = Number.isFinite(startSeconds) && startSeconds > 0;

    return {
      id: vr.videoId,
      channelId,
      channelTitle: textOf(vr.ownerText) ?? textOf(vr.longBylineText) ?? '',
      title: textOf(vr.title) ?? '',
      publishedAt: parseRelativeTime(textOf(vr.publishedTimeText)),
      thumbUrl: bestThumb(vr.thumbnail),
      // The channel avatar, which the initial import does not always get.
      channelAvatar: bestThumb(
        vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail
        ?? vr.channelThumbnail,
      ),
      durationSec: parseDuration(textOf(vr.lengthText)),
      watchProgress: watchProgressOf(vr),
      isLive,
      isUpcoming,
      // `startTime` is in seconds; the rest of the project thinks in
      // milliseconds.
      scheduledAt: isUpcoming ? startSeconds * 1000 : null,
    };
  }

  /** Known containers of a video thumbnail, old and new. */
  const CONTAINER_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
  ].join(',');

  /** Duration read from the thumbnail badge, whatever the template. */
  function durationTextIn(box) {
    if (!box) return null;
    const candidates = box.querySelectorAll(
      'ytd-thumbnail-overlay-time-status-renderer #text,'
      + '.badge-shape-wiz__text,'
      + '.ytThumbnailOverlayBadgeViewModelHost span,'
      + 'badge-shape div',
    );
    for (const c of candidates) {
      const t = c.textContent.trim();
      if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(t)) return t;
    }
    return null;
  }

  /** The red progress bar YouTube draws on videos already started. */
  function progressIn(box) {
    if (!box) return null;
    const bar = box.querySelector(
      'ytd-thumbnail-overlay-resume-playback-renderer #progress,'
      + '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
    );
    if (!bar) return null;
    const pct = parseFloat(bar.style.width);
    return Number.isFinite(pct) ? Math.min(1, pct / 100) : null;
  }

  /** Publication date visible in a card when Polymer data is unavailable. */
  function publishedAtIn(box) {
    if (!box) return null;
    const candidates = box.querySelectorAll(
      '#metadata-line span, .inline-metadata-item, .yt-content-metadata-view-model__metadata-text',
    );
    for (const candidate of candidates) {
      const publishedAt = parseRelativeTime(candidate.textContent?.trim());
      if (publishedAt) return publishedAt;
    }
    return null;
  }

  function titleIn(box, anchor) {
    const title = box?.querySelector(
      '#video-title, #video-title-link, h3 a, .yt-lockup-metadata-view-model__title',
    );
    return title?.getAttribute('title')?.trim()
      || title?.textContent?.trim()
      || anchor?.getAttribute('title')?.trim()
      || '';
  }

  function channelTitleIn(box) {
    const channel = box?.querySelector(
      '#channel-name a, ytd-channel-name a, .yt-content-metadata-view-model__metadata-row a',
    );
    return channel?.textContent?.trim() || '';
  }

  /**
   * Harvests the videos currently rendered.
   *
   * Two passes, deliberately in this order:
   *
   * 1. The DOM. A `/watch?v=` link is the most stable thing YouTube has — it
   *    survives every component overhaul. This pass is enough for the audit,
   *    which only marks videos already known from the feeds.
   * 2. The Polymer data, when the structure is recognised. It adds the
   *    `channelId` and the title, which is what makes it possible to insert a
   *    video the feeds would not have seen. If YouTube changes its renderers we
   *    lose that enrichment, but pass 1 keeps working.
   *
   * Shorts are naturally absent: they use `/shorts/` links.
   */
  function harvestFeedVideos() {
    const scope = document.querySelector('ytd-browse:not([hidden])')
      ?? document.querySelector('#primary')
      ?? document.body;

    const byId = new Map();

    for (const a of scope.querySelectorAll('a[href*="/watch?v="]')) {
      let id = null;
      try { id = new URL(a.href, location.origin).searchParams.get('v'); } catch { /* exotic href */ }
      if (!id || byId.has(id)) continue;

      const box = a.closest(CONTAINER_SELECTOR) ?? a.parentElement;
      byId.set(id, {
        id,
        title: titleIn(box, a),
        channelTitle: channelTitleIn(box),
        publishedAt: publishedAtIn(box),
        durationSec: parseDuration(durationTextIn(box)),
        watchProgress: progressIn(box),
      });
    }

    const domCount = byId.size;
    let enriched = 0;

    for (const el of scope.querySelectorAll(CONTAINER_SELECTOR)) {
      const video = extractVideo(el.data ?? el.__data?.data);
      if (!video) continue;
      const prev = byId.get(video.id);
      byId.set(video.id, {
        ...video,
        durationSec: video.durationSec ?? prev?.durationSec ?? null,
        watchProgress: video.watchProgress ?? prev?.watchProgress ?? null,
      });
      enriched++;
    }

    return { videos: [...byId.values()], domCount, enriched };
  }

  /**
   * Harvests the subscription list rendered on /feed/channels.
   *
   * The avatar is looked up first in the Polymer data, then straight in the
   * DOM. That second path matters: depending on how YouTube renders the page,
   * `thumbnail` can be missing from the data while the image is displayed just
   * fine. Without this fallback, we imported 900 channels without a single
   * avatar.
   */
  function harvestChannels() {
    const out = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('ytd-channel-renderer')) {
      const d = el.data ?? el.__data?.data;
      const channelId = d?.channelId
        ?? d?.navigationEndpoint?.browseEndpoint?.browseId
        ?? null;
      if (!channelId || !/^UC[\w-]{22}$/.test(channelId) || seen.has(channelId)) continue;
      seen.add(channelId);

      out.push({
        id: channelId,
        title: textOf(d.title) ?? el.querySelector('#channel-title')?.textContent?.trim() ?? '',
        avatarUrl: bestThumb(d.thumbnail) || avatarFromDom(el),
      });
    }

    return out;
  }

  /** Avatar read off the image actually rendered, whatever the template. */
  function avatarFromDom(el) {
    for (const img of el.querySelectorAll('img')) {
      const src = img.currentSrc || img.src;
      // Channel avatars are served by these two hosts; the test avoids catching
      // a video thumbnail or a tracking pixel.
      if (src && /(^https?:)?\/\/(yt3|lh\d)\.(ggpht|googleusercontent)\.com\//.test(src)) return src;
    }
    return '';
  }

  /** True as long as YouTube still has subscriptions left to load. */
  function hasMoreToLoad() {
    return Boolean(document.querySelector('ytd-continuation-item-renderer'));
  }

  // -------------------------------------------------------------------------
  // Subscription state of the displayed channel
  // -------------------------------------------------------------------------

  /**
   * Reads the current page's channel and the state of its subscribe button.
   *
   * Serves to spot a new subscription the moment it is made, without asking the
   * user for anything: the subscription list is otherwise only re-read on
   * import, so a channel just subscribed to would not show up in the feed until
   * the next manual import.
   *
   * The state is never deduced from the button label. A first attempt did just
   * that, and got it wrong: YouTube writes "S’abonner" with a typographic
   * apostrophe, which the comparison missed, so that a mere visitor was taken
   * for a subscriber. Adding channels one is not subscribed to is far worse
   * than detecting nothing — the manual import is still there to catch up. We
   * therefore only conclude on a structural signal.
   *
   * The first version aimed at one precise Polymer path and found nothing on
   * the current template: it abstained every single time, silently. Hence the
   * multiple sources below, and the `source` returned along with the state —
   * without it, a failed detection is indistinguishable from a channel one is
   * not subscribed to.
   */
  /** Elements liable to carry the subscription state, across all templates. */
  const SUBSCRIBE_SELECTOR = [
    'ytd-subscribe-button-renderer',
    'yt-subscribe-button-view-model',
    '#subscribe-button',
    '#subscribe-button-shape',
  ].join(', ');

  /**
   * Areas holding *the page's* subscribe button, by priority.
   *
   * This scoping is indispensable, and its absence cost two fixes for nothing.
   * A channel page contains nine `ytd-subscribe-button-renderer` — those of the
   * shelves and thumbnails, which concern other channels and carry their own
   * state. Querying the whole document amounted to reading whichever came
   * first: the answer was "not subscribed", always, whatever the real state of
   * the displayed channel.
   */
  const SUBSCRIBE_SCOPES = [
    // Channel page header, from the tightest to the widest. The container name
    // has already changed several times; knowing only one amounts to detecting
    // nothing at all the day YouTube changes it.
    'yt-flexible-actions-view-model',
    'yt-page-header-view-model',
    'yt-page-header-renderer',
    '#page-header',
    'ytd-c4-tabbed-header-renderer',
    // Video page.
    'ytd-watch-metadata',
    '#owner',
    'ytd-video-owner-renderer',
  ];

  /** The notification bell, which only ever accompanies followed channels. */
  const BELL_SELECTOR = [
    'ytd-subscription-notification-toggle-button-renderer',
    'ytd-subscription-notification-toggle-button-renderer-next',
    'yt-subscription-notification-toggle-button-view-model',
    '#notification-preference-button',
  ].join(', ');

  /**
   * The page's subscribe button, and the area containing it.
   *
   * Empty containers are ruled out: a channel page leaves several of them
   * behind, leftovers of an older template, and taking them for buttons led to
   * concluding "not subscribed" without having read anything.
   */
  function findSubscribeButton() {
    const usable = (el) => el.tagName.includes('-') || el.querySelector('button');

    for (const selector of SUBSCRIBE_SCOPES) {
      for (const scope of document.querySelectorAll(selector)) {
        const el = [...scope.querySelectorAll(SUBSCRIBE_SELECTOR)].find(usable);
        if (el) return { el, scope };
      }
    }

    const all = [...document.querySelectorAll(SUBSCRIBE_SELECTOR)].filter(usable);

    // No known area. The recent template only uses `yt-subscribe-button-view-
    // model` for the page's main button — the shelves, for their part, render
    // `ytd-subscribe-button-renderer`. When there is only one, there is
    // therefore no ambiguity about what it designates.
    const viewModels = all.filter((el) => el.tagName.toLowerCase() === 'yt-subscribe-button-view-model');
    if (viewModels.length === 1) return { el: viewModels[0], scope: viewModels[0] };

    // Last resort: the first in the document. That is the header's, which is
    // rendered before the content. Staying silent here would be worse — it is
    // precisely what made channel pages mute when no area matched.
    return all.length ? { el: all[0], scope: all[0] } : null;
  }

  /**
   * The state read from the button's styling.
   *
   * On channel pages, the button no longer carries any data: it is a bare
   * `<button>`. What changes between the two states, and reads without
   * depending on the language, is YouTube's design system class — `Tonal` for
   * the discreet "Subscribed" button, `Filled` for the "Subscribe" call to
   * action. The label is translated and therefore unusable.
   */
  function readButtonStyle(root) {
    const button = root.matches?.('button') ? root : root.querySelector('button');
    if (!button) return null;
    const classes = String(button.className);
    if (/ytSpecButtonShapeNextTonal\b/.test(classes)) return true;
    if (/ytSpecButtonShapeNextFilled\b/.test(classes)) return false;
    return null;
  }

  /**
   * Looks for a boolean under this name, as close to the root as possible.
   *
   * Breadth first on purpose: YouTube regularly moves the state one notch down
   * the structure (`data.subscribed` became
   * `data.subscribeButtonViewModel.subscribed`, then something else). Aiming at
   * an exact path amounts to rewriting this code at every overhaul; looking for
   * the shallowest value survives it. The node budget bounds the cost.
   */
  function findBoolean(root, key, maxDepth = 5, maxNodes = 500) {
    if (!root || typeof root !== 'object') return null;
    const seen = new Set();
    const queue = [[root, 0]];
    let visited = 0;

    while (queue.length && visited < maxNodes) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited++;

      if (typeof node[key] === 'boolean') return node[key];
      if (depth >= maxDepth) continue;

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') queue.push([value, depth + 1]);
      }
    }
    return null;
  }

  /** Channel id of the current page, in order of reliability. */
  function readChannelId() {
    const attempts = [
      () => {
        const owner = document.querySelector('ytd-video-owner-renderer, ytd-channel-owner-renderer');
        return (owner?.data ?? owner?.__data?.data)?.navigationEndpoint?.browseEndpoint?.browseId;
      },
      // The page's button, never another. Sweeping the whole document brought
      // back the `channelId` of whichever shelf came first: the subscription
      // would have been credited to a channel that asked for nothing.
      () => {
        const el = findSubscribeButton()?.el;
        const data = el?.data ?? el?.__data?.data;
        return data?.channelId ?? data?.subscribeButtonViewModel?.channelId ?? null;
      },
      () => /^\/channel\/(UC[\w-]{22})/.exec(location.pathname)?.[1],
      // The channel page's Polymer data. Live, unlike the two sources that
      // follow: on a `/@handle` address reached by internal navigation, neither
      // `ytInitialData` nor the `meta` tag is replaced, and they still describe
      // the previous page. We were then reading one channel's button state
      // under another channel's id, which took still followed channels out of
      // the feed.
      () => {
        const browse = document.querySelector('ytd-browse[page-subtype="channels"]');
        const data = browse?.data ?? browse?.__data?.data;
        return data?.metadata?.channelMetadataRenderer?.externalId
          ?? data?.header?.pageHeaderRenderer?.channelId ?? null;
      },
      () => window.ytInitialData?.metadata?.channelMetadataRenderer?.externalId,
      () => document.querySelector('meta[itemprop="channelId"]')?.content,
      () => document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]')
        ?.getAttribute('href')?.slice(9),
      () => window.ytInitialPlayerResponse?.videoDetails?.channelId,
    ];

    for (const attempt of attempts) {
      let id = null;
      try { id = attempt(); } catch { /* unexpected shape: on to the next */ }
      if (typeof id === 'string' && /^UC[\w-]{22}$/.test(id)) return id;
    }
    return null;
  }

  function readSubscription() {
    const channelId = readChannelId();
    if (!channelId) return { channelId: null, subscribed: null, source: null };

    const found = findSubscribeButton();

    // No identifiable subscribe button: we fall back on the state shipped with
    // the page. That source is frozen — it does not reflect the clicks made
    // since — so it says which state we arrive in, not what changes.
    if (!found) {
      const initial = findBoolean(window.ytInitialData?.header, 'subscribed', 6);
      return typeof initial === 'boolean'
        ? { channelId, subscribed: initial, source: 'initial' }
        : { channelId, subscribed: null, source: null };
    }

    const { el, scope } = found;

    // 1. The boolean from the Polymer data. It is the only source that tells
    //    "not subscribed" apart from "not loaded yet", hence the only one worth
    //    anything.
    const state = findBoolean(el.data ?? el.__data?.data, 'subscribed');
    if (typeof state === 'boolean') return { channelId, subscribed: state, source: 'data' };

    // 2. The attribute Polymer reflects onto the element, when it reflects it.
    if (el.hasAttribute('subscribed')) return { channelId, subscribed: true, source: 'attr' };

    // 3. The button styling, the only signal on current channel pages.
    const style = readButtonStyle(el);
    if (typeof style === 'boolean') return { channelId, subscribed: style, source: 'style' };

    // 4. The bell, looked up in the same area as the button: document wide
    //    there is always one somewhere, which made us answer "subscribed" on
    //    any page at all.
    if (scope.querySelector(BELL_SELECTOR)) {
      return { channelId, subscribed: true, source: 'bell' };
    }

    // The button is there but mute: no data, no attribute, no styling, no bell.
    // That is what a not yet hydrated button gives just as much as a
    // "Subscribe" button, and nothing tells them apart.
    //
    // We used to answer "not subscribed", counting on the isolated world to see
    // only a change in it. That was not enough: two successive readings in that
    // state confirmed the unsubscription to one another, and the channel was
    // taken out of the feed along with its videos. A real unsubscription always
    // reads through the button styling or through the data, and whatever would
    // still slip through is caught by the daily reconciliation.
    return { channelId, subscribed: null, source: 'absence' };
  }

  /**
   * Ids of the `/feed/channels` rows, in DOM order.
   *
   * The isolated world sees these rows but not their `channelId`, which lives
   * in the Polymer data. Without this correspondence, applying unsubscriptions
   * would not know which row to click — and clicking the wrong row, here, is
   * unrecoverable. The rank in the DOM is the link: it is re-read before each
   * unsubscription, since a row that disappears shifts all the following ones.
   */
  function channelRowIds() {
    return [...document.querySelectorAll('ytd-channel-renderer')].map((row) => {
      const data = row.data ?? row.__data?.data;
      return data?.channelId
        ?? data?.navigationEndpoint?.browseEndpoint?.browseId
        ?? row.querySelector('a[href^="/channel/"]')?.getAttribute('href')?.slice(9)
        ?? null;
    });
  }

  /** The main player, not to be confused with the hover preview. */
  function mainPlayer() {
    const el = document.getElementById('movie_player');
    return typeof el?.getVideoData === 'function' ? el : null;
  }

  /**
   * The `videoDetails` blocks the page exposes, freshest first.
   *
   * `ytInitialPlayerResponse` describes the page **as it was served** and is not
   * replaced by internal navigations: after a click on a suggested video it
   * still describes the previous one. That is measured, not assumed. The data
   * of the `watch` page component, for its part, follows the navigation, and
   * the player itself always knows what it is playing — including in miniplayer
   * mode, where the URL no longer speaks of the video.
   */
  function videoDetailsCandidates() {
    const flexy = document.querySelector('ytd-watch-flexy');
    return [
      flexy?.playerData?.videoDetails,
      flexy?.__data?.playerData?.videoDetails,
      window.ytInitialPlayerResponse?.videoDetails,
      window.ytplayer?.config?.args?.raw_player_response?.videoDetails,
    ].filter((d) => d?.videoId);
  }

  /** Shapes a `videoDetails` block the way the isolated world expects it. */
  function shapeDetails(d) {
    const seconds = Number(d.lengthSeconds);
    return {
      videoId: d.videoId,
      title: typeof d.title === 'string' ? d.title : null,
      channelId: /^UC[\w-]{22}$/.test(d.channelId ?? '') ? d.channelId : null,
      channelTitle: typeof d.author === 'string' ? d.author : null,
      durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    };
  }

  /**
   * The report on the video currently playing.
   *
   * The title, the channel and the real duration are worth more than what the
   * DOM lets us guess, where the displayed title is sometimes truncated. Still,
   * they must describe the right video: the id check rules out the sources left
   * behind on the previous one.
   *
   * When no complete source answers, the player decides on its own. It does not
   * know the channel id, but a titled session without a channel is infinitely
   * better than a mute one: the extension finds the channel back in its own
   * database, where the video is almost always known already.
   */
  function readVideoDetails(expected) {
    for (const d of videoDetailsCandidates()) {
      if (expected && d.videoId !== expected) continue;
      return shapeDetails(d);
    }

    const gvd = mainPlayer()?.getVideoData?.();
    if (!gvd?.video_id) return null;
    if (expected && gvd.video_id !== expected) return null;

    const duration = Number(mainPlayer()?.getDuration?.());
    return {
      videoId: gvd.video_id,
      title: typeof gvd.title === 'string' ? gvd.title : null,
      channelId: null,
      channelTitle: typeof gvd.author === 'string' ? gvd.author : null,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  }

  /**
   * What the player is playing at the moment we ask.
   *
   * The URL is not enough to know: in miniplayer mode, playback continues while
   * one browses the rest of the site, and the `v` parameter is long gone. The
   * player, for its part, always answers.
   *
   * `adShowing` counts as much as the rest: during an advertisement, it is the
   * ad's duration the player returns, and taking it for the video's is enough
   * to declare a barely opened video watched in full.
   */
  function playerNow() {
    const p = mainPlayer();
    const gvd = p?.getVideoData?.();
    const videoId = typeof gvd?.video_id === 'string' && gvd.video_id ? gvd.video_id : null;
    return {
      videoId,
      adShowing: Boolean(p?.classList?.contains('ad-showing')),
      details: videoId ? readVideoDetails(videoId) : null,
    };
  }

  /**
   * What it takes to talk to YouTube's internal API.
   *
   * `ytcfg` only exists in the page's world; the isolated world, for its part,
   * has the cookies and the right to talk to the service worker. Hence this
   * hand off.
   */
  function innertubeConfig() {
    const cfg = window.ytcfg?.data_ ?? window.ytcfg?.get?.() ?? {};
    return {
      key: cfg.INNERTUBE_API_KEY ?? null,
      context: cfg.INNERTUBE_CONTEXT ?? null,
      sessionIndex: cfg.SESSION_INDEX ?? 0,
      loggedIn: cfg.LOGGED_IN === true,
      // Identifies the account, and the active channel when it is a brand
      // channel. See `src/lib/account.js` for what we do with it and why.
      datasyncId: typeof cfg.DATASYNC_ID === 'string' ? cfg.DATASYNC_ID : null,
    };
  }

  /**
   * Just enough to know whom the session belongs to.
   *
   * Kept apart from the full configuration: the isolated world asks the question
   * on every navigation, and it does not need the whole Innertube context
   * handed over for that.
   */
  function signedInAccount() {
    const { loggedIn, datasyncId, sessionIndex } = innertubeConfig();
    return { loggedIn, datasyncId, sessionIndex };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Describes what the page exposes of its subscription state.
   *
   * YouTube does not serve the same template to everyone, and least of all the
   * same to a visitor as to a signed in account: the subscription state is
   * plainly absent from pages seen signed out. It is therefore impossible to
   * guess from the outside where it hides once signed in. This function makes
   * the question verifiable in one command, instead of leaving it to guesswork.
   *
   *   __ytFeedDiag()
   */
  window.__ytFeedDiag = function ytFeedDiag() {
    const tags = [...new Set([...document.querySelectorAll('*')]
      .map((el) => el.tagName.toLowerCase())
      .filter((t) => /subscri|notification/.test(t)))];

    const found = findSubscribeButton();
    const zone = found?.scope ?? document.body;

    const actions = [...zone.querySelectorAll('button')].slice(0, 6).map((b) => ({
      aria: b.getAttribute('aria-label'),
      classes: String(b.className).replace(/ytSpecButtonShapeNext/g, ''),
      text: b.textContent.trim().slice(0, 24),
    }));

    const result = {
      path: location.pathname,
      channel: readChannelId(),
      reading: readSubscription(),
      // The button retained and its area: this scoping is what was missing, and
      // its absence made us read a completely different channel's button.
      buttonUsed: found ? `${found.scope.tagName.toLowerCase()} > ${found.el.tagName.toLowerCase()}` : null,
      documentCandidates: document.querySelectorAll(SUBSCRIBE_SELECTOR).length,
      subscriptionTags: tags,
      // Dropped by the isolated world after each report to the service worker.
      lastReport: (() => {
        try { return JSON.parse(sessionStorage.getItem('ytfeed:lastReport') ?? 'null'); }
        catch { return null; }
      })(),
      bellInArea: Boolean(found && found.scope.querySelector(BELL_SELECTOR)),
      bellInPage: Boolean(document.querySelector(BELL_SELECTOR)),
      actions,
    };
    console.log('[tracktube] diagnostics', result);
    return result;
  };

  // -------------------------------------------------------------------------
  // Requests coming from the isolated world
  // -------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== CHANNEL_FROM_ISOLATED) return;

    switch (msg.type) {
      case 'harvest-feed':
        post('feed-videos', { ...harvestFeedVideos(), requestId: msg.requestId });
        break;
      case 'harvest-channels':
        post('channels', {
          channels: harvestChannels(),
          hasMore: hasMoreToLoad(),
          requestId: msg.requestId,
        });
        break;
      case 'read-subscription':
        post('subscription', { ...readSubscription(), requestId: msg.requestId });
        break;
      case 'channel-rows':
        post('channel-rows', { ids: channelRowIds(), requestId: msg.requestId });
        break;
      case 'video-details':
        post('video-details', {
          ...(readVideoDetails(msg.videoId) ?? {}), requestId: msg.requestId,
        });
        break;
      case 'player-now':
        post('player-now', { ...playerNow(), requestId: msg.requestId });
        break;
      case 'innertube-config':
        post('innertube-config', { ...innertubeConfig(), requestId: msg.requestId });
        break;
      case 'account':
        post('account', { ...signedInAccount(), requestId: msg.requestId });
        break;
      default:
        break;
    }
  });

  // Tells the isolated world the bridge is ready, and tells it again on every
  // SPA navigation: YouTube never reloads the page.
  const announce = () => post('ready', { path: location.pathname });
  announce();
  document.addEventListener('yt-navigate-finish', announce);
  document.addEventListener('yt-page-data-updated', announce);
})();
