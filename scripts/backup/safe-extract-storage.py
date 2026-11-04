#!/usr/bin/env python3
"""Verify/extract authenticated Helper #3 bytes (tar.zst) in an isolated local area.

Inputs MUST already have passed R1 authenticated decryption. No network/provider
code exists here. Object identity is (bucket, path); other manifest metadata is
left untouched. --buckets consumes Helper #3's existing buckets.json array and is
required to authorize empty buckets (the object manifest cannot identify them).

Recovery contract: only the exact --destination name is a published tree. Hidden
.safe-extract-* siblings are NEVER accepted, resumed, or auto-reaped. SIGKILL can
leave them behind. An operator must stop the old process, inspect ownership and
remove its specific orphan in the private restore area, then retry into a fresh
name. A kill/crash around rename may leave a complete destination without a
successful CLI receipt: independently reverify or quarantine it, never overwrite
or blindly roll it back. Power-loss durability depends on the filesystem honoring
fsync; no crash/power-loss handler is claimed.

Requires POSIX dir_fd/O_NOFOLLOW and native atomic no-replace directory rename
(macOS renameatx_np or Linux renameat2). Unsupported platforms/filesystems fail
closed. The destination parent must be owned by this uid and mode 0700. The
operator must exclusively control inputs, that parent, and their namespace for
the invocation; a hostile same-uid process/root can defeat Unix permissions.
"""

import argparse
from contextlib import ExitStack, contextmanager
import ctypes
import hashlib
import json
import os
import re
import resource
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import unicodedata

CHUNK = 64 * 1024
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
DEFAULTS = {
    'max_archive_bytes': 64 * 1024**3,
    'max_file_bytes': 16 * 1024**3,
    'max_total_bytes': 64 * 1024**3,
    'max_entries': 100_000,  # includes root, directories and extension headers
    'max_path_bytes': 2048,  # bucket + slash + Helper #3's <=1024-byte object key
    'max_depth': 64,
    'max_ratio': 1000,
    'max_manifest_bytes': 16 * 1024**2,
    'max_tar_bytes': 80 * 1024**3,  # includes headers, padding and extensions
    'max_pax_bytes': 16 * 1024,
}


class ExtractError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Interrupted(ExtractError):
    def __init__(self, signum):
        super().__init__('INTERRUPTED')
        self.signum = signum


def require(condition, code):
    if not condition:
        raise ExtractError(code)


def identity(st):
    return st.st_dev, st.st_ino


def snapshot(st):
    return identity(st), st.st_size, st.st_mtime_ns, st.st_ctime_ns


@contextmanager
def blocked_signals():
    old = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old)


def check_primitives():
    require(os.name == 'posix' and hasattr(os, 'O_NOFOLLOW')
            and hasattr(os, 'O_DIRECTORY') and hasattr(signal, 'pthread_sigmask'),
            'UNSUPPORTED_PLATFORM')
    for op in (os.open, os.mkdir, os.stat, os.unlink, os.rmdir):
        require(op in os.supports_dir_fd, 'UNSUPPORTED_PLATFORM')
    require(os.stat in os.supports_follow_symlinks, 'UNSUPPORTED_PLATFORM')
    require(os.listdir in os.supports_fd, 'UNSUPPORTED_PLATFORM')


def open_dir_at(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                   dir_fd=parent)


@contextmanager
def parent_fd(path):
    # Do not resolve symlinks or collapse '..' supplied by a caller.
    require(isinstance(path, str) and path and '\0' not in path
            and '\\' not in path and '://' not in path, 'LOCAL_PATH_REQUIRED')
    require(all(p not in ('', '.', '..') for p in path.lstrip('/').split('/')),
            'INVALID_INPUT_PATH')
    absolute = path if path.startswith('/') else os.getcwd() + '/' + path
    parts = absolute.split('/')[1:]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            new = open_dir_at(fd, part)
            os.close(fd)
            fd = new
        yield fd, parts[-1]
    finally:
        os.close(fd)


@contextmanager
def input_file(path, maximum):
    with parent_fd(path) as (parent, name):
        # O_NONBLOCK prevents a malicious FIFO input from blocking before fstat.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=parent)
        # The fd is also passed to zstd: buffered lookahead must not move its
        # kernel offset past the magic while seek(0) only resets a Python buffer.
        with os.fdopen(fd, 'rb', buffering=0) as stream:
            before = os.fstat(stream.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                    'INPUT_NOT_REGULAR')
            require(before.st_size <= maximum, 'INPUT_LIMIT')
            yield stream, before
            after = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(snapshot(after) == snapshot(before)
                    and snapshot(os.fstat(stream.fileno())) == snapshot(before),
                    'INPUT_CHANGED')


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'INVALID_JSON')
        result[key] = value
    return result


def load_json(path, limits):
    with input_file(path, limits['max_manifest_bytes']) as (stream, _):
        raw = stream.read(limits['max_manifest_bytes'] + 1)
        require(len(raw) <= limits['max_manifest_bytes'], 'INPUT_LIMIT')
        try:
            return json.loads(raw.decode('utf-8'), object_pairs_hook=strict_pairs,
                              parse_constant=lambda _: (_ for _ in ()).throw(
                                  ExtractError('INVALID_JSON')))
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise ExtractError('INVALID_JSON') from exc


def safe_path(value, limits):
    require(isinstance(value, str) and value and '\\' not in value
            and '\0' not in value and not value.startswith('/'), 'INVALID_PATH')
    try:
        encoded = value.encode('utf-8', 'strict')
    except UnicodeError as exc:
        raise ExtractError('INVALID_PATH') from exc
    parts = value.split('/')
    require(len(encoded) <= limits['max_path_bytes']
            and len(parts) <= limits['max_depth'], 'PATH_LIMIT')
    require(all(p not in ('', '.', '..') and not re.match(r'^[A-Za-z]:', p)
                and len(p.encode('utf-8')) <= 255 for p in parts), 'INVALID_PATH')
    return value


def bucket_id(value):
    require(isinstance(value, str) and '..' not in value
            and re.fullmatch(r'[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]', value),
            'INVALID_BUCKET')
    return value


def inventory(manifest_path, buckets_path, limits):
    manifest = load_json(manifest_path, limits)
    require(isinstance(manifest, list) and len(manifest) <= limits['max_entries'],
            'INVALID_MANIFEST')
    buckets = None
    if buckets_path:
        rows = load_json(buckets_path, limits)
        require(isinstance(rows, list) and len(rows) <= limits['max_entries'],
                'INVALID_BUCKETS')
        buckets = set()
        for row in rows:
            require(isinstance(row, dict), 'INVALID_BUCKETS')
            key = bucket_id(row.get('id'))
            require(key not in buckets, 'DUPLICATE_BUCKET')
            buckets.add(key)
    files, dirs, ids = {}, set(), set()
    total = 0
    for row in manifest:
        require(isinstance(row, dict), 'INVALID_MANIFEST')
        bucket = bucket_id(row.get('bucket'))
        if buckets is not None:
            require(bucket in buckets, 'BUCKET_MISMATCH')
        key = safe_path(row.get('path'), limits)
        require(len(key.encode('utf-8')) <= 1024, 'PATH_LIMIT')
        name = safe_path(bucket + '/' + key, limits)
        require(name not in files, 'DUPLICATE_IDENTITY')
        size, digest = row.get('size'), row.get('sha256')
        require(type(size) is int and 0 <= size <= limits['max_file_bytes'],
                'FILE_LIMIT')
        require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest),
                'INVALID_SHA256')
        object_id = row.get('objectId')
        if object_id is not None:
            require(isinstance(object_id, str) and object_id, 'INVALID_OBJECT_ID')
            require(object_id not in ids, 'DUPLICATE_OBJECT_ID')
            ids.add(object_id)
        files[name] = (size, digest)
        total += size
        require(total <= limits['max_total_bytes'], 'TOTAL_LIMIT')
        parts = name.split('/')
        dirs.update('/'.join(parts[:i]) for i in range(1, len(parts)))
        require(len(files) + len(dirs) + 1 <= limits['max_entries'], 'ENTRY_LIMIT')
    if buckets is not None:
        dirs.update(buckets)
    require(not dirs.intersection(files), 'PARENT_CHILD_CONFLICT')
    require(len(files) + len(dirs) + 1 <= limits['max_entries'], 'ENTRY_LIMIT')
    # Conservative portable policy, applied to every ancestor too. Keys are
    # NEVER renamed/normalized; case-distinct pairs are rejected on all hosts.
    folded = {}
    for name in sorted(dirs | files.keys()):
        safe_path(name, limits)
        canonical = unicodedata.normalize('NFC', name).casefold()
        canonical = unicodedata.normalize('NFC', canonical)
        require(canonical not in folded or folded[canonical] == name,
                'FILENAME_COLLISION')
        folded[canonical] = name
    return files, dirs, buckets, total


def native_publisher():
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin' and hasattr(libc, 'renameatx_np'):
        call, flag = libc.renameatx_np, 4  # SDK sys/stdio.h: RENAME_EXCL
    elif sys.platform.startswith('linux') and hasattr(libc, 'renameat2'):
        call, flag = libc.renameat2, 1  # linux/fs.h: RENAME_NOREPLACE
    else:
        raise ExtractError('ATOMIC_RENAME_UNAVAILABLE')
    call.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                     ctypes.c_char_p, ctypes.c_uint)
    call.restype = ctypes.c_int

    def publish(parent, source, destination):
        if call(parent, os.fsencode(source), parent, os.fsencode(destination), flag):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
    return publish


class Tree:
    """All writes/deletes are descriptor-relative and checked against our journal."""
    def __init__(self, parent):
        self.parent, self.fd, self.name = parent, None, None
        self.root_identity = None
        self.nodes = {}  # insertion order is parent-before-child
        self.published = False

    def create(self):
        parent = self.parent
        with blocked_signals():
            name = '.safe-extract-' + secrets.token_hex(16)
            os.mkdir(name, 0o700, dir_fd=parent)
            self.name = name
            self.root_identity = identity(os.stat(name, dir_fd=parent,
                                                  follow_symlinks=False))
            self.fd = open_dir_at(parent, name)
        os.fchmod(self.fd, 0o700)

    @contextmanager
    def directory(self, path):
        fd = os.dup(self.fd)
        try:
            current = []
            for part in path.split('/') if path else ():
                current.append(part)
                name = '/'.join(current)
                require(name in self.nodes and self.nodes[name][1], 'TREE_CHANGED')
                new = open_dir_at(fd, part)
                os.close(fd)
                fd = new
                require(identity(os.fstat(fd)) == self.nodes[name][0], 'TREE_CHANGED')
            yield fd
        finally:
            os.close(fd)

    def mkdir(self, name):
        if name in self.nodes:
            require(self.nodes[name][1], 'PARENT_CHILD_CONFLICT')
            return
        parent, _, base = name.rpartition('/')
        with self.directory(parent) as fd, blocked_signals():
            os.mkdir(base, 0o700, dir_fd=fd)
            st = os.stat(base, dir_fd=fd, follow_symlinks=False)
            self.nodes[name] = (identity(st), True)
            child = open_dir_at(fd, base)
            try:
                require(identity(os.fstat(child)) == identity(st), 'TREE_CHANGED')
                os.fchmod(child, 0o700)
            finally:
                os.close(child)

    @contextmanager
    def file(self, name):
        parent, _, base = name.rpartition('/')
        with self.directory(parent) as fd:
            with blocked_signals():
                out = os.open(base, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                              | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                self.nodes[name] = (identity(os.fstat(out)), False)
            try:
                os.fchmod(out, 0o600)
                yield out
                os.fsync(out)
            finally:
                os.close(out)

    def verify_and_sync(self):
        # Check actual exact set, including aliases on normalizing filesystems.
        # Compare names by NFC only for lookup; keep original manifest identities.
        children = {}
        for name in self.nodes:
            parent, _, base = name.rpartition('/')
            children.setdefault(parent, set()).add(unicodedata.normalize('NFC', base))
        for name in [''] + [p for p, (_, isdir) in self.nodes.items() if isdir]:
            with self.directory(name) as fd:
                actual = os.listdir(fd)
                require(len(actual) == len(children.get(name, set())) and
                        {unicodedata.normalize('NFC', p) for p in actual}
                        == children.get(name, set()), 'TREE_CHANGED')
                os.fsync(fd)
        for name, (expected, isdir) in self.nodes.items():
            parent, _, base = name.rpartition('/')
            with self.directory(parent) as fd:
                st = os.stat(base, dir_fd=fd, follow_symlinks=False)
                require(identity(st) == expected and
                        (stat.S_ISDIR(st.st_mode) if isdir else
                         stat.S_ISREG(st.st_mode) and st.st_nlink == 1) and
                        stat.S_IMODE(st.st_mode) == (0o700 if isdir else 0o600),
                        'TREE_CHANGED')

    def publish(self, destination, publisher):
        with blocked_signals():
            require(identity(os.stat(self.name, dir_fd=self.parent,
                                     follow_symlinks=False)) == self.root_identity,
                    'TREE_CHANGED')
            publisher(self.parent, self.name, destination)
            self.published = True  # NEVER roll back the destination after rename
            os.fsync(self.parent)

    def cleanup(self):
        if self.published or self.name is None:
            return
        require(self.root_identity is not None, 'CLEANUP_FAILED')
        require(identity(os.stat(self.name, dir_fd=self.parent,
                                 follow_symlinks=False)) == self.root_identity,
                'CLEANUP_FAILED')
        # Do not recursively delete unknown/replaced entries.
        failed = False
        for name, (expected, isdir) in reversed(list(self.nodes.items())):
            parent, _, base = name.rpartition('/')
            try:
                with self.directory(parent) as fd:
                    st = os.stat(base, dir_fd=fd, follow_symlinks=False)
                    require(identity(st) == expected, 'CLEANUP_FAILED')
                    (os.rmdir if isdir else os.unlink)(base, dir_fd=fd)
            except (OSError, ExtractError):
                failed = True
        try:
            os.rmdir(self.name, dir_fd=self.parent)
            os.fsync(self.parent)
        except OSError:
            failed = True
        require(not failed, 'CLEANUP_FAILED')


class Reader:
    def __init__(self, stream, compressed_size, limits):
        self.stream, self.size, self.limits = stream, compressed_size, limits
        self.count = 0

    def read(self, n):
        require(0 <= n <= CHUNK, 'READ_LIMIT')
        data = self.stream.read(n)
        self.count += len(data)
        require(self.count <= self.limits['max_tar_bytes'], 'TAR_LIMIT')
        require(self.count <= self.size * self.limits['max_ratio'], 'RATIO_LIMIT')
        return data

    def exact(self, n):
        chunks, count = [], 0
        require(n <= CHUNK, 'READ_LIMIT')
        while count < n:
            chunk = self.read(n - count)
            require(chunk, 'TRUNCATED_ARCHIVE')
            chunks.append(chunk)
            count += len(chunk)
        return b''.join(chunks)

    def padding(self, size):
        padding = (-size) % 512
        require(not any(self.exact(padding)), 'INVALID_PADDING')


def pax_fields(data):
    fields, offset = {}, 0
    while offset < len(data):
        space = data.find(b' ', offset)
        require(space > offset and data[offset:space].isdigit(), 'INVALID_PAX')
        length = int(data[offset:space])
        require(length > space - offset + 2 and offset + length <= len(data),
                'INVALID_PAX')
        record = data[space + 1:offset + length]
        require(record.endswith(b'\n') and b'=' in record, 'INVALID_PAX')
        try:
            raw_key, raw_value = record[:-1].split(b'=', 1)
            key = raw_key.decode('utf-8', 'strict')
            # bsdtar carries binary xattrs (including embedded NULs) in PAX.
            # Those bounded bytes are ignored, never interpreted or applied.
            opaque = key.startswith(('LIBARCHIVE.xattr.', 'SCHILY.xattr.'))
            value = '' if opaque else raw_value.decode('utf-8', 'strict')
        except UnicodeError as exc:
            raise ExtractError('INVALID_PAX') from exc
        require(key not in fields and '\0' not in value, 'INVALID_PAX')
        # Metadata may be carried by bsdtar, but it is NEVER applied to disk.
        require(key in {'path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid',
                        'uname', 'gname', 'hdrcharset', 'SCHILY.fflags'}
                or key.startswith('LIBARCHIVE.xattr.')
                or key.startswith('SCHILY.xattr.'), 'UNSUPPORTED_PAX')
        if key == 'hdrcharset':
            require(value == 'UTF-8', 'UNSUPPORTED_PAX')
        fields[key] = value
        offset += length
    return fields


def tar_name(raw, directory, limits):
    if raw in ('.', './'):
        require(directory, 'INVALID_ROOT')
        return ''
    if raw.startswith('./'):
        raw = raw[2:]
    if directory and raw.endswith('/'):
        raw = raw[:-1]
    return safe_path(raw, limits)


def extract_tar(reader, tree, files, dirs, limits):
    seen, found, pending = set(), set(), None
    count, total = 0, 0
    while True:
        header = reader.exact(512)
        if header == bytes(512):
            require(reader.exact(512) == bytes(512) and pending is None,
                    'INVALID_TAR_END')
            while True:
                tail = reader.read(CHUNK)
                if not tail:
                    break
                require(not any(tail), 'TRAILING_ARCHIVE_DATA')
            require(reader.count % 512 == 0, 'TRUNCATED_ARCHIVE')
            break
        count += 1
        require(count <= limits['max_entries'], 'ENTRY_LIMIT')
        # Reject hidden nonzero data after a NUL in fixed-size pathname fields.
        for field in (header[:100], header[157:257], header[345:500]
                      if header[257:263] == b'ustar\0' else b''):
            if b'\0' in field:
                require(not any(field[field.index(0):]), 'INVALID_TAR_NAME')
        try:
            member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
        except (tarfile.HeaderError, UnicodeError, ValueError) as exc:
            raise ExtractError('INVALID_TAR_HEADER') from exc
        require(member.size >= 0, 'INVALID_SIZE')
        if member.type in (tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME):
            require(pending is None and member.size <= limits['max_pax_bytes']
                    and member.size <= CHUNK, 'EXTENSION_LIMIT')
            body = reader.exact(member.size)
            reader.padding(member.size)
            if member.type == tarfile.XHDTYPE:
                pending = pax_fields(body)
            else:
                require(body.endswith(b'\0') and b'\0' not in body[:-1],
                        'INVALID_TAR_NAME')
                try:
                    pending = {'path': body[:-1].decode('utf-8', 'strict')}
                except UnicodeError as exc:
                    raise ExtractError('INVALID_TAR_NAME') from exc
            continue
        require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE),
                'UNSUPPORTED_ENTRY')
        require(not member.linkname, 'UNSUPPORTED_ENTRY')
        fields, pending = pending or {}, None
        size = member.size
        if 'size' in fields:
            require(re.fullmatch('[0-9]+', fields['size']), 'INVALID_SIZE')
            size = int(fields['size'])
        isdir = member.type == tarfile.DIRTYPE
        # TarInfo strips every trailing slash on directories. Validate the raw
        # spelling ourselves so double slashes/empty components cannot vanish.
        raw_name = header[:100].split(b'\0', 1)[0].decode('utf-8', 'strict')
        if header[257:263] == b'ustar\0':
            prefix = header[345:500].split(b'\0', 1)[0].decode('utf-8', 'strict')
            if prefix:
                raw_name = prefix + '/' + raw_name
        name = tar_name(fields.get('path', raw_name), isdir, limits)
        require(name not in seen, 'DUPLICATE_ENTRY')
        seen.add(name)
        if isdir:
            require(size == 0 and (not name or name in dirs), 'UNEXPECTED_DIRECTORY')
            continue  # validated directories are created from the inventory
        require(name in files, 'UNEXPECTED_OBJECT')
        expected_size, digest = files[name]
        require(size <= limits['max_file_bytes'], 'FILE_LIMIT')
        require(size == expected_size, 'SIZE_MISMATCH')
        hasher, actual = hashlib.sha256(), 0
        with tree.file(name) as out:
            while actual < size:
                chunk = reader.exact(min(CHUNK, size - actual))
                view = memoryview(chunk)
                while view:
                    written = os.write(out, view)
                    require(written > 0, 'WRITE_FAILED')
                    view = view[written:]
                hasher.update(chunk)
                actual += len(chunk)
                total += len(chunk)
                require(total <= limits['max_total_bytes'], 'TOTAL_LIMIT')
            require(actual == expected_size, 'SIZE_MISMATCH')
            require(hasher.hexdigest() == digest, 'SHA256_MISMATCH')
            require(os.fstat(out).st_size == actual, 'SIZE_MISMATCH')
        reader.padding(size)
        found.add(name)
    require(found == files.keys(), 'MISSING_OBJECT')
    return count, total


def extract(archive, manifest, destination, buckets=None, **limits):
    check_primitives()
    limits = DEFAULTS | limits
    require(all(type(v) is int and v > 0 for v in limits.values()), 'INVALID_LIMIT')
    files, dirs, bucket_set, expected_total = inventory(manifest, buckets, limits)
    publisher = native_publisher()
    executable = shutil.which('zstd')
    require(executable is not None, 'ZSTD_UNAVAILABLE')
    tree = None
    with ExitStack() as stack:
        source, before = stack.enter_context(input_file(archive, limits['max_archive_bytes']))
        require(before.st_size > 0 and source.read(4) == b'\x28\xb5\x2f\xfd',
                'INVALID_ZSTD')
        source.seek(0)
        parent, base = stack.enter_context(parent_fd(destination))
        st = os.fstat(parent)
        require(st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o700,
                'PRIVATE_PARENT_REQUIRED')
        try:
            os.stat(base, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ExtractError('DESTINATION_EXISTS')
        os.fsync(parent)  # refuse filesystems without directory durability support
        try:
            tree = Tree(parent)
            tree.create()
            for name in sorted(dirs, key=lambda p: (p.count('/'), p)):
                tree.mkdir(name)
            with subprocess.Popen([executable, '-d', '-q', '-c', '-M64MB', '--'],
                                  stdin=source, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, close_fds=True,
                                  env={'PATH': os.defpath, 'LC_ALL': 'C'}) as proc:
                try:
                    reader = Reader(proc.stdout, before.st_size, limits)
                    entries, total = extract_tar(reader, tree, files, dirs, limits)
                    require(proc.wait() == 0, 'ZSTD_FAILED')
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
            require(total == expected_total, 'TOTAL_MISMATCH')
            require(snapshot(os.fstat(source.fileno())) == snapshot(before), 'INPUT_CHANGED')
            tree.verify_and_sync()
            tree.publish(base, publisher)
            return {'status': 'ok', 'operation': 'safe-extract-storage',
                    'objectCount': len(files), 'bucketCount': len(bucket_set) if
                    bucket_set is not None else len({p.split('/')[0] for p in files}),
                    'bucketInventoryVerified': buckets is not None,
                    'totalBytes': total, 'archiveEntries': entries,
                    'publication': 'atomic-no-replace', 'peakRssBytes': peak_rss(),
                    'decompressorPeakRssBytes': peak_rss(resource.RUSAGE_CHILDREN)}
        finally:
            if tree is not None:
                try:
                    with blocked_signals():
                        tree.cleanup()
                finally:
                    if tree.fd is not None:
                        os.close(tree.fd)


def peak_rss(who=resource.RUSAGE_SELF):
    value = resource.getrusage(who).ru_maxrss
    return value if sys.platform == 'darwin' else value * 1024


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--buckets', help='authenticated Helper #3 buckets.json; authorizes empty buckets')
    for name, default in DEFAULTS.items():
        parser.add_argument('--' + name.replace('_', '-'), type=int, default=default)
    args = parser.parse_args(argv)
    os.umask(0o077)

    def interrupted(signum, _frame):
        raise Interrupted(signum)

    previous = {sig: signal.signal(sig, interrupted) for sig in SIGNALS}
    try:
        result = extract(**vars(args))
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except (ExtractError, OSError, ValueError, RecursionError) as exc:
        code = exc.code if isinstance(exc, ExtractError) else (
            'FILESYSTEM_ERROR' if isinstance(exc, OSError) else 'INVALID_INPUT')
        # No paths, archive member names, object bytes, env or external stderr.
        print(json.dumps({'status': 'error', 'error': {'code': code},
                          'recovery': 'never accept hidden staging; inspect private area before retry'}),
              file=sys.stderr)
        return 128 + exc.signum if isinstance(exc, Interrupted) else 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    sys.exit(main())
