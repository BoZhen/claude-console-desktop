"""Offline content/hash checks for a thin, ad-hoc-signed Mac app.

This does not evaluate Apple trust, notarization, Gatekeeper or runtime behavior.
Run Apple's codesign --verify --deep --strict on macOS for authoritative checking.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import struct
import sys


def check(condition, message):
    if not condition:
        raise ValueError(message)


def signature(file, info=None, resources=None):
    raw = file.read_bytes()
    check(raw[:4] == b'\xcf\xfa\xed\xfe', 'Expected a thin 64-bit Mach-O: ' + str(file))
    count = struct.unpack_from('<I', raw, 16)[0]
    offset, sig = 32, None
    for _ in range(count):
        command, size = struct.unpack_from('<II', raw, offset)
        check(size >= 8 and offset + size <= len(raw), 'Invalid load command')
        if command == 0x1d:
            start, length = struct.unpack_from('<II', raw, offset + 8)
            sig = raw[start:start + length]
        offset += size
    check(sig is not None and len(sig) >= 12, 'Missing code signature: ' + str(file))
    magic, size, count = struct.unpack_from('>III', sig)
    check(magic == 0xfade0cc0 and size <= len(sig), 'Invalid signature superblob')
    blobs = {}
    for i in range(count):
        slot, offset = struct.unpack_from('>II', sig, 12 + 8 * i)
        length = struct.unpack_from('>I', sig, offset + 4)[0]
        check(offset + length <= size, 'Truncated signature blob')
        blobs[slot] = sig[offset:offset + length]
    cd = blobs[0]
    magic, length, version, flags, hashes, identifier, special, pages, limit = struct.unpack_from('>9I', cd)
    hash_size, hash_type, platform, page_size = cd[36:40]
    check(magic == 0xfade0c02 and flags & 2 and hash_type == 2 and hash_size == 32, 'Expected ad-hoc SHA-256 code directory')
    if version >= 0x20300 and not limit:
        limit = struct.unpack_from('>Q', cd, 56)[0]
    check(limit <= len(raw) and hashes + pages * hash_size <= length, 'Invalid code hash bounds')
    page_bytes = (1 << page_size) if page_size else limit
    check(pages == (limit + page_bytes - 1) // page_bytes, 'Invalid code page count')
    for i in range(pages):
        actual = hashlib.sha256(raw[i * page_bytes:min((i + 1) * page_bytes, limit)]).digest()
        check(actual == cd[hashes + 32 * i:hashes + 32 * (i + 1)], 'Code page mismatch: ' + str(file))
    external = {1: info.read_bytes() if info else None, 3: resources.read_bytes() if resources else None}
    for i in range(1, special + 1):
        expected = cd[hashes - i * 32:hashes - (i - 1) * 32]
        if expected == bytes(32):
            continue
        data = external.get(i) if i in external else blobs.get(i)
        check(data is not None and hashlib.sha256(data).digest() == expected, 'Special-slot mismatch: %s slot %d' % (file, i))
    return hashlib.sha256(cd).digest()[:20]


def bundle_main(root):
    if (root / 'Contents/Info.plist').exists():
        base = root / 'Contents'; info = base / 'Info.plist'; executable = base / 'MacOS'
    else:
        base = root; info = base / 'Resources/Info.plist'; executable = base
    metadata = plistlib.loads(info.read_bytes())
    return (executable / metadata['CFBundleExecutable']).resolve()


def verify(root):
    files, mains = [], {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        files.extend(Path(directory) / name for name in names if not (Path(directory) / name).is_symlink())
    resources = [file for file in files if file.name == 'CodeResources' and file.parent.name == '_CodeSignature']
    for resource in resources:
        base = resource.parent.parent
        if base.name == 'Contents':
            info = base / 'Info.plist'; executable = base / 'MacOS'
        else:
            info = base / 'Resources/Info.plist'; executable = base
        metadata = plistlib.loads(info.read_bytes())
        mains[(executable / metadata['CFBundleExecutable']).resolve()] = (info, resource)
    signed = {}
    for file in files:
        with file.open('rb') as handle:
            if handle.read(4) != b'\xcf\xfa\xed\xfe':
                continue
        signed[file.resolve()] = signature(file, *mains.get(file.resolve(), (None, None)))
    check(signed and mains and set(mains).issubset(signed), 'Missing signed bundle executables')
    entries = 0
    for resource in resources:
        for name, record in plistlib.loads(resource.read_bytes())['files2'].items():
            file = resource.parent.parent / name
            if 'symlink' in record:
                check(file.is_symlink() and os.readlink(file) == record['symlink'], 'Symlink mismatch: ' + str(file))
            elif 'cdhash' in record:
                main = bundle_main(file) if file.is_dir() else file.resolve()
                check(signed.get(main) == record['cdhash'], 'Nested signature mismatch: ' + str(file))
            else:
                data = file.read_bytes()
                for field, algorithm in [('hash', 'sha1'), ('hash2', 'sha256')]:
                    if field in record:
                        check(hashlib.new(algorithm, data).digest() == record[field], 'Resource mismatch: ' + str(file))
            entries += 1
    return {'signed_binaries': len(signed), 'resource_manifests': len(resources), 'resource_entries': entries}


if __name__ == '__main__':
    print(json.dumps(verify(Path(sys.argv[1]).resolve())))
