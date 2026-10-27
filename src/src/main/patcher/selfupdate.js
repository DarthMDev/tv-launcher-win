// Updates Launcher.exe itself from the update manifest's "launcher" entry
// (tools/publish-patch.js --launcher). The manifest is signed and the file
// is checked against its SHA-256 like every game file.
//
// The new launcher is downloaded next to the running one, as
// Launcher.exe.download. Where the running file can be renamed, it becomes
// Launcher.exe.old and the new one takes its name straight away; the next
// start deletes the .old copy. The portable Launcher.exe on Windows keeps
// itself locked while it runs (renaming it fails with EBUSY), so there the
// swap waits: finishOnExit() starts a small script that, once this launcher
// has exited, moves the new file into place (and starts it, for Restart).
// The download is checked against its SHA-256 again just before that script
// starts, as it may have waited there since the download, and the script
// goes in a folder of its own with a name nobody can guess.
//
// A launcher entry whose version is lower than this launcher's is never
// installed (an older build published by mistake, say); one without a
// version is compared by its checksum only. Older manifests as a whole are
// refused before this (rollback.js).
//
// The download gate lets the launcher's own file through without a download
// token (so old launchers can update), but the token is sent anyway when
// there is one, only to the update hosts, like the patcher does.
//
// Only the portable Launcher.exe (npm run dist:portable) updates itself:
// electron-builder tells it where its file is in PORTABLE_EXECUTABLE_FILE.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { fileUrls, updateOrigins } = require('./manifest');
const { downloadFile, hashFile } = require('./download');
const { compareVersions } = require('../changelog');

// The SHA-256 of a file, without waiting: finishOnExit runs while the
// launcher quits.
function hashFileSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

class SelfUpdater {
  // currentVersion: this launcher's version (app.getVersion()). spawnScript
  // starts the swap script (replaced in tests).
  constructor({
    exePath, mirrors = [], timeoutMs = 30000, retries = 3, allowHttp = false, baseDelayMs, log = () => {}, getToken = null, currentVersion = null,
    spawnScript = spawn,
  }) {
    this.exePath = exePath;
    this.spawnScript = spawnScript;
    this.currentVersion = currentVersion;
    this.refusedOlder = null;
    this.getToken = getToken;
    this.mirrors = mirrors;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.allowHttp = allowHttp;
    this.baseDelayMs = baseDelayMs;
    this.log = log;
    this.running = null;
    this.installed = null;
    // The downloaded launcher, when it couldn't replace the running one yet.
    this.pendingSwap = false;
    this.swapScheduled = false;
  }

  get oldPath() { return `${this.exePath}.old`; }
  get downloadPath() { return `${this.exePath}.download`; }

  // Deletes the copy left by the last update (it was still running then).
  cleanUp() {
    for (const file of [this.oldPath, `${this.downloadPath}.part`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Still in use (an old launcher is running); next time.
      }
    }
  }

  // The manifest's launcher entry when it differs from the running file,
  // and isn't an older version than it.
  async needed(manifest) {
    const entry = manifest && manifest.launcher;
    if (!entry || !this.exePath) return null;
    if (this.installed === entry.sha256) return null;
    if (entry.version && this.currentVersion && compareVersions(entry.version, this.currentVersion) < 0) {
      if (this.refusedOlder !== entry.sha256) {
        this.refusedOlder = entry.sha256;
        this.log(`launcher update: the release's launcher is ${entry.version}, older than this one (${this.currentVersion}), so it is not installed`);
      }
      return null;
    }
    let st;
    try {
      st = fs.statSync(this.exePath);
    } catch {
      return null;
    }
    if (st.size === entry.size && await hashFile(this.exePath) === entry.sha256) return null;
    return entry;
  }

  // Downloads and swaps in the manifest's launcher if it is different.
  // Returns its version once installed (used from the next start), or null.
  // Runs once at a time. onProgress(bytesDone, bytesTotal) follows the
  // download.
  update(manifest, onProgress = () => {}) {
    this.onProgress = onProgress;
    if (!this.running) {
      this.running = this.doUpdate(manifest).finally(() => { this.running = null; });
    }
    return this.running;
  }

  async doUpdate(manifest) {
    const entry = await this.needed(manifest);
    if (!entry) return null;
    this.log(`launcher update to ${entry.version || entry.sha256.slice(0, 12)}: downloading`);
    const download = this.downloadPath;
    // A download from an earlier start whose swap didn't happen.
    const ready = fs.existsSync(download) && fs.statSync(download).size === entry.size
      && await hashFile(download) === entry.sha256;
    if (!ready) await downloadFile({
      urls: fileUrls(entry, manifest, manifest.url, this.mirrors),
      size: entry.size,
      sha256: entry.sha256,
      partPath: `${download}.part`,
      finalPath: download,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      allowHttp: this.allowHttp,
      baseDelayMs: this.baseDelayMs,
      onProgress: (bytesDone) => this.onProgress(bytesDone, entry.size),
      getToken: this.getToken,
      authOrigins: updateOrigins(manifest.url, this.mirrors),
    });
    // downloadFile verified it; check again in case something touched it.
    if (await hashFile(download) !== entry.sha256) {
      fs.rmSync(download, { force: true });
      throw new Error('The downloaded launcher was damaged.');
    }
    const name = entry.version || entry.sha256.slice(0, 12);
    fs.rmSync(this.oldPath, { force: true });
    try {
      fs.renameSync(this.exePath, this.oldPath);
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      // Locked while it runs: swap once it has exited (finishOnExit).
      this.installed = entry.sha256;
      this.pendingSwap = true;
      this.log(`launcher update to ${name} downloaded; it replaces this one when the launcher closes`);
      return entry.version || 'new';
    }
    try {
      fs.renameSync(download, this.exePath);
    } catch (err) {
      // Put the running launcher back so there is always a Launcher.exe.
      fs.renameSync(this.oldPath, this.exePath);
      throw err;
    }
    this.installed = entry.sha256;
    this.log(`launcher updated to ${name}; used from the next start`);
    return entry.version || 'new';
  }

  // The script that waits for this launcher to exit (its file stays locked
  // until then), puts the downloaded one in its place and, with restart,
  // starts it. It gives up after about five minutes (the old launcher's
  // wrapper first deletes the app it unpacked, which antivirus can make
  // slow), leaving the download for the next start to finish, then deletes
  // itself and its folder (made by finishOnExit for it alone). It is
  // VBScript, run by wscript.exe, a windowed program: a batch file's pauses
  // (ping, timeout) are console programs, and each opened a console window
  // that flashed up.
  //
  // Two of these scripts can be waiting at once: a launcher closed after
  // downloading an update starts one (no restart); opened again before it
  // could swap (the old file is still locked for a few seconds while the
  // old launcher's wrapper cleans up), the old launcher offers Restart
  // again, and Restart starts a second. Whichever swaps first deletes the
  // download, so a script that finds it gone takes the swap as done, and
  // still restarts: the Restart script used to wait for a download that
  // would never come back, and the launcher never opened again.
  swapScript({ restart = false } = {}) {
    const vbs = (text) => `"${String(text).replace(/"/g, '""')}"`;
    return [
      'Option Explicit',
      'Dim fso, shell, exe, download, tries, done',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set shell = CreateObject("WScript.Shell")',
      `exe = ${vbs(this.exePath)}`,
      `download = ${vbs(this.downloadPath)}`,
      'done = False',
      'On Error Resume Next',
      'For tries = 1 To 300',
      "  ' Gone: another launcher's script has put it in place already.",
      '  If Not fso.FileExists(download) Then',
      '    done = True',
      '    Exit For',
      '  End If',
      '  Err.Clear',
      '  fso.CopyFile download, exe, True',
      '  If Err.Number = 0 Then',
      '    done = True',
      '    Exit For',
      '  End If',
      '  WScript.Sleep 1000',
      'Next',
      'If done Then',
      '  Err.Clear',
      '  fso.DeleteFile download, True',
      ...(restart ? [
        "  ' Started again for a few seconds if it won't start straight away",
        "  ' (say, antivirus still checking the new file).",
        '  For tries = 1 To 10',
        '    Err.Clear',
        '    shell.Run Chr(34) & exe & Chr(34), 1, False',
        '    If Err.Number = 0 Then Exit For',
        '    WScript.Sleep 1000',
        '  Next',
      ] : ["  ' Used from the next start."]),
      'End If',
      'fso.DeleteFile WScript.ScriptFullName, True',
      'fso.DeleteFolder fso.GetParentFolderName(WScript.ScriptFullName), True',
      '',
    ].join('\r\n');
  }

  // Starts the swap script, if a downloaded launcher is waiting. Call it
  // just before quitting. Returns true if it started. Throws, and forgets
  // the download, if it no longer matches the release's checksum.
  finishOnExit({ restart = false } = {}) {
    if (!this.pendingSwap || this.swapScheduled) return false;
    let digest = null;
    try {
      digest = hashFileSync(this.downloadPath);
    } catch {
      // Gone: treated as damaged below.
    }
    if (digest !== this.installed) {
      fs.rmSync(this.downloadPath, { force: true });
      this.pendingSwap = false;
      this.installed = null;
      this.log('launcher update: the downloaded launcher changed since it was checked; it was deleted and downloads again next time');
      throw new Error('The downloaded launcher was damaged, so it was not installed. It downloads again next time.');
    }
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toonvalley-launcher-update-')), 'swap.vbs');
    fs.writeFileSync(script, this.swapScript({ restart }));
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const child = this.spawnScript(wscript, ['//B', '//Nologo', script], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(this.exePath),
    });
    // A script host that's missing or blocked comes as an event, after this
    // returns: logged, not an error that stops the launcher closing. The
    // download stays, and the next start offers Restart again.
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => this.log(`launcher update: couldn't start the swap script: ${err.message}`));
    }
    if (child && typeof child.unref === 'function') child.unref();
    this.swapScheduled = true;
    this.log(`launcher update: swapping in the new launcher once this one exits${restart ? ', then starting it' : ''}`);
    return true;
  }
}

// The running portable Launcher.exe, or null (unpacked or development runs).
function portableExePath(env = process.env) {
  const file = env.PORTABLE_EXECUTABLE_FILE;
  return file && path.isAbsolute(file) ? file : null;
}

module.exports = { SelfUpdater, portableExePath };
