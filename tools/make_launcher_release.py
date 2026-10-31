#!/usr/bin/env python3
"""Stage a built launcher file in release/ and print the manifest entry.

The update manifest cannot point at a build directory: every file it lists
has to be a stable raw URL, which for us is this branch.  Copy the built
artifact into release/ (commit it), then paste the printed --extra argument
into the build_manifest.py call that publishes the manifest.

    python tools/make_launcher_release.py dist/linux-unpacked/resources/app.asar
    python tools/make_launcher_release.py dist/linux-unpacked/launcher --name Launcher.exe
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys

BRANCH = subprocess.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                        capture_output=True, text=True).stdout.strip() or 'main'
RAW = 'https://raw.githubusercontent.com/tvtvalley/tv-launcher-win/%s'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('artifact', help='built file, e.g. .../resources/app.asar')
    parser.add_argument('--name', default=None,
                        help='name inside release/ (default: the file name)')
    parser.add_argument('--manifest-path', default=None,
                        help='path the file is installed to '
                             '(default: Launcher/resources/app.asar.next)')
    parser.add_argument('--url-name', default=None,
                        help='file name used in the URL (default: --name)')
    args = parser.parse_args()

    if not os.path.isfile(args.artifact):
        sys.exit('no such file: %s' % args.artifact)

    name = args.name or os.path.basename(args.artifact)
    url_name = args.url_name or name
    if args.manifest_path is None:
        args.manifest_path = ('Launcher/resources/app.asar.next'
                              if name.endswith('.asar') else 'Launcher/' + name)

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    release = os.path.join(root, 'release')
    os.makedirs(release, exist_ok=True)
    target = os.path.join(release, name)
    if os.path.abspath(target) != os.path.abspath(args.artifact):
        shutil.copy2(args.artifact, target)

    url = (RAW % BRANCH) + '/release/' + url_name
    print('staged %s (%d bytes, sha256 %s)' % (target, os.path.getsize(target),
                                               sha256(target)))
    print('')
    print('--extra "%s|release/%s|%s"' % (args.manifest_path, url_name, url))
    print('')
    print('commit release/%s and publish the manifest with the key.' % url_name)


if __name__ == '__main__':
    main()
