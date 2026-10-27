// Path rules for patched files. Every path in a manifest is checked here
// before the patcher reads, writes or deletes anything, so a bad or hostile
// manifest can't reach outside the game folder.
const fs = require('fs');
const path = require('path');

// The patcher's own folder inside the game folder (state, journal, staging).
const PATCHER_DIR = '.patcher';

// Things in the game folder that belong to the player, not to a release. The
// patcher never manages, overwrites or deletes them. (errorCode is where the
// game notes how its last run ended: otp/launcher/LauncherBase.py.) Lower
// case: names are compared that way.
const PROTECTED = ['logs', 'screenshots', 'useropt.json', 'settings.ini', 'errorcode', PATCHER_DIR];

// Folders in the game folder that hold only the game's own files (bin:
// Python's and Panda3D's libraries and the compiled game, see
// tools/build_game_exe.py), never the player's. The patcher deletes anything
// in them that the release doesn't list: what earlier releases left there
// (the game's source from before it was compiled, say), whoever put it there.
const GAME_FOLDERS = ['bin'];

// What the installer (installer/ToonValley.nsi) and the launcher's
// self-update (selfupdate.js) keep in the game folder on Windows, next to
// the game. They aren't game files: a manifest can't list them as files or
// remove them, whatever their case.
const LAUNCHER_FILES = ['launcher.exe', 'launcher.exe.old', 'launcher.exe.download', 'launcher.exe.download.part', 'uninstall.exe'];

// Windows device names, which can't be used as file names (with or without an
// extension).
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// Characters Windows doesn't allow in names, control characters, and the
// backslash (manifest paths always use '/').
const BAD_CHARS = /[<>:"|?*\\\x00-\x1f\x7f]/;
const MAX_PATH_LENGTH = 240;

class PathError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad-path';
  }
}

// Returns why a manifest path isn't allowed, or null if it's fine. Paths are
// relative, use '/', and stay inside the game folder.
function checkRelativePath(rel) {
  if (typeof rel !== 'string' || !rel.length) return 'empty path';
  if (rel.length > MAX_PATH_LENGTH) return 'path too long';
  if (BAD_CHARS.test(rel)) return 'path has characters that are not allowed';
  if (rel.startsWith('/')) return 'path is absolute';
  const segments = rel.split('/');
  for (const segment of segments) {
    if (!segment) return 'path has an empty part';
    if (segment === '.' || segment === '..') return 'path leaves its folder';
    if (/[. ]$/.test(segment)) return 'path part ends with a dot or space';
    if (RESERVED_NAMES.test(segment)) return 'path uses a reserved Windows name';
    // Windows also knows long names by a short "8.3" one (LAUNCH~1.EXE for
    // Launcher.exe), which would get round every check on the long name.
    if (/~[0-9]/.test(segment)) return 'path uses a short (8.3) Windows name';
  }
  const top = segments[0].toLowerCase();
  if (PROTECTED.includes(top)) return 'path is player data or the patcher\'s own folder';
  return null;
}

function validateRelativePath(rel) {
  const problem = checkRelativePath(rel);
  if (problem) throw new PathError(`Bad file path in the update (${problem}): ${JSON.stringify(String(rel).slice(0, 80))}`);
  return rel;
}

// The absolute path of rel inside root. Refuses anything that would end up
// outside root, and any symbolic link on the way (an existing link could
// point anywhere).
function safeResolve(root, rel) {
  validateRelativePath(rel);
  const base = path.resolve(root);
  const full = path.resolve(base, ...rel.split('/'));
  if (!full.startsWith(base + path.sep)) throw new PathError(`Bad file path in the update: ${rel}`);
  let current = base;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break; // Doesn't exist yet: nothing below it can be a link.
    }
    if (stat.isSymbolicLink()) throw new PathError(`The game folder has a link where a game file goes: ${rel}`);
  }
  return full;
}

module.exports = { PATCHER_DIR, PROTECTED, GAME_FOLDERS, LAUNCHER_FILES, PathError, checkRelativePath, validateRelativePath, safeResolve };
