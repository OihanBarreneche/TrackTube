/**
 * A ZIP archive, written by hand, with no compression.
 *
 * There is no bundler here and no `node_modules`, so a library is not an
 * option; and nothing is lost by writing it, because the only thing this
 * archive ever carries is PNG files. A PNG is already deflated, so running it
 * through deflate again buys a fraction of a percent for an algorithm that
 * would be a hundred times this file. Every entry therefore goes in **stored**,
 * and the archive weighs the sum of its parts plus about a hundred bytes per
 * file.
 *
 * What the retrospective needs it for: six to ten cards of 1080 x 1350 that one
 * wants in one click. A tall strip of all of them is unreadable and shareable
 * nowhere, a contact sheet halves the type on cards drawn to be read full
 * bleed, and several automatic downloads in a row make Chrome ask. One file
 * with real PNGs inside, named in order, is the shape that answers.
 *
 * No permission is involved: the result is handed over as a blob through an
 * `<a download>`, exactly as the popup's backup has done since `downloads` was
 * dropped in 1.0.0.
 */

/**
 * The CRC32 table, built once.
 *
 * ZIP wants the ordinary CRC32, reflected, polynomial 0xEDB88320. Computing the
 * table beats carrying 256 constants in the source, and it costs a loop of
 * 2048 operations at module load.
 */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC32 of a byte array, as ZIP wants it. */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Date and time in the two sixteen bit words MS-DOS used.
 *
 * Seconds go in by halves, which is why an archive's timestamps are always
 * even, and the year counts from 1980. Both are part of the format and not an
 * approximation on our side.
 */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds the archive.
 *
 * `files` is `[{ name, data }]`, `data` being a `Uint8Array`. The order given is
 * the order stored, which is what makes the cards come out of the archive in
 * the order they were read on screen.
 *
 * The names are encoded as UTF-8 and the flag that says so is set, so an
 * accented name survives. The length written is the length in **bytes**, never
 * in characters: that is the one place where a name outside ASCII silently
 * corrupts an archive.
 */
export function buildZip(files, { date = new Date() } = {}) {
  const stamp = dosStamp(date);
  const encoder = new TextEncoder();

  const entries = files.map((file) => {
    const name = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    return { name, data, crc: crc32(data) };
  });

  const LOCAL = 30;
  const CENTRAL = 46;
  const EOCD = 22;

  const localSize = entries.reduce((s, e) => s + LOCAL + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((s, e) => s + CENTRAL + e.name.length, 0);

  const out = new Uint8Array(localSize + centralSize + EOCD);
  const view = new DataView(out.buffer);
  let at = 0;

  // Local headers, each followed by its bytes.
  for (const entry of entries) {
    entry.offset = at;
    view.setUint32(at, 0x04034B50, true);
    view.setUint16(at + 4, 20, true);        // version needed
    view.setUint16(at + 6, 0x0800, true);    // flags: the name is UTF-8
    view.setUint16(at + 8, 0, true);         // stored
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.data.length, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true);        // no extra field
    at += LOCAL;
    out.set(entry.name, at);
    at += entry.name.length;
    out.set(entry.data, at);
    at += entry.data.length;
  }

  // The central directory, which is what a reader actually walks.
  const centralAt = at;
  for (const entry of entries) {
    view.setUint32(at, 0x02014B50, true);
    view.setUint16(at + 4, 20, true);        // version made by
    view.setUint16(at + 6, 20, true);        // version needed
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.data.length, true);
    view.setUint32(at + 24, entry.data.length, true);
    view.setUint16(at + 28, entry.name.length, true);
    view.setUint16(at + 30, 0, true);        // extra
    view.setUint16(at + 32, 0, true);        // comment
    view.setUint16(at + 34, 0, true);        // first disk
    view.setUint16(at + 36, 0, true);        // internal attributes
    view.setUint32(at + 38, 0, true);        // external attributes
    view.setUint32(at + 42, entry.offset, true);
    at += CENTRAL;
    out.set(entry.name, at);
    at += entry.name.length;
  }

  // End of central directory.
  view.setUint32(at, 0x06054B50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralAt, true);
  view.setUint16(at + 20, 0, true);

  return out;
}
