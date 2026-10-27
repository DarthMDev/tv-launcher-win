// Finds the game client and starts it from the game folder, with GAME_SERVER
// and LOGIN_TOKEN in the environment (read by toontown/launcher/QuickLauncher.py):
// ToonValley.exe in a player's game folder (tools/build_game_exe.py), or, in
// a checkout, `<python> -m toontown.launcher.QuickStartLauncher` the way
// win32/start_game.bat and linux/start-game.sh do.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Files the client needs; their absence means the game folder is wrong or
// incomplete.
const GAME_EXE = { win32: 'ToonValley.exe' };
const EXE_REQUIRED_FILES = [
  ['phase_3.mf', 'the game resources (phase_3.mf)'],
];
const REQUIRED_FILES = [
  ['toontown/launcher/QuickStartLauncher.py', 'the game code (toontown/)'],
  ['otp/launcher/LauncherBase.py', 'the game code (otp/)'],
  ['etc/Configrc.prc', 'the client configuration (etc/Configrc.prc)'],
  ['etc/toon.dc', 'the network definitions (etc/toon.dc)'],
  ['resources/phase_3/models/gui/toonvalley.ico', 'the game resources (resources/)'],
];

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function defaultGameDir({ packaged, appPath, execPath, resourcesPath }) {
  // From source the launcher lives in <game>/launcher. A packaged launcher
  // either carries the game itself (the full installer puts it in
  // resources/game, see tools/make_client_bundle.py) or is installed inside
  // (or next to) the game folder.
  if (!packaged) return path.resolve(appPath, '..');
  const exeDir = path.dirname(execPath);
  const candidates = [exeDir, path.dirname(exeDir), path.resolve(exeDir, '..', '..')];
  if (resourcesPath) candidates.unshift(path.join(resourcesPath, 'game'));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, REQUIRED_FILES[0][0]))) return candidate;
  }
  return exeDir;
}

// The built game's executable in gameDir, or null for a checkout.
function gameExe(gameDir, platform = process.platform) {
  const exe = path.join(gameDir, GAME_EXE[platform] || 'ToonValley');
  return fs.existsSync(exe) ? exe : null;
}

function checkGameFiles(gameDir, platform = process.platform) {
  if (!gameDir || !fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
    return { ok: false, missing: ['the game folder'], message: 'The game folder could not be found. Choose it in Settings.' };
  }
  const required = gameExe(gameDir, platform) ? EXE_REQUIRED_FILES : REQUIRED_FILES;
  const missing = required.filter(([file]) => !fs.existsSync(path.join(gameDir, file))).map(([, what]) => what);
  if (missing.length) {
    return {
      ok: false,
      missing,
      message: `The game folder is missing ${missing.join(', ')}. Check the folder in Settings, or download the game again.`,
    };
  }
  return { ok: true, missing: [] };
}

// The Python that runs the game: the one bundled with the game by the full
// installer, then, as the start scripts do, the venv made by the
// build-Panda3D scripts and the Panda3D SDK path in PPYTHON_PATH.
function findPython(gameDir, override, platform = process.platform) {
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new GameError('python-missing', `The Python program set in Settings was not found: ${override}`);
  }
  if (platform === 'win32') {
    const bundledPython = path.join(gameDir, 'python', 'python.exe');
    if (fs.existsSync(bundledPython)) return bundledPython;
  }
  const venvPython = platform === 'win32'
    ? path.join(gameDir, 'venv', 'Scripts', 'python.exe')
    : path.join(gameDir, 'venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) return venvPython;

  const ppythonFile = path.join(gameDir, 'PPYTHON_PATH');
  if (fs.existsSync(ppythonFile)) {
    let ppython = fs.readFileSync(ppythonFile, 'utf8').trim().replace(/^"(.*)"$/, '$1');
    // A relative path (as in the installer's bundled SDK) is relative to the
    // game folder, as it is for the start scripts.
    if (ppython && !path.win32.isAbsolute(ppython) && !path.isAbsolute(ppython)) {
      ppython = path.join(gameDir, ...ppython.split(/[\\/]/));
    }
    if (ppython && fs.existsSync(ppython)) return ppython;
  }
  throw new GameError(
    'python-missing',
    'Panda3D could not be found. Install the Panda3D SDK (and point PPYTHON_PATH at it) or build it with the build-Panda3D script, or choose Python in Settings.',
  );
}

// What to run: the game's executable, unless Settings names a Python (for a
// checkout), otherwise Python with the game's start module.
function findGameProgram(gameDir, pythonOverride, platform = process.platform) {
  const exe = !pythonOverride && gameExe(gameDir, platform);
  if (exe) return { command: exe, args: [] };
  return { command: findPython(gameDir, pythonOverride, platform), args: ['-m', 'toontown.launcher.QuickStartLauncher'] };
}

// Builds the command without a shell: arguments are passed as a list and
// the login token only travels in the child's environment. program comes
// from findGameProgram; python alone means `<python> -m ...`. gameVersion,
// the installed release, is shown in the game's corner (ToontownStart).
function buildLaunch({ gameDir, program, python, host, port, playToken, gameVersion, baseEnv = process.env }) {
  // PYTHONUNBUFFERED lets the launcher follow the client's progress.
  const env = { ...baseEnv, GAME_SERVER: `${host}:${port}`, LOGIN_TOKEN: playToken, PYTHONUNBUFFERED: '1' };
  if (gameVersion) env.GAME_VERSION = gameVersion;
  else delete env.GAME_VERSION;
  // Never hand the launcher's own overrides or secrets to the client.
  delete env.MONGODB_URI;
  delete env.MONGO_URI;
  return {
    command: program ? program.command : python,
    args: program ? program.args : ['-m', 'toontown.launcher.QuickStartLauncher'],
    options: { cwd: gameDir, env, shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

// Starts the client. onEvent receives { type: 'started' | 'running' | 'exited' | 'error', ... }.
function launchGame(launch, onEvent, spawnFn = spawn) {
  const secret = launch.options.env.LOGIN_TOKEN;
  let child;
  try {
    child = spawnFn(launch.command, launch.args, launch.options);
  } catch (err) {
    throw new GameError('spawn-failed', `The game could not be started (${err.code || err.message}).`);
  }
  let settled = false;
  let tail = '';
  const remember = (chunk) => {
    // Keep the end of the output for error reports, without the login token
    // (the client logs the account name it logs in with).
    tail = redact(tail + chunk.toString(), secret).slice(-4000);
  };
  child.stdout && child.stdout.on('data', remember);
  child.stderr && child.stderr.on('data', remember);
  child.once('spawn', () => {
    onEvent({ type: 'started', pid: child.pid });
    // ToontownStart prints this once it starts the game itself (its detailed
    // log goes to logs/toontown-*.log in the game folder).
    const watch = (chunk) => {
      if (!settled && /ToontownStart: Starting the game/.test(chunk.toString())) {
        settled = true;
        onEvent({ type: 'running' });
      }
    };
    child.stdout && child.stdout.on('data', watch);
  });
  child.once('error', (err) => {
    onEvent({ type: 'error', message: `The game could not be started (${err.code || 'error'}).` });
  });
  child.once('exit', (code, signal) => {
    onEvent({ type: 'exited', code, signal, output: summarizeOutput(tail) });
  });
  return child;
}

function redact(text, secret) {
  return secret ? text.split(secret).join('[token]') : text;
}

// Picks the useful lines out of the client's last output for an error
// message: a Python error or a connection/eject problem.
function summarizeOutput(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) => /Error|Exception|booting us out|Lost connection|Failed to connect|Could not connect/i.test(l));
  return (interesting.length ? interesting : lines).slice(-3).join('\n');
}

// The game folder's bin folder (Python's and Panda3D's libraries and the
// game's code, see tools/build_game_exe.py) is marked hidden on Windows, so
// the folder shows players only the game, its phase files and logs. Hidden
// only hides it from File Explorer's normal view; the game loads it as usual.
const HIDDEN_FOLDERS = ['bin'];

function hideCodeFolders(gameDir, platform = process.platform, run = require('child_process').execFile) {
  if (platform !== 'win32' || !gameDir) return [];
  const hidden = [];
  for (const name of HIDDEN_FOLDERS) {
    const folder = path.join(gameDir, name);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) continue;
    run('attrib', ['+h', folder], { windowsHide: true }, () => {});
    hidden.push(folder);
  }
  return hidden;
}

module.exports = {
  REQUIRED_FILES, GameError, defaultGameDir, gameExe, checkGameFiles, findPython, findGameProgram, buildLaunch, launchGame,
  summarizeOutput, redact, hideCodeFolders,
};
