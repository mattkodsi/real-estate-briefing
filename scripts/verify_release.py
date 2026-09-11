#!/usr/bin/env python3
"""Read-only release check: compare served bytes with reviewed local assets."""
import hashlib
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ['index.html', 'css/style.css', 'js/app.js', 'js/profile-store.js',
          'js/data-client.js', 'js/briefing-core.js', 'js/research-identities.js', 'js/overlay-focus.js', 'sw.js']

def verify(version, attempts=60):
    expected = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in ASSETS}
    for attempt in range(attempts):
        failed = []
        for name, digest in expected.items():
            try:
                request = urllib.request.Request(
                    f'https://briefing.pierrepontcompanies.com/{name}?v={version}&verify={attempt}',
                    headers={'Cache-Control': 'no-cache'})
                with urllib.request.urlopen(request, timeout=15) as response:
                    if hashlib.sha256(response.read()).hexdigest() != digest: failed.append(name)
            except Exception:
                failed.append(name)
        if not failed:
            print(f'Verified v{version}: all {len(ASSETS)} hosted asset hashes match.')
            return True
        print('Waiting for Pages: ' + ', '.join(failed), flush=True)
        if attempt + 1 < attempts: time.sleep(5)
    return False

if __name__ == '__main__':
    if len(sys.argv) != 2 or not sys.argv[1].isdigit(): raise SystemExit('usage: verify_release.py VERSION')
    raise SystemExit(0 if verify(sys.argv[1]) else 'Hosted assets did not match; release is unverified.')
