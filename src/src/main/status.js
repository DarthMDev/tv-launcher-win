// Reachability checks for the status indicators. Neither sends credentials.
const net = require('net');
const tls = require('tls');
const https = require('https');

// How long the game server must keep a connection open, once the TLS
// handshake is done, to count as taking players.
const HOLD_MS = 2000;

// Whether the game server is taking players.
//
// The game port (7198) is the TLS gateway, tools/tls_gateway.py, not Astron
// itself. The gateway accepts every connection and finishes the TLS
// handshake before it tries Astron's client agent; when Astron isn't
// there, it hangs up straight away. So a connection, or even a handshake,
// only says the gateway is running: the light used to say Online whenever
// it was, game server or not.
//
// So this shakes hands, sends nothing, and waits holdMs: Astron, when it's
// there, holds the connection open waiting for the game's hello; when it
// isn't, the gateway closes it at once. Nothing is sent, so Astron logs no
// error for it (only a client that left).
//
// The certificate isn't checked: no credentials or game data go over this
// connection, and the game itself only trusts the server's own certificate
// (otp/distributed/GameServerCert.py), so a check that trusted a different
// one couldn't let anyone in.
function checkGameServer(host, port, timeoutMs = 5000, holdMs = HOLD_MS, connect = tls.connect) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    let holding = null;
    let socket;
    const finish = (online, detail) => {
      if (done) return;
      done = true;
      clearTimeout(holding);
      clearTimeout(giveUp);
      if (socket) socket.destroy();
      resolve({ online, detail, ms: Date.now() - started });
    };
    // Connecting and shaking hands, at most timeoutMs.
    const giveUp = setTimeout(() => finish(false, 'No response'), timeoutMs);
    try {
      socket = connect({
        host,
        port,
        rejectUnauthorized: false,
        // The server name (SNI) only for a name; Node rejects an IP there.
        servername: net.isIP(host) ? undefined : host,
      });
    } catch {
      finish(false, 'Unreachable');
      return;
    }
    socket.once('secureConnect', () => {
      clearTimeout(giveUp);
      holding = setTimeout(() => finish(true, 'Online'), holdMs);
    });
    // Anything the server says first is the game server talking (Astron
    // says nothing until the game's hello, but it would be up).
    socket.once('data', () => finish(true, 'Online'));
    // Closed by the server after the handshake: the gateway is up, but the
    // game server behind it isn't.
    socket.once('end', () => finish(false, holding ? 'Down' : 'No response'));
    socket.once('close', () => finish(false, holding ? 'Down' : 'No response'));
    socket.once('error', (err) => {
      if (holding) finish(false, 'Down');
      else if (err.code === 'ECONNREFUSED') finish(false, 'Connection refused');
      else if (err.code === 'ECONNRESET' || /SSL|TLS|EPROTO/.test(err.code || '')) finish(false, 'No response');
      else finish(false, 'Unreachable');
    });
  });
}

// Whether the login API answers HTTPS at all. Any HTTP status counts as
// reachable; Render free services can take up to a minute to wake up.
function checkLoginApi(baseUrl, timeoutMs = 60000, request = https.request) {
  return new Promise((resolve) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      resolve({ online: false, detail: 'Invalid address', ms: 0 });
      return;
    }
    if (url.protocol !== 'https:') {
      resolve({ online: false, detail: 'Not HTTPS', ms: 0 });
      return;
    }
    const req = request(url, { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json, text/html;q=0.5' } }, (res) => {
      res.resume();
      resolve({ online: res.statusCode < 500, status: res.statusCode, detail: res.statusCode < 500 ? 'Online' : `Error ${res.statusCode}`, ms: Date.now() - started });
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.once('error', (err) => {
      const detail = err.code === 'ETIMEDOUT' ? 'No response' : /CERT|SSL|TLS/.test(err.code || '') ? 'Certificate problem' : 'Unreachable';
      resolve({ online: false, detail, ms: Date.now() - started });
    });
    req.end();
  });
}

module.exports = { checkGameServer, checkLoginApi };
