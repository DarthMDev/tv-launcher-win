// Talks to the login API (login-api/main.py, on Render). Tokens are only ever
// held in memory in the main process; passwords are sent once over HTTPS and
// never logged, and only stored (encrypted, by credentials.js) when the player
// ticks "Remember password".
//
//   POST /api/login  {"username": "...", "password": "..."}
//   200 {"status": "success", "username": "...", "session_token": "...",
//        "session_expires_in": 43200, "can_play": true, ...}
//   401 wrong username or password; 403 the account is blocked (detail says
//   so); 422 missing or non-string fields
//   can_play false: the account has no Alpha access yet (access_message says
//   what to do)
//
//   POST /api/play-token  (Authorization: Bearer <session_token>)
//   200 {"status": "success", "play_token": "...", "expires_in": 300}
//   401 the session has expired; 403 the account has no Alpha access
//   With {"wait_in_line": true}, while the game is full, a place in the
//   line for the game instead (see line.js):
//   200 {"status": "waiting", "position": 3, "playing": 150, "capacity": 150,
//        "check_again_in": 5}
//
//   DELETE /api/play-token/line  (Authorization: Bearer <session_token>)
//   leaves the line.
//
// A play token is good for one game login within a few minutes, so a fresh
// one is fetched each time the game starts. The backend strips and
// lower-cases usernames.
const https = require('https');

class AuthError extends Error {
  // code: 'invalid-credentials' | 'expired' | 'unavailable' | 'server-error' |
  //       'bad-response' | 'not-configured' | 'invalid-input' | 'no-access' |
  //       'blocked'
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const LOGIN_PATH = 'api/login';
const NO_ACCESS = 'No Alpha access yet. Enter your key, or join the Alpha list, on your account page.';
const PLAY_TOKEN_PATH = 'api/play-token';
const LINE_PATH = 'api/play-token/line';

// The API itself puts no rules on usernames, so this only refuses what can't
// be a username at all: nothing, control characters, or something huge.
const USERNAME_RE = /^[^\x00-\x1f\x7f]{1,128}$/;
// Tokens are sent in a header or put in the game's environment, so they
// must be plain printable text.
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return 'Enter your username.';
  }
  if (typeof password !== 'string' || password.length < 1) {
    return 'Enter your password.';
  }
  if (password.length > 256) {
    return 'That password is too long.';
  }
  return null;
}

// POST/GET JSON over HTTPS with certificate checks left on. Resolves with
// { status, body } for any HTTP response; rejects with AuthError for
// network failures. allowHttp is for tests against a local server only.
function requestJson(baseUrl, path, { method = 'GET', body, token, timeoutMs = 60000, allowHttp = false } = {}, request = https.request) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    } catch {
      reject(new AuthError('not-configured', 'The login API address is invalid. Check it in Settings.'));
      return;
    }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      reject(new AuthError('not-configured', 'The login API must use https://.'));
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new AuthError('bad-response', 'The login server sent an unexpected response.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined; // Not JSON.
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.once('timeout', () => req.destroy(new AuthError('unavailable', 'The login server took too long to answer. It may be starting up; try again in a minute.')));
    req.once('error', (err) => {
      if (err instanceof AuthError) {
        reject(err);
      } else if (/CERT|SSL|TLS/.test(err.code || '')) {
        reject(new AuthError('unavailable', "The login server's security certificate could not be verified."));
      } else {
        reject(new AuthError('unavailable', 'The login server could not be reached. Check your internet connection.'));
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Maps an HTTP error status to a user-facing error.
function errorForStatus(status) {
  if (status === 401 || status === 403) return new AuthError('invalid-credentials', 'Incorrect username or password.', status);
  if (status === 429) return new AuthError('server-error', 'Too many login attempts. Wait a moment and try again.', status);
  if (status >= 500) return new AuthError('server-error', 'The login server had a problem. Try again later.', status);
  return new AuthError('server-error', `The login server refused the request (error ${status}).`, status);
}

// The API's own message (a 403's detail), if it is a short plain string.
function apiMessage(message, fallback) {
  return typeof message === 'string' && message.trim() && message.length <= 300 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(message) ? message : fallback;
}

// The account can log in but not play (no Alpha access): the API's own
// message if it sent one.
function noAccess(message, status) {
  return new AuthError('no-access', apiMessage(message, NO_ACCESS), status);
}

function badResponse() {
  return new AuthError('bad-response', 'The login server sent an unexpected response. Try again later.');
}

// The session from a successful login response: { username, sessionToken,
// expiresInSeconds }.
function parseLoginResponse(body) {
  if (!body || typeof body !== 'object' || body.status !== 'success'
      || typeof body.username !== 'string' || !USERNAME_RE.test(body.username)
      || typeof body.session_token !== 'string' || !TOKEN_RE.test(body.session_token)
      || !Number.isInteger(body.session_expires_in) || body.session_expires_in <= 0) {
    throw badResponse();
  }
  return { username: body.username, sessionToken: body.session_token, expiresInSeconds: body.session_expires_in };
}

// The play token from a successful /api/play-token response.
function parsePlayTokenResponse(body) {
  if (!body || typeof body !== 'object' || body.status !== 'success'
      || typeof body.play_token !== 'string' || !TOKEN_RE.test(body.play_token)) {
    throw badResponse();
  }
  return body.play_token;
}

// A place in line from a /api/play-token response: { position, playing,
// capacity, checkAgainIn }, or null when it isn't one.
function parseWaitingResponse(body) {
  if (!body || typeof body !== 'object' || body.status !== 'waiting') return null;
  const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (!whole(body.position, 1, 1e7) || !whole(body.playing, 0, 1e7) || !whole(body.capacity, 1, 1e7)
      || !whole(body.check_again_in, 1, 300)) {
    throw badResponse();
  }
  return { position: body.position, playing: body.playing, capacity: body.capacity, checkAgainIn: body.check_again_in };
}

class AuthClient {
  constructor(getBaseUrl, request = https.request, now = Date.now) {
    this.getBaseUrl = getBaseUrl;
    this.request = request;
    this.now = now;
    this.session = null; // { username, sessionToken, expiresAt }
  }

  async login(username, password) {
    const invalid = validateCredentials(username, password);
    if (invalid) throw new AuthError('invalid-input', invalid);
    this.session = null;
    const { status, body } = await requestJson(this.getBaseUrl(), LOGIN_PATH, {
      method: 'POST',
      body: { username: username.trim(), password },
    }, this.request);
    if (status === 401) throw new AuthError('invalid-credentials', 'Incorrect username or password.', status);
    // A blocked account (only said after the right password).
    if (status === 403) throw new AuthError('blocked', apiMessage(body && body.detail, 'This account has been blocked.'), status);
    if (status === 422) throw new AuthError('invalid-input', "The login server didn't accept that username or password.", status);
    if (status !== 200) throw errorForStatus(status);
    const { username: name, sessionToken, expiresInSeconds } = parseLoginResponse(body);
    if (body.can_play === false) throw noAccess(body.access_message);
    this.session = { username: name, sessionToken, expiresAt: this.now() + expiresInSeconds * 1000 };
  }

  // A fresh play token for one game login.
  async getPlayToken() {
    return parsePlayTokenResponse(await this.askForPlayToken());
  }

  // A play token ({ token }), or, while the game is full, this player's
  // place in line ({ waiting }, see parseWaitingResponse).
  async requestTurn() {
    const body = await this.askForPlayToken({ wait_in_line: true });
    const waiting = parseWaitingResponse(body);
    return waiting ? { waiting } : { token: parsePlayTokenResponse(body) };
  }

  async askForPlayToken(request) {
    if (this.session && this.now() >= this.session.expiresAt) this.session = null;
    if (!this.session) throw new AuthError('expired', 'Your login has expired. Please log in again.');
    const { status, body } = await requestJson(this.getBaseUrl(), PLAY_TOKEN_PATH, {
      method: 'POST',
      token: this.session.sessionToken,
      body: request,
    }, this.request);
    if (status === 401) {
      this.session = null;
      throw new AuthError('expired', 'Your login has expired. Please log in again.', status);
    }
    if (status === 403) throw noAccess(body && body.detail, status);
    if (status !== 200) throw errorForStatus(status);
    return body;
  }

  // Leaves the line. (A launcher that stops asking leaves it anyway, a
  // minute or so later, so a failure here doesn't matter.)
  async leaveLine() {
    const token = this.getSessionToken();
    if (!token) return;
    try {
      await requestJson(this.getBaseUrl(), LINE_PATH, { method: 'DELETE', token, timeoutMs: 10000 }, this.request);
    } catch {
      // As above.
    }
  }

  logout() {
    this.session = null;
  }

  getUsername() {
    return this.session ? this.session.username : null;
  }

  // For registering this PC for updates right after logging in. Stays in
  // the main process.
  getSessionToken() {
    if (this.session && this.now() >= this.session.expiresAt) this.session = null;
    return this.session ? this.session.sessionToken : null;
  }
}

module.exports = {
  AuthClient, AuthError, validateCredentials, requestJson, errorForStatus, parseLoginResponse, parsePlayTokenResponse,
  parseWaitingResponse, apiMessage, TOKEN_RE,
};
