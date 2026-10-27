// Rollback protection: the newest release this launcher has seen, so an
// older signed manifest served again (by whoever controls the update host,
// or a stale cache) is refused instead of taking players back to an older
// release, or keeping them on one.
//
// Each manifest made by tools/publish-patch.js carries "published", the time
// it was made, which only goes up from one release to the next. It is inside
// the signed bytes, so it can't be changed without the signing key. For each
// manifest address (so each platform, and a test server set with
// UPDATE_MANIFEST_URL, counts on its own), the launcher remembers the highest
// "published" it has accepted, in update-releases.json in its user-data
// folder (not the game folder, which Settings can change and players can
// delete). Then:
//   - a manifest with a lower "published" is refused;
//   - the same one again (the same manifest fetched twice) is fine;
//   - once one with "published" has been seen, a manifest without it is
//     refused; before that (releases from before this existed) it is
//     accepted, so the change-over needs nothing from players.
//
// There is no "too old" limit: a release can stay current for months, and a
// launcher that refused it would leave players unable to play until the
// next publish.
const fs = require('fs');
const path = require('path');

class RollbackError extends Error {
  constructor(message) {
    super(message);
    this.code = 'rollback';
  }
}

const ROLLBACK = 'The update server sent an older release than one this launcher has already seen, so it was not used. Try again in a few minutes.';

class ReleaseHistory {
  // file: where the newest "published" for each manifest address is kept.
  // Without one (tests), it is kept in memory only. It is kept in memory
  // too, so a file that can't be saved still counts until the launcher
  // closes.
  constructor(file = null) {
    this.file = file;
    this.memory = {};
  }

  read() {
    const seen = { ...this.memory };
    let data = null;
    try {
      data = this.file ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
    } catch {
      // Nothing recorded yet (or a damaged file, recorded afresh).
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [url, published] of Object.entries(data)) {
        if (Number.isSafeInteger(published) && published > 0 && !(seen[url] >= published)) seen[url] = published;
      }
    }
    return seen;
  }

  write(seen) {
    this.memory = seen;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, this.file);
  }

  // Throws RollbackError if the manifest from url is older than one already
  // accepted from there; otherwise remembers it.
  accept(url, published) {
    const seen = this.read();
    const newest = seen[url] || null;
    if (newest !== null && (published === undefined || published < newest)) throw new RollbackError(ROLLBACK);
    if (published === undefined || published === newest) return;
    seen[url] = published;
    try {
      this.write(seen);
    } catch {
      // Not saved, only remembered until the launcher closes; the next
      // manifest tries again.
    }
  }
}

module.exports = { ReleaseHistory, RollbackError, ROLLBACK };
