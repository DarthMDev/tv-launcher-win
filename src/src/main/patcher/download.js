// Downloads for the patcher. HTTPS only (plain HTTP only for tests), with
// timeouts, bounded retries, resuming of interrupted files and cancellation.
// A file is only accepted when its size and SHA-256 match the manifest.
//
// Download authorization: getToken() (optional) gives the current download
// token, which is sent as "Authorization: Bearer <token>" only to the
// update hosts in authOrigins (the manifest's and the mirrors' origins). It
// is asked for on every attempt, so a long download picks up a refreshed
// token, and it is never sent to any other origin, including after a
// redirect.
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_REDIRECTS = 5;

class DownloadError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function cancelledError() {
  return new DownloadError('cancelled', 'The update was cancelled.');
}

function describe(url) {
  // For messages and logs: the host and path, never a query string (which
  // could carry an access token).
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'the update server';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// The headers for one request: the download token goes only to the update
// hosts.
function requestHeaders(parsed, headers, token, authOrigins) {
  const out = { 'Accept-Encoding': 'identity', ...headers };
  if (token && authOrigins && authOrigins.includes(parsed.origin)) out.Authorization = `Bearer ${token}`;
  return out;
}

// One GET, following a few redirects. Resolves with the response. Each hop
// decides again whether it gets the download token, so a redirect to
// another origin never sees it.
function get(url, { headers = {}, timeoutMs, signal, allowHttp, token, authOrigins }, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new DownloadError('bad-url', 'The update server address is invalid.'));
    }
    const lib = parsed.protocol === 'https:' ? https : (allowHttp && parsed.protocol === 'http:' ? http : null);
    if (!lib) return reject(new DownloadError('bad-url', 'Updates must be downloaded over https://.'));
    if (signal && signal.aborted) return reject(cancelledError());

    const req = lib.request(parsed, { method: 'GET', headers: requestHeaders(parsed, headers, token, authOrigins), timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new DownloadError('redirects', `Too many redirects from ${describe(url)}.`));
        const next = new URL(res.headers.location, parsed).href;
        return resolve(get(next, { headers, timeoutMs, signal, allowHttp, token, authOrigins }, redirects + 1));
      }
      // The response belongs to the caller now; cancelling still works.
      if (signal) {
        const onAbortResponse = () => res.destroy(cancelledError());
        signal.addEventListener('abort', onAbortResponse, { once: true });
        res.once('close', () => signal.removeEventListener('abort', onAbortResponse));
      }
      resolve(res);
    });
    const onAbort = () => req.destroy(cancelledError());
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.once('timeout', () => req.destroy(new DownloadError('timeout', `${describe(url)} took too long to answer.`, true)));
    req.once('error', (err) => reject(wrapError(err, url)));
    req.end();
  });
}

// Errors writing a download to disk.
const DISK_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS']);

function wrapError(err, url) {
  if (err instanceof DownloadError) return err;
  if (/CERT|SSL|TLS/.test(err.code || '')) {
    return new DownloadError('certificate', `The security certificate of ${describe(url)} could not be verified.`);
  }
  return new DownloadError('network', `Could not reach ${describe(url)} (${err.code || 'network error'}).`, true);
}

function statusError(status, url) {
  // The download gate wants a (valid) download token: retrying won't help.
  if (status === 401 || status === 403) {
    const err = new DownloadError('unauthorized', `${describe(url)} needs a download token (error ${status}).`);
    err.status = status;
    return err;
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  if (status === 404 || status === 410) return new DownloadError('not-found', `${describe(url)} was not found on the update server.`);
  return new DownloadError('http', `The update server answered ${status} for ${describe(url)}.`, retryable);
}

// Retries fn(attempt) on retryable errors, with exponential backoff.
async function withRetries(fn, { retries, signal, baseDelayMs = 500 }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err.code === 'cancelled' || !err.retryable || attempt >= retries) throw err;
      await sleep(Math.min(baseDelayMs * 2 ** attempt, 8000), signal);
    }
  }
}

// Downloads a small text resource (the manifest or its signature).
// A stalled login or device-token refresh must never stop an update check:
// the manifest and the public files answer without a token.
const TOKEN_WAIT_MS = 5000;

function withTokenTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('token wait timed out')), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function currentToken(getToken) {
  if (!getToken) return null;
  try {
    return (await withTokenTimeout(getToken(), TOKEN_WAIT_MS)) || null;
  } catch {
    return null; // Without a token, a public server still answers.
  }
}

async function fetchBytes(url, {
  timeoutMs = 30000, retries = 3, maxBytes = 16 * 1024 * 1024, signal, allowHttp = false, baseDelayMs, getToken, authOrigins,
} = {}) {
  return withRetries(async () => {
    const token = await currentToken(getToken);
    const res = await get(url, { timeoutMs, signal, allowHttp, token, authOrigins });
    if (res.statusCode !== 200) {
      res.resume();
      throw statusError(res.statusCode, url);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        throw new DownloadError('too-large', `${describe(url)} is larger than expected.`);
      }
      chunks.push(chunk);
    }
    if (!res.complete) throw new DownloadError('incomplete', `The download of ${describe(url)} was cut off.`, true);
    return Buffer.concat(chunks);
  }, { retries, signal, baseDelayMs }).catch((err) => {
    throw err instanceof DownloadError ? err : wrapError(err, url);
  });
}

async function hashFile(file, signal, onBytes) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
  const onAbort = () => stream.destroy(cancelledError());
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      if (onBytes) onBytes(chunk.length);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  return hash.digest('hex');
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

// Downloads one file to finalPath (in the staging folder), through partPath.
// An existing partPath is resumed with a Range request. onProgress(bytes) is
// called with how much of this file is downloaded so far.
async function downloadFile({
  urls, size, sha256, partPath, finalPath, timeoutMs = 30000, retries = 3, signal, allowHttp = false, onProgress = () => {}, baseDelayMs,
  getToken, authOrigins,
}) {
  await withRetries(async (attempt) => {
    const url = urls[attempt % urls.length];
    let existing = sizeOf(partPath);
    if (existing > size) {
      fs.rmSync(partPath, { force: true });
      existing = -1;
    }
    const hash = crypto.createHash('sha256');
    if (existing > 0) {
      // Carry the hash over what is already downloaded.
      for await (const chunk of fs.createReadStream(partPath)) hash.update(chunk);
    }
    if (existing === size) {
      if (hash.digest('hex') === sha256) {
        fs.renameSync(partPath, finalPath);
        onProgress(size);
        return;
      }
      fs.rmSync(partPath, { force: true });
      throw new DownloadError('checksum', 'A downloaded file was damaged; downloading it again.', true);
    }
    const start = Math.max(existing, 0);
    onProgress(start);

    const token = await currentToken(getToken);
    const res = await get(url, { headers: start ? { Range: `bytes=${start}-` } : {}, timeoutMs, signal, allowHttp, token, authOrigins });
    let offset = start;
    let fileHash = hash;
    if (res.statusCode === 200) {
      if (start) {
        // The server sent the whole file instead of the rest of it.
        offset = 0;
        fileHash = crypto.createHash('sha256');
        onProgress(0);
      }
    } else if (res.statusCode === 206) {
      const range = /^bytes (\d+)-/.exec(res.headers['content-range'] || '');
      if (!range || Number(range[1]) !== start) {
        res.resume();
        fs.rmSync(partPath, { force: true });
        throw new DownloadError('bad-range', 'The update server sent the wrong part of a file.', true);
      }
    } else {
      res.resume();
      throw statusError(res.statusCode, url);
    }

    let received = offset;
    const check = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > size) {
          callback(new DownloadError('too-large', `${describe(url)} is larger than the update says.`, true));
          return;
        }
        fileHash.update(chunk);
        onProgress(received);
        callback(null, chunk);
      },
    });
    const out = fs.createWriteStream(partPath, { flags: offset ? 'a' : 'w' });
    try {
      await pipeline(res, check, out);
    } catch (err) {
      if (err.code === 'too-large') fs.rmSync(partPath, { force: true });
      // Writing it down failed (a full disk, a folder it may not write
      // to): this computer's problem, not the network's. Passed on as it
      // is, unretried, for the patcher to say so.
      if (DISK_ERRORS.has(err.code)) throw err;
      throw err instanceof DownloadError ? err : wrapError(err, url);
    }
    if (received !== size || !res.complete) {
      // Cut off: keep what arrived and resume on the next try.
      throw new DownloadError('incomplete', `The download of ${describe(url)} was cut off.`, true);
    }
    if (fileHash.digest('hex') !== sha256) {
      fs.rmSync(partPath, { force: true });
      throw new DownloadError('checksum', `A file from ${describe(url)} did not match the update's checksum.`, true);
    }
    fs.renameSync(partPath, finalPath);
  }, { retries, signal, baseDelayMs });
}

module.exports = { DownloadError, fetchBytes, downloadFile, hashFile, sleep, describe };
