// Download authorization: the game files on dl.toonvalley.net only download
// with a download token from the login API.
//
//   POST /api/updates/device  (Authorization: Bearer <session_token>)
//        {"name": "Windows PC"}
//   200 {"status", "device_token": "tvd_...", "download_token": "tvdl1....", "expires_in": 7200}
//   401 the session has expired; 403 no Alpha access / blocked
//
//   POST /api/updates/token  {"device_token"}   (no login needed)
//   200 {"status", "username", "download_token", "expires_in": 7200}
//   401 unknown or revoked device; 403 no access any more or blocked
//
//   DELETE /api/updates/device  {"device_token"}   200 always
//
// After a login that can play, this PC is registered as a device. The
// device token is kept encrypted with Electron's safeStorage in the
// launcher's user-data folder, so later starts get download tokens (and
// updates) without logging in. Without real encryption (none available, or
// Linux's "basic_text" fallback, which is a fixed key) it is kept in memory
// only, until the launcher closes. Download tokens are kept in memory only and
// refreshed when less than 10 minutes are left. A 401 or 403 from the token
// endpoint forgets the device. Logging out revokes it and deletes the file.
// No token is ever logged.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const { requestJson, apiMessage } = require('./auth');

const DEVICE_PATH = 'api/updates/device';
const TOKEN_PATH = 'api/updates/token';
const REFRESH_BEFORE_MS = 10 * 60 * 1000;
const MAX_EXPIRES_IN = 7 * 24 * 3600;
const NO_ACCESS = 'Log in with an account that has Alpha access to download the game.';

// "tvd_" and 43 base64url characters, though a little leeway is allowed.
const DEVICE_TOKEN_RE = /^tvd_[A-Za-z0-9_-]{16,256}$/;
// tvdl1.<claims>.<signature>, at most 2048 characters.
const DOWNLOAD_TOKEN_RE = /^tvdl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function deviceName(platform = process.platform) {
  return { win32: 'Windows PC', darwin: 'Mac', linux: 'Linux PC' }[platform] || 'Computer';
}

function validDeviceToken(value) {
  return typeof value === 'string' && DEVICE_TOKEN_RE.test(value);
}

function validDownloadToken(value) {
  return typeof value === 'string' && value.length <= 2048 && DOWNLOAD_TOKEN_RE.test(value);
}

function validExpiresIn(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_EXPIRES_IN) : null;
}

// Why downloads were refused, for players: a 403's own message (no access,
// blocked), otherwise the standard one.
function refusal(status, detail) {
  return { status, message: status === 403 ? apiMessage(detail, NO_ACCESS) : NO_ACCESS };
}

class DownloadAuth {
  // file: where the encrypted device token is kept. safeStorage: Electron's
  // (or a fake in tests); without encryption the token stays in memory.
  constructor({ getBaseUrl, file, safeStorage, now = Date.now, log = () => {}, allowHttp = false, timeoutMs = 60000 }) {
    this.getBaseUrl = getBaseUrl;
    this.file = file;
    this.safeStorage = safeStorage;
    this.now = now;
    this.log = log;
    this.allowHttp = allowHttp;
    this.timeoutMs = timeoutMs;
    this.deviceToken = null;
    this.download = null; // { token, expiresAt }
    this.refreshing = null;
    // Why downloads aren't allowed: { status, message }, after a 401 or 403.
    this.problem = null;
    this.loaded = false;
  }

  request(apiPath, options) {
    const request = this.allowHttp ? http.request : https.request;
    return requestJson(this.getBaseUrl(), apiPath, { timeoutMs: this.timeoutMs, allowHttp: this.allowHttp, ...options }, request);
  }

  // 'real', 'basic_text' (Linux without a keyring "encrypts" with a key
  // every copy of Chromium knows: as good as plain text), or null (none).
  encryption() {
    try {
      if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) return null;
      const backend = typeof this.safeStorage.getSelectedStorageBackend === 'function'
        ? this.safeStorage.getSelectedStorageBackend() : null;
      return backend === 'basic_text' ? 'basic_text' : 'real';
    } catch {
      return null;
    }
  }

  // Whether the device token may be saved to disk.
  canEncrypt() {
    return this.encryption() === 'real';
  }

  // Reads the stored device token, once. One an older launcher saved with
  // only "basic_text" is kept in memory for this session and its file
  // deleted.
  load() {
    if (this.loaded) return this.deviceToken;
    this.loaded = true;
    if (!this.file || !fs.existsSync(this.file)) return null;
    const encryption = this.encryption();
    if (!encryption) {
      this.log('download auth: the saved device key cannot be read here (no encryption available)');
      return null;
    }
    if (encryption === 'basic_text') {
      this.log('download auth: no keyring here, so the saved device key is only kept until the launcher closes; its file was removed');
    }
    try {
      const token = this.safeStorage.decryptString(fs.readFileSync(this.file));
      if (validDeviceToken(token)) {
        this.deviceToken = token;
      } else {
        this.log('download auth: the saved device key is invalid; it was removed');
        this.removeFile();
      }
    } catch {
      this.log('download auth: the saved device key could not be decrypted; it was removed');
      this.removeFile();
    }
    if (encryption === 'basic_text') this.removeFile();
    return this.deviceToken;
  }

  save(token) {
    this.deviceToken = token;
    this.loaded = true;
    if (!this.canEncrypt()) {
      this.log('download auth: encryption is not available (or only basic_text), so this PC is only remembered until the launcher closes');
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, this.safeStorage.encryptString(token), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log(`download auth: could not save the device key (${err.code || 'error'})`);
    }
  }

  removeFile() {
    if (!this.file) return;
    for (const file of [this.file, `${this.file}.tmp`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Gone already, or in use; a bad file is ignored next time anyway.
      }
    }
  }

  hasDevice() {
    return Boolean(this.load());
  }

  setDownloadToken(token, expiresIn) {
    this.download = { token, expiresAt: this.now() + expiresIn * 1000 };
  }

  // Forgets the device (the server said it's revoked, or the account can't
  // download any more).
  forget(status, detail) {
    this.deviceToken = null;
    this.download = null;
    this.loaded = true;
    this.removeFile();
    this.problem = refusal(status, detail);
    this.log(`download auth: the server refused this PC's key (${status}); it was forgotten`);
  }

  // After a login that can play: registers this PC and keeps its device
  // token. Replaces (and revokes) an earlier device token. Never throws;
  // returns true when registered.
  async registerDevice(sessionToken, name = deviceName()) {
    if (!sessionToken) return false;
    const previous = this.load();
    let reply;
    try {
      reply = await this.request(DEVICE_PATH, { method: 'POST', token: sessionToken, body: { name: String(name).slice(0, 60) } });
    } catch (err) {
      this.log(`download auth: could not register this PC (${err.code || 'error'})`);
      return false;
    }
    const { status, body } = reply;
    if (status === 401 || status === 403) {
      this.problem = refusal(status, body && body.detail);
      this.log(`download auth: registering this PC was refused (${status})`);
      return false;
    }
    const expiresIn = body && validExpiresIn(body.expires_in);
    if (status !== 200 || !body || !validDeviceToken(body.device_token) || !validDownloadToken(body.download_token) || !expiresIn) {
      this.log(`download auth: registering this PC failed (${status})`);
      return false;
    }
    this.save(body.device_token);
    this.setDownloadToken(body.download_token, expiresIn);
    this.problem = null;
    this.log('download auth: this PC is registered for updates');
    if (previous && previous !== body.device_token) this.revoke(previous);
    return true;
  }

  // Asks for a new download token with the device token.
  async refresh() {
    const deviceToken = this.load();
    if (!deviceToken) return null;
    let reply;
    try {
      reply = await this.request(TOKEN_PATH, { method: 'POST', body: { device_token: deviceToken } });
    } catch (err) {
      this.log(`download auth: could not get a download token (${err.code || 'error'})`);
      return null;
    }
    const { status, body } = reply;
    if (status === 401 || status === 403) {
      // Unless logging out or a newer device replaced it meanwhile.
      if (this.deviceToken === deviceToken) this.forget(status, body && body.detail);
      return null;
    }
    const expiresIn = body && validExpiresIn(body.expires_in);
    if (status !== 200 || !body || !validDownloadToken(body.download_token) || !expiresIn) {
      this.log(`download auth: getting a download token failed (${status})`);
      return null;
    }
    if (this.deviceToken !== deviceToken) return null;
    this.setDownloadToken(body.download_token, expiresIn);
    this.problem = null;
    return body.download_token;
  }

  // The download token for the patcher, refreshed when less than 10 minutes
  // are left; null when there is none (downloads then go without one).
  async getToken() {
    const current = this.download;
    if (current && current.expiresAt - this.now() > REFRESH_BEFORE_MS) return current.token;
    if (!this.hasDevice()) return current && current.expiresAt > this.now() ? current.token : null;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    const token = await this.refreshing;
    if (token) return token;
    // A network problem: the old token is still good for a while.
    const still = this.download;
    return still && still.expiresAt > this.now() ? still.token : null;
  }

  // At start: a download token from the stored device token, if any.
  async start() {
    if (!this.hasDevice()) return false;
    return Boolean(await this.getToken());
  }

  async revoke(deviceToken) {
    try {
      await this.request(DEVICE_PATH, { method: 'DELETE', body: { device_token: deviceToken } });
    } catch {
      // The server forgets unused devices anyway; nothing more to do here.
    }
  }

  // Logging out: revokes this PC's device token and forgets everything.
  async logout() {
    const deviceToken = this.load();
    this.deviceToken = null;
    this.download = null;
    this.problem = null;
    this.removeFile();
    if (deviceToken) await this.revoke(deviceToken);
  }

  // The message for players when a download was refused.
  refusedMessage() {
    return this.problem ? this.problem.message : NO_ACCESS;
  }
}

module.exports = { DownloadAuth, deviceName, validDeviceToken, validDownloadToken, NO_ACCESS };
