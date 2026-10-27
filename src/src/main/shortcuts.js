// After the launcher has updated itself, Windows can go on showing the old
// launcher's icon on its shortcuts: Explorer keeps each program's icon in a
// cache and doesn't look again just because the file changed. This points
// the launcher's shortcuts (on the desktop and in the Start menu) at the
// icon in the new Launcher.exe, which makes Explorer read it again, and asks
// Windows to refresh its icon cache.

const fs = require('fs');
const path = require('path');

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// The .lnk files in folder (not its subfolders) that open exePath.
function shortcutsTo(folder, exePath, shell) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.lnk')) continue;
    const file = path.join(folder, name);
    try {
      const link = shell.readShortcutLink(file);
      if (link.target && samePath(link.target, exePath)) found.push(file);
    } catch {
      // Not a shortcut Windows can read; leave it alone.
    }
  }
  return found;
}

// Points every shortcut to exePath in folders at exePath's own icon, then
// refreshes Windows' icon cache. Returns the shortcuts it updated.
// shell is Electron's shell; spawn is child_process.spawn.
function refreshShortcutIcons({ exePath, folders, shell, spawn, log = () => {} }) {
  const updated = [];
  for (const folder of folders) {
    for (const file of shortcutsTo(folder, exePath, shell)) {
      try {
        if (shell.writeShortcutLink(file, 'update', { icon: exePath, iconIndex: 0 })) updated.push(file);
      } catch (err) {
        log(`couldn't refresh the icon of ${file}: ${err.message}`);
      }
    }
  }
  try {
    // Windows' own tool for this; it shows no window and is quick.
    const child = spawn('ie4uinit.exe', ['-show'], { detached: true, stdio: 'ignore', windowsHide: true });
    // A missing or blocked ie4uinit comes as an event, after this returns;
    // unheard, it would be an uncaught error in the launcher.
    child.on('error', (err) => log(`couldn't refresh the icon cache: ${err.message}`));
    child.unref();
  } catch (err) {
    log(`couldn't refresh the icon cache: ${err.message}`);
  }
  return updated;
}

// Where Windows keeps the launcher's shortcuts: the player's desktop and
// Start menu (the installer puts one in each).
function shortcutFolders(app, env = process.env) {
  const folders = [app.getPath('desktop')];
  if (env.APPDATA) folders.push(path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return folders;
}

module.exports = { refreshShortcutIcons, shortcutFolders, shortcutsTo };
