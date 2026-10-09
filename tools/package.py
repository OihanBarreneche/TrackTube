"""Build a runtime-only distribution candidate, without profile or audit data."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
files = [root / name for name in ('manifest.json', 'LICENSE', 'welcome.html',
                                  'history.html', 'journal.html', 'privacy.html')]
for directory in ('src', 'icons'):
    files.extend(path for path in (root / directory).rglob('*') if path.is_file())
if any(not path.is_file() for path in files):
    raise SystemExit('Missing runtime file')
output = root / 'dist'
output.mkdir(exist_ok=True)
archive = output / f"tracktube-{manifest['version']}-candidate.zip"
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(files):
        bundle.write(path, path.relative_to(root).as_posix())
with zipfile.ZipFile(archive) as bundle:
    if bundle.testzip() is not None:
        raise SystemExit('Archive integrity check failed')
print(f'{archive} — {len(files)} runtime files')
