#!/usr/bin/env python3
"""Bundle the built Linux launcher into the archive we attach to a release.

The Linux launcher is an Electron app directory (`linux-unpacked`), far too
big for the git branch, so it ships as a GitHub release asset while the
launcher UI keeps updating through `release/app.asar` on the `linux` branch.

    python tools/bundle_linux_release.py dist/linux-unpacked
    # -> dist/release/toon-valley-launcher-<version>-linux-x86_64.tar.gz
"""
import argparse
import json
import os
import subprocess
import sys
import tarfile

SKIP = {'chrome-sandbox'}


def version():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        return json.load(open(os.path.join(root, 'src', 'package.json')))['version']
    except Exception:
        return '0.0.0'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('built', help='the electron-builder output dir')
    parser.add_argument('-o', '--output', default=None)
    parser.add_argument('--root-name', default='toon-valley-launcher',
                        help='top-level folder inside the archive')
    args = parser.parse_args()

    if not os.path.isdir(args.built):
        sys.exit('no such directory: %s' % args.built)

    output = args.output or os.path.join(os.path.dirname(args.built), 'release',
                                         'toon-valley-launcher-%s-linux-x86_64.tar.gz'
                                         % version())
    os.makedirs(os.path.dirname(output), exist_ok=True)
    base = args.root_name

    count = 0
    with tarfile.open(output, 'w:gz') as archive:
        for folder, dirs, files in os.walk(args.built):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(folder, name)
                relative = os.path.relpath(full, args.built)
                if relative in SKIP:
                    continue
                info = archive.gettarinfo(full, arcname=os.path.join(base, relative))
                info.uid = info.gid = 0
                info.uname = info.gname = 'root'
                with open(full, 'rb') as handle:
                    archive.addfile(info, handle)
                count += 1

    size = os.path.getsize(output)
    print('%d files, %.1f MiB -> %s' % (count, size / 1048576.0, output))
    print('')
    print('Attach it to the release:')
    print('  https://github.com/tvtvalley/tv-launcher-win/releases -> upload %s'
          % os.path.basename(output))
    print('')
    print('Launcher UI updates still ship through the branch:')
    print('  python tools/make_launcher_release.py %s'
          % os.path.join(os.path.normpath(args.built), 'resources', 'app.asar'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
