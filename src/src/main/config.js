// Launcher settings: the defaults in config/default.json, overridden by the
// user's saved settings, overridden by environment variables (for testers
// and server admins). The game server is always config/default.json's:
// nothing saved or set can point the launcher at another. Nothing secret is
// stored here.
const fs = require('fs');
const path = require('path');

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'default.json'), 'utf8'));

// Settings the user may change. The server addresses aren't among them:
// the game server is config/default.json's, with no choice of another.
const EDITABLE = ['gameDir', 'pythonPath', 'rememberUsername', 'username'];

// Environment overrides, e.g. LOGIN_API_URL=https://login.example.com npm start.
// (Not the game server's address: the launcher only plays on the game server.)
const ENV_OVERRIDES = {
  LOGIN_API_URL: 'loginApiUrl',
};

// A hostname or IPv4 address. The client splits GAME_SERVER on ';' to get a
// list of servers, so anything besides letters, digits, dots and dashes is
// rejected.
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function validateHost(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host.trim())) {
    return 'Enter a server address such as play.example.com or 192.0.2.10.';
  }
  return null;
}

function validatePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return 'The port must be a number from 1 to 65535.';
  }
  return null;
}

function validateApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter the login API address, starting with https://.';
  }
  if (parsed.protocol !== 'https:') {
    return 'The login API must use https://.';
  }
  if (parsed.username || parsed.password) {
    return 'The login API address must not contain a username or password.';
  }
  return null;
}

// The "updates" block of the configuration (see PATCHING.md). Returns a
// clean copy, or null when updates are turned off or misconfigured (with the
// reason in .problem).
function updatesConfig(settings) {
  const updates = settings.updates || {};
  if (!updates.manifestUrl) return null;
  const isHttps = (value) => {
    try {
      const url = new URL(String(value).replace(/\{(platform|arch)\}/g, 'x'));
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  const clamp = (value, low, high, fallback) => (Number.isInteger(value) ? Math.min(high, Math.max(low, value)) : fallback);
  if (!isHttps(updates.manifestUrl)) return { problem: 'updates.manifestUrl must be an https:// address' };
  const mirrors = Array.isArray(updates.mirrors) ? updates.mirrors : [];
  if (!mirrors.every(isHttps)) return { problem: 'updates.mirrors must be https:// addresses' };
  return {
    manifestUrl: updates.manifestUrl,
    mirrors,
    concurrency: clamp(updates.concurrency, 1, 16, 12),
    timeoutMs: clamp(updates.timeoutSeconds, 5, 300, 30) * 1000,
    retries: clamp(updates.retries, 0, 10, 3),
    publicKey: typeof updates.publicKey === 'string' ? updates.publicKey.trim() : '',
  };
}

// A folder or program chosen in Settings: a full path, of sensible length,
// without control characters. (The Python program is run, so nothing odd
// gets in from the page.)
function validLocalPath(value) {
  return typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f]/.test(value)
    && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function validateSettings(settings) {
  const errors = {};
  const host = validateHost(settings.gameServerHost);
  if (host) errors.gameServerHost = host;
  const port = validatePort(settings.gameServerPort);
  if (port) errors.gameServerPort = port;
  const api = validateApiUrl(settings.loginApiUrl);
  if (api) errors.loginApiUrl = api;
  if (settings.gameDir !== undefined && settings.gameDir !== '' && !validLocalPath(settings.gameDir)) {
    errors.gameDir = 'Choose the folder the game is in.';
  }
  if (settings.pythonPath !== undefined && settings.pythonPath !== '' && !validLocalPath(settings.pythonPath)) {
    errors.pythonPath = 'Choose the Python program that runs the game.';
  }
  if (typeof settings.username === 'string' && settings.username.length > 128) errors.username = 'That username is too long.';
  return errors;
}

function normalize(settings) {
  const out = { ...settings };
  if (typeof out.gameServerHost === 'string') out.gameServerHost = out.gameServerHost.trim();
  if (out.gameServerPort !== undefined) out.gameServerPort = Number(out.gameServerPort);
  if (typeof out.loginApiUrl === 'string') out.loginApiUrl = out.loginApiUrl.trim().replace(/\/+$/, '');
  if (typeof out.gameDir === 'string') out.gameDir = out.gameDir.trim();
  if (typeof out.pythonPath === 'string') out.pythonPath = out.pythonPath.trim();
  out.rememberUsername = Boolean(out.rememberUsername);
  if (typeof out.username !== 'string' || !out.rememberUsername) out.username = '';
  return out;
}

class Config {
  constructor(settingsFile, env = process.env) {
    this.settingsFile = settingsFile;
    this.env = env;
    this.saved = this.readSaved();
  }

  readSaved() {
    try {
      const data = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      const saved = {};
      for (const key of EDITABLE) {
        if (key in data) saved[key] = data[key];
      }
      // Older launchers saved the server addresses, or a choice of server
      // (the game server or one on this computer): neither is used now.
      return saved;
    } catch {
      return {};
    }
  }

  envOverrides() {
    const overrides = {};
    for (const [name, key] of Object.entries(ENV_OVERRIDES)) {
      if (this.env[name]) overrides[key] = this.env[name];
    }
    // UPDATE_MANIFEST_URL points the patcher at another update server.
    if (this.env.UPDATE_MANIFEST_URL) {
      overrides.updates = { ...DEFAULTS.updates, manifestUrl: this.env.UPDATE_MANIFEST_URL };
    }
    return overrides;
  }

  get() {
    const merged = normalize({
      gameDir: '',
      pythonPath: '',
      rememberUsername: false,
      username: '',
      ...DEFAULTS,
      ...this.saved,
    });
    // For testers and server admins: these win over everything, but the
    // game server's address is always the default one.
    return normalize({
      ...merged,
      ...this.envOverrides(),
      gameServerHost: DEFAULTS.gameServerHost,
      gameServerPort: DEFAULTS.gameServerPort,
    });
  }

  // Validates and saves the user's changes; returns { ok, errors, settings }.
  update(changes) {
    const picked = {};
    for (const key of EDITABLE) {
      if (key in changes) picked[key] = changes[key];
    }
    const candidate = normalize({ ...this.get(), ...picked });
    const errors = validateSettings(candidate);
    if (Object.keys(errors).length) {
      return { ok: false, errors, settings: this.get() };
    }
    // Environment overrides stay out of the saved file.
    const merged = normalize({ ...DEFAULTS, ...this.saved, ...picked });
    const toSave = {};
    for (const key of EDITABLE) {
      if (key in merged) toSave[key] = merged[key];
    }
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(toSave, null, 2));
    this.saved = toSave;
    return { ok: true, errors: {}, settings: this.get() };
  }

  reset() {
    try {
      fs.unlinkSync(this.settingsFile);
    } catch {
      // Nothing saved yet.
    }
    this.saved = {};
    return this.get();
  }
}

module.exports = { Config, DEFAULTS, validateHost, validatePort, validateApiUrl, validateSettings, normalize, updatesConfig };
