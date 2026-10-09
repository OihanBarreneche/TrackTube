// Last successful answers, independent of the service worker's lifetime.
// Kept through ordinary updates; explicitly removed on history wipe or restore.
export const UI_SNAPSHOT = Object.freeze({
  state: 'ytfeed:uiState',
  counts: 'ytfeed:uiCounts',
  history: 'ytfeed:histSummary',
  pulse: 'ytfeed:feedPulse',
  highlights: 'ytfeed:uiHighlights',
  stats: 'ytfeed:uiHistoryStats',
});
