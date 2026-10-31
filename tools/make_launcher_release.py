#!/usr/bin/env python3
"""Stage a built launcher in release/ and write the manifest entries.

The launcher updates itself from the same signed manifest the game uses: the
manifest carries the launcher UI as a normal file

    Launcher/resources/app.asar.next   (swapped in on quit, asarSwap.js)

and, on Windows, the launcher exe as the `launcher` entry (selfupdate.js).

    python tools/make_launcher_release.py app.asar --exe Launcher.exe
    # -> release/app.asar, release/Launcher.exe
    # -> release/launcher-entries.json  (merge into the release manifest)
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

RAW = 'https://raw.githubusercontent.com/tvtvalley/tv-launcher-win/%s/release/%s'
ASAR_INSTALL_PATH = 'Launcher/resources/app.asar.next'


def branch(root):
    try:
        name = subprocess.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                              cwd=root, capture_output=True, text=True).stdout
        return name.strip() or 'main'
    except Exception:
        return 'main'


def digest(path):
    sha = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            sha.update(chunk)
    return sha.hexdigest()


def stage(root, source, name):
    release = os.path.join(root, 'release')
    os.makedirs(release, exist_ok=True)
    target = os.path.join(release, name)
    if os.path.abspath(target) != os.path.abspath(source):
        shutil.copy2(source, target)
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('asar', help='built resources/app.asar')
    parser.add_argument('--exe', default=None,
                        help='built launcher exe (Windows releases only)')
    parser.add_argument('--exe-url', default=None,
                        help='https URL the exe is published at (release asset)')
    parser.add_argument('--exe-name', default='Launcher.exe',
                        help="name used in the manifest for the exe")
    parser.add_argument('--version', default=None,
                        help='launcher version (default: src/package.json)')
    parser.add_argument('-o', '--output', default=None,
                        help='entries file (default: release/launcher-entries.json)')
    args = parser.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isfile(args.asar):
        sys.exit('no such file: %s' % args.asar)

    version = args.version
    if not version:
        version = json.load(open(os.path.join(root, 'src', 'package.json')))['version']

    name = branch(root)
    asar = stage(root, args.asar, 'app.asar')
    entries = {
        'version': version,
        'branch': name,
        'files': [{
            'path': ASAR_INSTALL_PATH,
            'size': os.path.getsize(asar),
            'sha256': digest(asar),
            'url': RAW % (name, 'app.asar'),
        }],
    }

    if args.exe:
        if not os.path.isfile(args.exe):
            sys.exit('no such file: %s' % args.exe)
        if not args.exe_url:
            # a 100 MB+ exe does not belong in the branch: publish it as a
            # release asset and pass the URL here
            sys.exit('--exe needs --exe-url (the release asset URL)')
        entries['launcher'] = {
            'path': args.exe_name,
            'size': os.path.getsize(args.exe),
            'sha256': digest(args.exe),
            'version': version,
            'url': args.exe_url,
        }
        print('launcher exe: %s (%d bytes, published at %s)'
              % (args.exe, os.path.getsize(args.exe), args.exe_url))

    output = args.output or os.path.join(root, 'release', 'launcher-entries.json')
    with open(output, 'w') as handle:
        json.dump(entries, handle, indent=1)
        handle.write('\n')

    print('staged %s (%d bytes)' % (asar, os.path.getsize(asar)))
    print('wrote %s' % output)
    print('')
    print('Merge it into the release manifest (server side, key required):')
    print('  python build_manifest.py --src "<game folder>" --key <key> '
          '--base <game raw base> --merge %s -o dl/manifest.json' % output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
