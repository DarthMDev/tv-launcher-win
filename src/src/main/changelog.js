// What's new in each launcher version, newest first. After the launcher
// updates itself, its first start shows the notes for the versions since
// the one that ran before (whatsNew below). Add an entry for each release
// published with win32\build_launcher.bat <version>.
const CHANGELOG = [
  {
    version: '2.2.2',
    items: [
      "Updates clear out the game's bin folder: files earlier versions left there, and anything else that isn't part of the game, are removed.",
    ],
  },
  {
    version: '2.2.1',
    items: [
      'The installer asks where to install Toon Valley, so it can go on another drive. Already installed? Run the installer again and pick a new folder: it moves the game there, and nothing downloads again.',
    ],
  },
  {
    version: '2.2.0',
    items: [
      "When Toon Valley is full, Play puts you in line: the launcher shows your place and starts the game by itself when it's your turn. Leave line takes you out.",
      'Faster installs and updates: the launcher downloads 12 files at once instead of 4, the biggest first.',
    ],
  },
  {
    version: '2.1.6',
    items: [
      'Updates just say they\'re downloading files, with how much is left and how fast, instead of naming every game file.',
    ],
  },
  {
    version: '2.1.5',
    items: [
      'The Game server light tells the truth: it turns red ("Down") when the game server is down, even while its door is open.',
      'The server lights keep themselves up to date while the launcher is open, and check again when the game closes.',
      'A full disk during an update is called a full disk, not an internet problem.',
      'Restart after a launcher update always opens the new launcher, even if the launcher was opened again while it was updating.',
      'If the login server is too busy to give your PC a download pass, the launcher tries again and offers Retry, instead of saying your account can\'t download.',
    ],
  },
  {
    version: '2.1.4',
    items: [
      'The launcher always plays on the Toon Valley game server: Settings no longer has a choice of server.',
    ],
  },
  {
    version: '2.1.3',
    items: [
      'The launcher finds the game server by its name, play.toonvalley.net, so it keeps working even if the server moves.',
    ],
  },
  {
    version: '2.1.2',
    items: [
      'Safer updates: the launcher only installs releases newer than the last one it saw, so nobody can take your game back to an older version.',
      'Updates can never remove the launcher itself, and a launcher update is checked once more just before it\'s swapped in.',
    ],
  },
  {
    version: '2.1.1',
    items: [
      'The launcher opens reliably after it updates itself.',
      'Opening the launcher while the game is running brings its window back.',
      'A new Toon Valley icon for the launcher and the game.',
    ],
  },
  {
    version: '2.1.0',
    items: [
      'The new Toon Valley logo, with its Cog gear spinning and its pie wobbling, and the new TV icon.',
      'Your desktop and Start menu shortcuts show the new icon straight after the launcher updates itself.',
    ],
  },
  {
    version: '2.0.0',
    items: [
      'A brand-new launcher: a living Toon Valley, under the sky Toon Valley has right now, with the sun, moon and stars, and the season\'s touches.',
      'The Toontown trolley rides along its track to show your downloads.',
      'News is a Shticker Book: its pages turn by themselves, with a Toon Tip below.',
      'The launcher steps aside while you play, comes back when you finish, and tells you how long you played.',
      'Settings are simpler: choose your server, check for updates, and open your logs.',
      'Shortcuts: Enter to play, F5 to check the servers, Ctrl+, for Settings. The speaker button turns sounds off.',
    ],
  },
  {
    version: '1.3.0',
    items: [
      'Toon Valley is in a closed Alpha: if your account doesn\'t have access yet, the launcher tells you, with a button to your account page.',
      'Enter your Alpha key, or join the Alpha list, at toonvalley.net/account.',
    ],
  },
  {
    version: '1.2.0',
    items: [
      'Join us on Discord: the new button at the bottom.',
      'Report an Issue writes an email to our support team, with your versions already filled in.',
      'Forgot your password? There\'s a link right under the log-in box.',
      'Show your password while you type it, and get a warning when Caps Lock is on.',
      'Read more: open any news post on the website.',
      'Settings: choose between the Game Server and a server on your own computer, without typing addresses.',
    ],
  },
  {
    version: '1.1.0',
    items: [
      'The news board shows the latest news from toonvalley.net.',
      'New links: the Toon Valley website, and Sign Up to make an account.',
      'The launcher now uses toonvalley.net for logging in and for updates.',
    ],
  },
  {
    version: '1.0.9',
    items: [
      'Launcher updates install quietly: no more black command window flashing while the new launcher is put in place.',
    ],
  },
  {
    version: '1.0.8',
    items: [
      'A smaller launcher that starts faster.',
      'Installing and updating the game is quicker and uses less disk.',
      "The launcher's lettering uses Toon Valley's own font.",
    ],
  },
  {
    version: '1.0.7',
    items: [
      'This window: after the launcher updates itself, it tells you what changed.',
    ],
  },
  {
    version: '1.0.6',
    items: [
      'The launcher can update itself on Windows: press Restart when it says a new launcher is ready, or just close it.',
      'Settings shows how far a launcher update has downloaded, and why if it fails.',
      'Updates are checked for as soon as the launcher opens, even if you log in straight away.',
    ],
  },
];

function parseVersion(version) {
  return String(version || '').replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
}

// The notes to show on this start: { version, entries } or null. previous
// is the version that ran before (null if unknown); updated says whether
// this launcher replaced an older one, for when previous is unknown (a
// launcher from before this was recorded).
function whatsNew(previous, current, { updated = false, changelog = CHANGELOG } = {}) {
  if (previous && compareVersions(previous, current) >= 0) return null;
  if (!previous && !updated) return null;
  let entries = changelog.filter((entry) => compareVersions(entry.version, current) <= 0
    && (!previous || compareVersions(entry.version, previous) > 0));
  if (!previous) entries = entries.slice(0, 1);
  if (!entries.length) return null;
  return { version: current, entries };
}

module.exports = { CHANGELOG, compareVersions, whatsNew };
