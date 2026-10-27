// "Remember password": the username and password from the last login with
// the box ticked, kept encrypted with Electron's safeStorage in a file in the
// launcher's user-data folder. Without real encryption (none available, or
// Linux's "basic_text" fallback, which is a fixed key) nothing is saved. A
// file that can't be decrypted (damaged, or made by another user of this
// computer) is deleted. The password and the file's contents are never
// logged.
const fs = require('fs');
const path = require('path');

const { validateCredentials } = require('./auth');

class SavedLogin {
  // file: where the encrypted login is kept. safeStorage: Electron's (or a
  // fake in tests).
  constructor({ file, safeStorage, log = () => {} }) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.log = log;
  }

  // Whether a password can be saved here.
  available() {
    try {
      if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) return false;
      // Linux without a keyring "encrypts" with a key every copy of
      // Chromium knows: as good as plain text.
      const backend = typeof this.safeStorage.getSelectedStorageBackend === 'function'
        ? this.safeStorage.getSelectedStorageBackend() : null;
      return backend !== 'basic_text';
    } catch {
      return false;
    }
  }

  // The saved { username, password }, or null.
  load() {
    if (!this.file || !fs.existsSync(this.file)) return null;
    if (!this.available()) return null;
    let saved;
    try {
      saved = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file)));
    } catch {
      this.log('saved login: the saved password could not be read; it was removed');
      this.clear();
      return null;
    }
    if (!saved || typeof saved !== 'object' || validateCredentials(saved.username, saved.password)) {
      this.log('saved login: the saved password is invalid; it was removed');
      this.clear();
      return null;
    }
    return { username: saved.username, password: saved.password };
  }

  // Saves the login; returns true when it was saved.
  save(username, password) {
    if (validateCredentials(username, password) || !this.available()) return false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, this.safeStorage.encryptString(JSON.stringify({ username, password })), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.log(`saved login: could not save the password (${err.code || 'error'})`);
      this.clear();
      return false;
    }
  }

  // Forgets the saved login.
  clear() {
    if (!this.file) return;
    for (const file of [this.file, `${this.file}.tmp`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // In use; an unreadable file is removed next time anyway.
      }
    }
  }

  // Reset to defaults: the saved password stays while "Remember password"
  // is ticked, and is forgotten when it isn't.
  reset(rememberPassword) {
    if (rememberPassword !== true) this.clear();
  }
}

module.exports = { SavedLogin };
