"""Checks the .DS_Store of an unpacked disk image against the HFS+ catalog of its
volume: icon places, icon view, window size, and a background alias that names
this volume's own IDs and dates. Run by test/mac-dmg-roundtrip.js:

    python3 test/mac-layout-check.py <unpacked volume> '<hfs-layout-meta JSON>'
"""
import datetime
import json
from pathlib import Path
import sys
from ds_store import DSStore
from mac_alias import Alias

APP = 'Claude Console'
root, meta = Path(sys.argv[1]), json.loads(sys.argv[2])
with DSStore.open(str(root / '.DS_Store'), 'r') as store:
    assert store['.']['icvl'] == (b'type', b'icnv')
    assert store[APP + '.app']['Iloc'] == (200, 205)
    assert store['Applications']['Iloc'] == (560, 205)
    assert store['.']['bwsp']['WindowBounds'] == '{{180, 180}, {760, 560}}'
    settings = store['.']['icvp']
    assert settings['backgroundType'] == 2
    alias = Alias.from_bytes(settings['backgroundImageAlias'])
    epoch = datetime.datetime(1904, 1, 1, tzinfo=datetime.timezone.utc)
    assert alias.volume.name == APP
    assert alias.volume.posix_path == '/Volumes/' + APP
    assert (alias.volume.creation_date - epoch).total_seconds() == meta['volume_created']
    assert alias.target.cnid == meta['file_id'] > 0
    assert alias.target.folder_cnid == meta['folder_id'] > 0
    assert (alias.target.creation_date - epoch).total_seconds() == meta['file_created']
    assert alias.target.posix_path == '/.background/background.png'
    assert list(alias.target.cnid_path) == [meta['folder_id']]
    assert (root / alias.target.posix_path.lstrip('/')).is_file()
    assert meta['finder_records'] == 0, 'Finder info left on files makes codesign --strict fail on the Mac'
print('PASS: icon places, icon view and the background alias match the volume')
