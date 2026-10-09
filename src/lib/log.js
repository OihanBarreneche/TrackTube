const PREFIX = '[tracktube]';

/** Levels you can switch on from the console: `tracktubeLog.level = 'debug'`. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export const log = {
  level: 'info',

  _emit(level, args) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const fn = level === 'debug' ? console.debug
      : level === 'info' ? console.info
      : level === 'warn' ? console.warn
      : console.error;
    fn(PREFIX, ...args);
  },

  debug(...a) { this._emit('debug', a); },
  info(...a) { this._emit('info', a); },
  warn(...a) { this._emit('warn', a); },
  error(...a) { this._emit('error', a); },

  /** Times an operation and logs how long it took. */
  async time(label, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.debug(`${label} — ${Math.round(performance.now() - t0)}ms`);
    }
  },
};

// Reachable from the page console and from the service worker console.
if (typeof globalThis !== 'undefined') globalThis.tracktubeLog = log;
