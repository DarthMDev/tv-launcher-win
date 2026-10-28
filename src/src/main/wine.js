// Wine backend for the Linux launcher.
//
// The client is a Windows build (python313.dll + pyds + ToonValley.exe), so on
// Linux it runs through Wine.  The runner is picked in this order, like
// Lutris does it:
//
//   1. Settings' winePath (an explicit runner)
//   2. a system wine64/wine on PATH
//   3. Steam Proton (the Deck's own runner)
//   4. a runner we downloaded into <data>/runners/<name>
//
// The prefix is created under the user's data dir unless Settings names one;
// if that dir is not writable the launcher falls back to its own folder
// (portable installs).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The overrides our own launch recipe uses (see notes/toonvalley-k8s.md and
// the run commands): Proton's bundled d3dcompiler/ffmpeg and a native Vulkan
// are the combination the client boots with.
const WINE_DLL_OVERRIDES =
  'd3dcompiler_47=n,b;ffmpeg=n,b;libEGL=n,b;libGLESv2=n,b;vk_swiftshader=n,b;vulkan-1=n,b;winhttp=n,b';

// How long wineboot may take on a cold prefix.
const WINEBOOT_TIMEOUT_MS = 180000;

// A prefix only has to hold the game's registry and drive mapping; the Mono
// and Gecko installers wineboot would otherwise run are what hang a Proton
// runner on a fresh prefix, and the game needs neither.
const WINEBOOT_DLL_OVERRIDES = 'mscoree=d;mshtml=d';

class WineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function which(name, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function wineVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim() || null;
}

// Steam Proton installs, newest first.
function steamProtonRunners(home = os.homedir()) {
  const roots = [
    path.join(home, '.steam', 'steam', 'steamapps', 'common'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam', 'steamapps', 'common'),
  ];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Proton/i.test(entry.name)) continue;
      const wine = path.join(root, entry.name, 'files', 'bin', 'wine64');
      if (isExecutable(wine)) found.push({ command: wine, source: 'steam-proton', name: entry.name });
    }
  }
  // Proton 9 before Proton Experimental, then any.
  found.sort((a, b) => {
    // Proton 9 is the combination the client is tested with; 8 next, then the
    // rest (Proton 9.0 (Beta) is what Steam calls it on the Deck)
    const rank = (x) => (x.name.startsWith('Proton 9') ? 0 : x.name.startsWith('Proton 8') ? 1 : 2);
    return rank(a) - rank(b);
  });
  return found;
}

// Runners we downloaded ourselves (downloadRunner puts them here).
function downloadedRunners(dataDir) {
  const root = path.join(dataDir, 'runners');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const rel of [['bin', 'wine64'], ['files', 'bin', 'wine64']]) {
      const wine = path.join(root, entry.name, ...rel);
      if (isExecutable(wine)) {
        found.push({ command: wine, source: 'downloaded', name: entry.name });
        break;
      }
    }
  }
  return found;
}

// The runner to use: { command, source, name, version }.
function findWine({ settings = {}, dataDir, home = os.homedir() } = {}) {
  if (settings.winePath) {
    const command = expandHome(settings.winePath);
    if (!isExecutable(command)) {
      throw new WineError('wine-missing', `The Wine runner in Settings was not found: ${command}`);
    }
    return { command, source: 'settings', name: path.basename(command), version: wineVersion(command) };
  }

  const system = which('wine64') || which('wine');
  if (system) {
    return { command: system, source: 'system', name: path.basename(system), version: wineVersion(system) };
  }

  const proton = steamProtonRunners(home);
  if (proton.length) {
    return { ...proton[0], version: wineVersion(proton[0].command) };
  }

  const downloaded = dataDir ? downloadedRunners(dataDir) : [];
  if (downloaded.length) {
    return { ...downloaded[0], version: wineVersion(downloaded[0].command) };
  }

  throw new WineError(
    'wine-missing',
    'Wine was not found. Install Wine, or let the launcher download a runner in Settings.',
  );
}

// The prefix the game is installed in, if any: a game folder under
// <prefix>/drive_c (which is how Wine and Proton installers lay it out) works
// best in the prefix it was installed in -- its registry, drives and any
// runtime it registered are there.  Returns null for a game folder that is
// not inside a prefix.
function gamePrefix(gameDir) {
  let dir = path.resolve(gameDir);
  for (let depth = 0; depth < 10; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, 'drive_c'))) return dir;
  }
  return null;
}

// The Windows prefix: Settings' choice, else the prefix the game is installed
// in, else the user data dir, else the launcher's own folder (portable).  Only the first is created if missing.
function resolvePrefix({ settings = {}, userDataDir, appDir, gameDir, home = os.homedir() } = {}) {
  if (settings.winePrefix) {
    return { dir: expandHome(settings.winePrefix), source: 'settings', create: true };
  }
  if (gameDir) {
    const installed = gamePrefix(gameDir);
    if (installed) return { dir: installed, source: 'game-folder', create: false };
  }
  if (userDataDir) {
    return { dir: path.join(userDataDir, 'prefix'), source: 'user-data', create: true };
  }
  return { dir: path.join(appDir || home, 'prefix'), source: 'app-folder', create: true };
}

function prefixReady(prefixDir) {
  return fs.existsSync(path.join(prefixDir, 'system.reg'));
}

// Create the prefix once (wineboot -u); a missing prefix makes the first
// launch slow but it is the same step a manual setup does.  Asynchronous: the
// launcher window (and its progress text) stays alive while Wine works.
function ensurePrefix(prefixDir, wine, { log = () => {}, timeoutMs = WINEBOOT_TIMEOUT_MS } = {}) {
  if (prefixReady(prefixDir)) return Promise.resolve({ created: false, dir: prefixDir });
  fs.mkdirSync(prefixDir, { recursive: true });
  log(`Creating the Wine prefix in ${prefixDir}`);
  const env = {
    ...process.env,
    WINEPREFIX: prefixDir,
    WINEDEBUG: '-all',
    WINEDLLOVERRIDES: WINEBOOT_DLL_OVERRIDES,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(wine.command, ['wineboot', '-u'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', (c) => { stderr += c.toString().slice(0, 4000); });
    child.stderr.on('data', (c) => { stderr += c.toString().slice(0, 4000); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new WineError('wineboot-failed', `The Wine prefix could not be created: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && prefixReady(prefixDir)) {
        resolve({ created: true, dir: prefixDir });
        return;
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      reject(new WineError(
        'wineboot-failed',
        `Wine could not set up its prefix (exit ${code}).${detail ? ` ${detail}` : ''}`,
      ));
    });
  });
}

// Environment for a Wine launch (the game's own env is merged by the caller).
function wineEnv(prefixDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    WINEPREFIX: prefixDir,
    WINEDLLOVERRIDES: WINE_DLL_OVERRIDES,
    WINEDEBUG: '-all',
  };
}

module.exports = {
  WINE_DLL_OVERRIDES,
  WineError,
  ensurePrefix,
  findWine,
  gamePrefix,
  prefixReady,
  resolvePrefix,
  steamProtonRunners,
  wineEnv,
  wineVersion,
};
