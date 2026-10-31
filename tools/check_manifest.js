#!/usr/bin/env node
// Check an update manifest with the launcher's own parser before it is
// published.  Uses src/src/main/patcher/manifest.js, so a manifest that
// passes here is one the launcher will accept.
//
//   node tools/check_manifest.js dl/manifest.json [--extra release/launcher-entries.json]
//
// Exits 1 and prints the reason when the manifest is not usable.
const fs = require('fs');
const path = require('path');

const { parseManifest, ManifestError, verifySignature } = require('../src/src/main/patcher/manifest');

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error('usage: node tools/check_manifest.js <manifest.json> [--sig <manifest.json.sig>] [--key <base64 spki>]');
    return 2;
  }
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1];
  };

  const bytes = fs.readFileSync(file);
  let manifest;
  try {
    manifest = parseManifest(bytes, { allowHttp: true });
  } catch (err) {
    console.error('INVALID: %s', err instanceof ManifestError ? err.message : err.message);
    return 1;
  }

  console.log('ok: schema %d, version %s, %d files, %d removed',
              manifest.schema, manifest.version, manifest.files.length,
              manifest.removed.length);
  if (manifest.published) {
    console.log('    published %s', new Date(manifest.published).toISOString());
  }

  const launcherFiles = manifest.files.filter((f) => /^launcher\//i.test(f.path));
  for (const entry of launcherFiles) {
    console.log('    launcher file: %s (%d bytes) %s', entry.path, entry.size, entry.url || '');
  }
  if (manifest.launcher) {
    console.log('    launcher exe : %s v%s (%d bytes) %s', manifest.launcher.path,
                manifest.launcher.version || '?', manifest.launcher.size,
                manifest.launcher.url || '');
  } else {
    console.log('    launcher exe : none (the exe cannot update itself from this manifest)');
  }
  if (!launcherFiles.length) {
    console.log('    launcher UI  : none (app.asar.next is not in this manifest)');
  }

  const sigPath = flag('--sig');
  const key = flag('--key');
  if (sigPath && key) {
    // verifySignature takes the base64 text, not the decoded bytes
    const signature = fs.readFileSync(sigPath, 'utf8').trim();
    try {
      verifySignature(bytes, signature, key);
      console.log('    signature    : valid');
    } catch (err) {
      console.error('INVALID SIGNATURE: %s', err.message);
      return 1;
    }
  } else {
    console.log('    signature    : not checked (pass --sig and --key)');
  }
  return 0;
}

process.exit(main(process.argv));
