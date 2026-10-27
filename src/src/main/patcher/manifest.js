// The update manifest: which release is current and the files it is made of.
//
//   {
//     "schema": 1,
//     "version": "1.0.3",
//     "published": 1760900000000,                                     (optional)
//     "objectsUrl": "https://cdn.example.com/toonvalley/objects/",   (optional)
//     "files": [
//       { "path": "toontown/toonbase/ToontownStart.py", "size": 4120,
//         "sha256": "<64 hex digits>", "url": "https://..." (optional) }
//     ],
//     "removed": ["old/file.py"]                                      (optional)
//     "launcher": { "path": "Launcher.exe", "version": "1.0.1",       (optional)
//                   "size": 75229125, "sha256": "<64 hex digits>" }
//   }
//
// Each file is downloaded from its "url", or from objectsUrl (default: the
// "objects/" folder next to the manifest) at <first 2 hex digits>/<sha256>.
// Naming files by their hash means a release only uploads files that changed,
// and a cache can never serve the wrong version of a file.
//
// "published" is when the release was made (milliseconds since 1970), and
// only ever goes up from one release to the next (tools/publish-patch.js
// makes sure of it). Being inside the signed manifest, it lets the launcher
// refuse an older release served again in place of the latest (rollback.js).
//
// "removed" lists files earlier releases installed that this one no longer
// has. The patcher also removes files it installed itself that the new
// manifest doesn't list, so renames are handled either way. Neither list
// can name the launcher or its uninstaller (paths.js LAUNCHER_FILES).
//
// "launcher" is the current Launcher.exe, which updates itself from it
// (selfupdate.js). It isn't a game file: the game scan never looks at it, so
// a release without it never removes the launcher.
//
// A manifest is only data: nothing in it is run, except a launcher entry,
// which (like every file) must match its SHA-256 in the signed manifest.
const crypto = require('crypto');
const { checkRelativePath, LAUNCHER_FILES } = require('./paths');

const SCHEMA = 1;
const MAX_FILES = 200000;
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad-manifest';
  }
}

function checkHttpsUrl(value, allowHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  return url;
}

// Parses and checks manifest bytes. Throws ManifestError on anything
// unexpected; a manifest that is only partly valid is never used.
function parseManifest(bytes, { allowHttp = false } = {}) {
  let data;
  try {
    data = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes);
  } catch {
    throw new ManifestError('The update information could not be read.');
  }
  const bad = (why) => new ManifestError(`The update information is invalid (${why}).`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('not an object');
  if (data.schema !== SCHEMA) throw bad(`unsupported schema ${JSON.stringify(data.schema)}`);
  if (typeof data.version !== 'string' || !VERSION_RE.test(data.version)) throw bad('bad version');
  if (data.published !== undefined && (!Number.isSafeInteger(data.published) || data.published <= 0)) throw bad('bad published time');
  if (data.objectsUrl !== undefined && !checkHttpsUrl(data.objectsUrl, allowHttp)) throw bad('bad objectsUrl');
  if (!Array.isArray(data.files) || !data.files.length || data.files.length > MAX_FILES) throw bad('bad file list');

  const seen = new Set();
  const files = data.files.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw bad(`file ${i} is not an object`);
    const problem = checkRelativePath(entry.path);
    if (problem) throw bad(`file ${i}: ${problem}`);
    // Windows file names ignore case, so two entries differing only by case
    // would overwrite each other.
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw bad(`file ${i} is listed twice`);
    if (LAUNCHER_FILES.includes(key)) throw bad(`file ${i} is the launcher's own file`);
    seen.add(key);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_SIZE) throw bad(`file ${i} has a bad size`);
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) throw bad(`file ${i} has a bad checksum`);
    if (entry.url !== undefined && !checkHttpsUrl(entry.url, allowHttp)) throw bad(`file ${i} has a bad url`);
    return { path: entry.path, size: entry.size, sha256: entry.sha256, url: entry.url };
  });

  // A file can't be listed as a directory of another (a/b and a/b/c).
  for (const entry of files) {
    const parts = entry.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw bad(`${entry.path} is inside a file`);
    }
  }

  const removed = data.removed === undefined ? [] : data.removed;
  if (!Array.isArray(removed) || removed.length > MAX_FILES) throw bad('bad removed list');
  for (const rel of removed) {
    const problem = checkRelativePath(rel);
    if (problem) throw bad(`removed file: ${problem}`);
    if (seen.has(rel.toLowerCase())) throw bad(`${rel} is both a file and removed`);
    if (LAUNCHER_FILES.includes(rel.toLowerCase())) throw bad(`removed file ${rel} is the launcher's own file`);
  }

  let launcher = null;
  if (data.launcher !== undefined) {
    const entry = data.launcher;
    if (!entry || typeof entry !== 'object') throw bad('bad launcher entry');
    const problem = checkRelativePath(entry.path);
    if (problem || entry.path.includes('/') || !entry.path.toLowerCase().endsWith('.exe')) throw bad('bad launcher path');
    if (seen.has(entry.path.toLowerCase())) throw bad('the launcher is also a game file');
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_FILE_SIZE) throw bad('bad launcher size');
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) throw bad('bad launcher checksum');
    if (entry.version !== undefined && (typeof entry.version !== 'string' || !VERSION_RE.test(entry.version))) throw bad('bad launcher version');
    if (entry.url !== undefined && !checkHttpsUrl(entry.url, allowHttp)) throw bad('bad launcher url');
    if (removed.some((rel) => rel.toLowerCase() === entry.path.toLowerCase())) throw bad('the launcher is also removed');
    launcher = { path: entry.path, size: entry.size, sha256: entry.sha256, version: entry.version, url: entry.url };
  }

  return {
    schema: SCHEMA, version: data.version, published: data.published, objectsUrl: data.objectsUrl, files, removed: [...new Set(removed)], launcher,
  };
}

// Signed manifests: the publisher signs the exact manifest bytes with an
// Ed25519 private key (tools/publish-patch.js --sign-key), and the launcher
// checks the signature, published next to the manifest as <manifest>.sig,
// against the public key in its configuration. Without a configured key no
// signature is required.
function verifySignature(bytes, signatureText, publicKey) {
  if (!publicKey) return;
  let key;
  try {
    key = crypto.createPublicKey(publicKey.includes('BEGIN') ? publicKey : {
      key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki',
    });
  } catch {
    throw new ManifestError("The launcher's update key is invalid. Reinstall the launcher.");
  }
  const signature = Buffer.from(String(signatureText || '').trim(), 'base64');
  let ok = false;
  try {
    ok = signature.length > 0 && crypto.verify(null, bytes, key, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestError('The update information failed its security check, so it was not used.');
}

// The addresses to try for a file, in order: its own url, then objectsUrl,
// then each mirror. All are https.
function fileUrls(entry, manifest, manifestUrl, mirrors = []) {
  if (entry.url) return [entry.url];
  const objectPath = `${entry.sha256.slice(0, 2)}/${entry.sha256}`;
  const bases = [manifest.objectsUrl || new URL('objects/', manifestUrl).href, ...mirrors];
  return [...new Set(bases.map((base) => new URL(objectPath, base.endsWith('/') ? base : `${base}/`).href))];
}

// The update hosts: the origins of the manifest and of each mirror. Only
// these are sent the download token.
function updateOrigins(manifestUrl, mirrors = []) {
  const origins = [];
  for (const value of [manifestUrl, ...mirrors]) {
    try {
      const { origin } = new URL(value);
      if (origin !== 'null' && !origins.includes(origin)) origins.push(origin);
    } catch {
      // Not an address; it gets no token.
    }
  }
  return origins;
}

module.exports = { SCHEMA, ManifestError, parseManifest, verifySignature, fileUrls, checkHttpsUrl, updateOrigins };
