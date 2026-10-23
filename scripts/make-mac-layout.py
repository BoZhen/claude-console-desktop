"""The Finder window of the disk image: a .DS_Store with ds-store==1.3.3 and
mac-alias==2.2.3 (scripts/mac-tools.sh puts both in the tool cache).

    python3 scripts/make-mac-layout.py
        writes assets/mac-dmg.DS_Store, the template that reserves the layout's space
        in the volume. Run it again after changing the layout below, then rebuild.
    --metadata FILE      (scripts/mac-dmg.js on Linux) the real layout, its background
                         alias built from the catalog IDs and dates of the volume
    --mounted-root DIR   (scripts/mac-dmg.js on a Mac) the alias read from the mounted
                         volume

Finder finds the background through an alias, not a path: volume name and creation
date, the catalog IDs of /.background and of background.png, and the file's creation
date. An alias naming another volume's IDs shows no background.
"""
import argparse
import datetime
import json
from pathlib import Path
from ds_store import DSStore
from mac_alias import Alias, VolumeInfo, TargetInfo, ALIAS_FIXED_DISK, ALIAS_KIND_FILE


APP = 'Claude Console'
EPOCH = datetime.datetime(1904, 1, 1, tzinfo=datetime.timezone.utc)
WINDOW = (760, 560)           # = the background image's size
APP_ICON = (200, 205)         # icon centres; the background's arrow sits between them
APPLICATIONS_ICON = (560, 205)


def background_alias(metadata=None, mounted_root=None):
    if mounted_root:
        alias = Alias.for_file(str(Path(mounted_root) / '.background/background.png'))
        alias.volume.posix_path = '/Volumes/' + APP
        return alias
    # the template: same structure and size as the real alias, placeholder IDs
    meta = metadata or {'volume_created': 3029529600, 'folder_id': 0, 'file_id': 0, 'file_created': 3029529600}
    return Alias(
        volume=VolumeInfo(APP, EPOCH + datetime.timedelta(seconds=meta['volume_created']), b'H+',
                          ALIAS_FIXED_DISK, 0, b'\0\0', posix_path='/Volumes/' + APP),
        target=TargetInfo(ALIAS_KIND_FILE, 'background.png', meta['folder_id'], meta['file_id'],
                          EPOCH + datetime.timedelta(seconds=meta['file_created']), b'\0' * 4, b'\0' * 4,
                          folder_name='.background', cnid_path=[meta['folder_id']],
                          carbon_path=APP + ':.background:\0background.png', posix_path='/.background/background.png'))


def write_layout(destination, alias):
    with DSStore.open(str(destination), 'w+') as store:
        store['.']['bwsp'] = {
            'ShowStatusBar': False, 'ShowTabView': False, 'ShowToolbar': False,
            'ShowPathbar': False, 'ShowSidebar': False, 'SidebarWidth': 0,
            'ContainerShowSidebar': False, 'PreviewPaneVisibility': False,
            'WindowBounds': '{{180, 180}, {%d, %d}}' % WINDOW,
        }
        store['.']['icvp'] = {
            'viewOptionsVersion': 1, 'backgroundType': 2, 'backgroundImageAlias': alias.to_bytes(),
            'backgroundColorRed': 1.0, 'backgroundColorGreen': 1.0, 'backgroundColorBlue': 1.0,
            'iconSize': 112.0, 'textSize': 14.0, 'gridSpacing': 100.0,
            'gridOffsetX': 0.0, 'gridOffsetY': 0.0, 'arrangeBy': 'none',
            'labelOnBottom': True, 'showIconPreview': False, 'showItemInfo': False,
            'scrollPositionX': 0.0, 'scrollPositionY': 0.0,
        }
        store['.']['vSrn'] = ('long', 1)
        # icon view must be chosen explicitly: with only the view options, Finder on
        # the Mac showed a plain window without the background
        store['.']['icvl'] = ('type', b'icnv')
        store[APP + '.app']['Iloc'] = APP_ICON
        store['Applications']['Iloc'] = APPLICATIONS_ICON


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets/mac-dmg.DS_Store')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--metadata', type=Path)
    source.add_argument('--mounted-root', type=Path)
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text()) if args.metadata else None
    write_layout(args.output, background_alias(metadata, args.mounted_root))
    print(args.output)
