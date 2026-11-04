#!/usr/bin/env python3
"""Local synthetic adversarial acceptance; no credentials, services or network.

Run: python3 -B tests/backup/safe-extract-storage.test.py -v
Optional existing Helper #3 integration fixture: set SAFE_EXTRACT_EXPORT_HELPER
 to its absolute source path. No files from earlier helpers are copied/changed.
"""
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/backup/safe-extract-storage.py'
SPEC = importlib.util.spec_from_file_location('safe_extract_storage', HELPER)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
ZSTD = shutil.which('zstd')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def row(path='a.bin', data=b'synthetic\0\xff', bucket='contracts', **changes):
    return {'bucket': bucket, 'path': path, 'size': len(data),
            'sha256': digest(data), 'objectId': None,
            'contentType': 'application/octet-stream', 'mimeType': 'application/octet-stream',
            'version': None, 'etag': None, 'metadata': None,
            'createdAt': None, 'updatedAt': None, 'lastAccessedAt': None} | changes


def entry(name, data=b'', kind=tarfile.REGTYPE, **changes):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = len(data)
    info.mode = 0o7777  # untrusted metadata must never reach output modes
    for key, value in changes.items():
        setattr(info, key, value)
    return info, data


@unittest.skipUnless(ZSTD, 'zstd executable is required')
class SafeExtractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='safe-extract-test-')
        self.base = Path(self.temp.name).resolve()
        self.base.chmod(0o700)
        self.archive = self.base / 'objects.tar.zst'
        self.manifest = self.base / 'storage-manifest.json'
        self.buckets = self.base / 'buckets.json'
        self.destination = self.base / 'objects'
        self.raw = self.base / 'fixture.tar'
        self.data = b'synthetic\0\xff'
        self.rows = [row(data=self.data)]
        self.write_manifest()
        self.make_archive([entry('./', kind=tarfile.DIRTYPE),
                           entry('./contracts/', kind=tarfile.DIRTYPE),
                           entry('./contracts/a.bin', self.data)])

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self, rows=None):
        if rows is not None:
            self.rows = rows
        self.manifest.write_text(json.dumps(self.rows, ensure_ascii=False), encoding='utf-8')

    def compress(self):
        with self.archive.open('wb') as output:
            subprocess.run([ZSTD, '-q', '-c', str(self.raw)], stdout=output, check=True)

    def make_archive(self, entries, fmt=tarfile.USTAR_FORMAT):
        with tarfile.open(self.raw, 'w', format=fmt, encoding='utf-8') as archive:
            for info, data in entries:
                archive.addfile(info, io.BytesIO(data))
        self.compress()

    def run_extract(self, **options):
        return helper.extract(str(self.archive), str(self.manifest),
                              str(self.destination), **options)

    def assert_rejected(self, code=None, **options):
        with self.assertRaises((helper.ExtractError, OSError)) as caught:
            self.run_extract(**options)
        if code:
            self.assertEqual(getattr(caught.exception, 'code', None), code)
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.base.glob('.safe-extract-*')), [])
        return caught.exception

    def cli(self, *args, **options):
        return subprocess.run([sys.executable, '-B', str(HELPER), '--archive', str(self.archive),
                               '--manifest', str(self.manifest), '--destination', str(self.destination),
                               *args], capture_output=True, text=True, timeout=30, **options)

    def test_valid_binary_archive_exact_bytes_and_private_modes(self):
        result = self.run_extract()
        self.assertEqual(result['objectCount'], 1)
        self.assertEqual(result['totalBytes'], len(self.data))
        self.assertEqual((self.destination / 'contracts/a.bin').read_bytes(), self.data)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.destination / 'contracts').stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.destination / 'contracts/a.bin').stat().st_mode), 0o600)
        self.assertEqual(self.manifest.read_text(), json.dumps(self.rows, ensure_ascii=False))
        self.assertEqual(result['publication'], 'atomic-no-replace')

    def test_valid_empty_tar_and_zero_bucket_inventory(self):
        self.write_manifest([])
        self.make_archive([])
        self.buckets.write_text('[]')
        self.assertEqual(self.run_extract(buckets=str(self.buckets))['bucketCount'], 0)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_zero_byte_archive_is_invalid(self):
        self.archive.write_bytes(b'')
        self.assert_rejected('INVALID_ZSTD')

    def test_explicit_empty_buckets_from_helper_three(self):
        self.write_manifest([])
        self.buckets.write_text('[{"id":"empty-bucket","name":"empty-bucket","public":false}]')
        self.make_archive([entry('./', kind=tarfile.DIRTYPE),
                           entry('./empty-bucket/', kind=tarfile.DIRTYPE)])
        result = self.run_extract(buckets=str(self.buckets))
        self.assertTrue(result['bucketInventoryVerified'])
        self.assertEqual(result['bucketCount'], 1)
        self.assertTrue((self.destination / 'empty-bucket').is_dir())

    def test_empty_bucket_without_inventory_fails_closed(self):
        self.write_manifest([])
        self.make_archive([entry('empty-bucket/', kind=tarfile.DIRTYPE)])
        self.assert_rejected('UNEXPECTED_DIRECTORY')

    def test_empty_bucket_inventory_with_no_explicit_directory_entry(self):
        self.write_manifest([])
        self.make_archive([])
        self.buckets.write_text('[{"id":"empty-bucket"}]')
        self.run_extract(buckets=str(self.buckets))
        self.assertTrue((self.destination / 'empty-bucket').is_dir())

    def test_multi_bucket_nested_and_zero_byte_objects(self):
        self.write_manifest([row('nested/a', b''), row('nested/b', b'B'),
                             row('x', b'X', bucket='survey-photos')])
        self.make_archive([entry('contracts/nested/b', b'B'),
                           entry('survey-photos/x', b'X'), entry('contracts/nested/a')])
        self.assertEqual(self.run_extract()['objectCount'], 3)
        self.assertEqual((self.destination / 'contracts/nested/a').read_bytes(), b'')

    def test_absolute_path(self):
        self.make_archive([entry('/escape', self.data)])
        self.assert_rejected('INVALID_PATH')

    def test_parent_traversal(self):
        for name in ('../escape', './contracts/../../escape', 'contracts/../a.bin'):
            with self.subTest(name=name):
                self.make_archive([entry(name, self.data)])
                self.assert_rejected('INVALID_PATH')

    def test_windows_drive_paths(self):
        for name in ('C:/escape', 'C:escape', 'contracts/C:/escape'):
            with self.subTest(name=name):
                self.make_archive([entry(name, self.data)])
                self.assert_rejected('INVALID_PATH')

    def test_unc_paths_and_backslashes(self):
        for name in ('//server/share', '\\\\server\\share', 'contracts\\a.bin'):
            with self.subTest(name=name):
                self.make_archive([entry(name, self.data)])
                self.assert_rejected('INVALID_PATH')

    def test_empty_dot_and_invalid_components(self):
        for name in ('', 'contracts//a.bin', 'contracts/./a.bin', '././contracts/a.bin',
                     'contracts/a.bin/', 'contracts//'):
            with self.subTest(name=name):
                self.make_archive([entry(name, self.data)])
                self.assert_rejected()

    def test_directory_empty_components_not_silently_stripped_by_tarinfo(self):
        self.make_archive([entry('./contracts//', kind=tarfile.DIRTYPE)])
        self.assert_rejected('INVALID_PATH')

    def test_nul_in_pax_path(self):
        self.make_archive([entry('placeholder', self.data,
                                 pax_headers={'path': 'contracts/a.bin\0escape'})], tarfile.PAX_FORMAT)
        self.assert_rejected('INVALID_PAX')

    def test_nul_in_fixed_header_name_with_hidden_suffix(self):
        self.make_archive([entry('contracts/a.bin\0evil', self.data)])
        self.assert_rejected('INVALID_TAR_NAME')

    def test_symlink(self):
        self.make_archive([entry('contracts/a.bin', kind=tarfile.SYMTYPE, linkname='/outside')])
        self.assert_rejected('UNSUPPORTED_ENTRY')

    def test_hardlink(self):
        self.make_archive([entry('contracts/a.bin', kind=tarfile.LNKTYPE, linkname='contracts/x')])
        self.assert_rejected('UNSUPPORTED_ENTRY')

    def test_fifo(self):
        self.make_archive([entry('contracts/a.bin', kind=tarfile.FIFOTYPE)])
        self.assert_rejected('UNSUPPORTED_ENTRY')

    def test_socket_character_block_device_and_unknown_types(self):
        for kind in (b's', tarfile.CHRTYPE, tarfile.BLKTYPE, b'V', tarfile.GNUTYPE_SPARSE):
            with self.subTest(kind=kind):
                self.make_archive([entry('contracts/a.bin', kind=kind)])
                self.assert_rejected('UNSUPPORTED_ENTRY')

    def test_duplicate_normalized_entries(self):
        self.make_archive([entry('contracts/a.bin', self.data),
                           entry('./contracts/a.bin', self.data)])
        self.assert_rejected('DUPLICATE_ENTRY')

    def test_duplicate_root_and_directory_entries(self):
        for name in ('./', 'contracts/'):
            with self.subTest(name=name):
                self.make_archive([entry(name, kind=tarfile.DIRTYPE),
                                   entry(name, kind=tarfile.DIRTYPE)])
                self.assert_rejected('DUPLICATE_ENTRY')

    def test_duplicate_manifest_identity_and_object_id(self):
        self.write_manifest(self.rows * 2)
        self.assert_rejected('DUPLICATE_IDENTITY')
        self.write_manifest([row('a', b'', objectId='same-id'), row('b', b'', objectId='same-id')])
        self.assert_rejected('DUPLICATE_OBJECT_ID')

    def test_parent_child_file_conflict(self):
        self.write_manifest([row('a', b''), row('a/child', b'')])
        self.assert_rejected('PARENT_CHILD_CONFLICT')

    def test_unicode_nfc_nfd_file_and_ancestor_collision(self):
        for paths in (('caf\u00e9', 'cafe\u0301'), ('caf\u00e9/a', 'cafe\u0301/b')):
            with self.subTest(paths=paths):
                self.write_manifest([row(p, b'') for p in paths])
                self.assert_rejected('FILENAME_COLLISION')

    def test_case_file_and_directory_collisions(self):
        for paths in (('File', 'file'), ('Dir/a', 'dir/b'), ('A', 'a/b')):
            with self.subTest(paths=paths):
                self.write_manifest([row(p, b'') for p in paths])
                self.assert_rejected('FILENAME_COLLISION')

    def test_unicode_identity_preserved_and_pax_long_path(self):
        name = 'cafe\u0301/' + 'x' * 110 + '.bin'
        self.write_manifest([row(name, self.data)])
        original = self.manifest.read_bytes()
        self.make_archive([entry('contracts/' + name, self.data)], tarfile.PAX_FORMAT)
        self.run_extract()
        self.assertEqual((self.destination / ('contracts/' + name)).read_bytes(), self.data)
        self.assertEqual(self.manifest.read_bytes(), original)

    def test_gnu_longname_tar(self):
        name = 'x' * 110
        self.write_manifest([row(name, self.data)])
        self.make_archive([entry('contracts/' + name, self.data)], tarfile.GNU_FORMAT)
        self.run_extract()
        self.assertEqual((self.destination / ('contracts/' + name)).read_bytes(), self.data)

    def test_missing_object(self):
        self.make_archive([])
        self.assert_rejected('MISSING_OBJECT')

    def test_unexpected_object(self):
        self.make_archive([entry('contracts/unlisted', self.data)])
        self.assert_rejected('UNEXPECTED_OBJECT')

    def test_unexpected_directory(self):
        self.make_archive([entry('contracts/unlisted/', kind=tarfile.DIRTYPE)])
        self.assert_rejected('UNEXPECTED_DIRECTORY')

    def test_modified_bytes(self):
        self.make_archive([entry('contracts/a.bin', b'X' * len(self.data))])
        self.assert_rejected('SHA256_MISMATCH')

    def test_wrong_sha256(self):
        self.write_manifest([row(data=self.data, sha256='0' * 64)])
        self.assert_rejected('SHA256_MISMATCH')

    def test_wrong_size(self):
        self.write_manifest([row(data=self.data, size=len(self.data) + 1)])
        self.assert_rejected('SIZE_MISMATCH')

    def test_invalid_manifest_schema_sizes_hashes_paths_and_json(self):
        for rows in ({}, [row(size=True)], [row(size=-1)], [row(sha256='bad')],
                     [row(bucket='../escape')], [row(path='a\0b')], [row(path='\ud800')]):
            with self.subTest(rows=repr(rows)):
                self.manifest.write_text(json.dumps(rows), encoding='utf-8')
                self.assert_rejected()
        for text in ('[] []', '[{"bucket":"contracts","bucket":"other"}]', '[NaN]', '['):
            with self.subTest(text=text):
                self.manifest.write_text(text)
                self.assert_rejected('INVALID_JSON')

    def test_bucket_identity_and_duplicate_inventory(self):
        self.buckets.write_text('[{"id":"another-bucket"}]')
        self.assert_rejected('BUCKET_MISMATCH', buckets=str(self.buckets))
        self.buckets.write_text('[{"id":"contracts"},{"id":"contracts"}]')
        self.assert_rejected('DUPLICATE_BUCKET', buckets=str(self.buckets))

    def test_truncated_zstd(self):
        self.archive.write_bytes(self.archive.read_bytes()[:-6])
        self.assert_rejected()

    def test_truncated_tar_file_body_and_missing_end_markers(self):
        for end in (512 + 3, 1536, 0):
            with self.subTest(end=end):
                self.make_archive([entry('contracts/a.bin', self.data)])
                self.raw.write_bytes(self.raw.read_bytes()[:end])
                self.compress()
                self.assert_rejected('TRUNCATED_ARCHIVE')

    def test_corrupt_tar_checksum(self):
        raw = bytearray(self.raw.read_bytes())
        raw[0] ^= 1
        self.raw.write_bytes(raw)
        self.compress()
        self.assert_rejected('INVALID_TAR_HEADER')

    def test_corrupt_zstd_and_unsupported_compression(self):
        original = self.archive.read_bytes()
        for data in (b'not an archive', b'\x1f\x8bgarbage', original[:8] + bytes(16)):
            with self.subTest(data=data[:8]):
                self.archive.write_bytes(data)
                self.assert_rejected()

    def test_appended_tar_and_trailing_garbage(self):
        self.raw.write_bytes(self.raw.read_bytes() + b'evil')
        self.compress()
        self.assert_rejected('TRAILING_ARCHIVE_DATA')

    def test_zstd_corruption_after_complete_tar(self):
        self.archive.write_bytes(self.archive.read_bytes() + b'garbage')
        self.assert_rejected('ZSTD_FAILED')

    def test_decompression_bomb_ratio_and_absolute_tar_limit(self):
        self.assert_rejected('RATIO_LIMIT', max_ratio=1)
        self.assert_rejected('TAR_LIMIT', max_tar_bytes=100)

    def test_archive_manifest_file_total_limits(self):
        self.assert_rejected('INPUT_LIMIT', max_archive_bytes=1)
        self.assert_rejected('INPUT_LIMIT', max_manifest_bytes=2)
        self.assert_rejected('FILE_LIMIT', max_file_bytes=1)
        self.assert_rejected('TOTAL_LIMIT', max_total_bytes=1)

    def test_excessive_entry_count_including_extensions(self):
        self.assert_rejected('ENTRY_LIMIT', max_entries=2)
        self.make_archive([entry('contracts/', kind=tarfile.DIRTYPE),
                           entry('contracts/a.bin', self.data),
                           entry('./', kind=tarfile.DIRTYPE),
                           entry('contracts/a.bin', self.data)])
        self.assert_rejected('ENTRY_LIMIT', max_entries=3)

    def test_excessive_directory_depth_and_path_length(self):
        self.write_manifest([row('a/b/c/d/e', b'')])
        self.assert_rejected('PATH_LIMIT', max_depth=4)
        self.write_manifest([row('a' * 256, b'')])
        self.assert_rejected('INVALID_PATH')
        self.write_manifest([row('a', b'')])
        self.assert_rejected('PATH_LIMIT', max_path_bytes=5)

    def test_pax_bomb_and_sparse_extensions(self):
        self.make_archive([entry('contracts/a.bin', self.data,
                                 pax_headers={'path': 'x' * 20000})], tarfile.PAX_FORMAT)
        self.assert_rejected('EXTENSION_LIMIT')
        self.make_archive([entry('contracts/a.bin', self.data,
                                 pax_headers={'GNU.sparse.size': '1000000000'})], tarfile.PAX_FORMAT)
        self.assert_rejected('UNSUPPORTED_PAX')

    def test_binary_pax_xattr_is_bounded_ignored_and_never_applied(self):
        body = b'SCHILY.xattr.user.synthetic=\xff\x00opaque\n'
        size = len(body) + 3
        while len(str(size)) + 1 + len(body) != size:
            size = len(str(size)) + 1 + len(body)
        record = str(size).encode() + b' ' + body
        self.make_archive([entry('./PaxHeader', record, tarfile.XHDTYPE),
                           entry('contracts/a.bin', self.data)])
        self.run_extract()
        target = self.destination / 'contracts/a.bin'
        self.assertEqual(target.read_bytes(), self.data)
        if hasattr(os, 'listxattr'):
            self.assertNotIn('user.synthetic', os.listxattr(target))

    def test_malformed_duplicate_and_dangling_pax_records(self):
        for body in (b'999 path=contracts/a.bin\n', b'0 path=x\n',
                     b'10 path=x\n10 path=x\n'):
            with self.subTest(body=body):
                self.make_archive([entry('PaxHeader', body, tarfile.XHDTYPE),
                                   entry('contracts/a.bin', self.data)])
                self.assert_rejected('INVALID_PAX')
        self.make_archive([entry('PaxHeader', b'10 path=x\n', tarfile.XHDTYPE)])
        self.assert_rejected('INVALID_TAR_END')

    def test_untrusted_declared_size_is_bounded_before_reading_body(self):
        self.make_archive([entry('contracts/a.bin', self.data)])
        raw = self.raw.read_bytes()
        header = tarfile.TarInfo('contracts/a.bin')
        header.size = 17 * 1024**3
        self.raw.write_bytes(header.tobuf(format=tarfile.GNU_FORMAT) + raw[512:])
        self.compress()
        self.assert_rejected('FILE_LIMIT')

    def test_existing_destination_directory_file_and_dangling_symlink(self):
        for kind in ('dir', 'file', 'symlink'):
            with self.subTest(kind=kind):
                if kind == 'dir':
                    self.destination.mkdir()
                elif kind == 'file':
                    self.destination.write_bytes(b'foreign')
                else:
                    self.destination.symlink_to(self.base / 'missing')
                before = self.destination.lstat()
                with self.assertRaises(helper.ExtractError) as caught:
                    self.run_extract()
                self.assertEqual(caught.exception.code, 'DESTINATION_EXISTS')
                self.assertEqual(helper.identity(before), helper.identity(self.destination.lstat()))
                if kind == 'dir':
                    self.destination.rmdir()
                else:
                    self.destination.unlink()

    def test_concurrent_destination_creation_at_native_publication(self):
        publish = helper.native_publisher()
        def race(parent, source, destination):
            os.mkdir(destination, 0o700, dir_fd=parent)  # empty is hardest case
            self.foreign_inode = self.destination.stat().st_ino
            publish(parent, source, destination)
        with mock.patch.object(helper, 'native_publisher', return_value=race):
            with self.assertRaises(OSError) as caught:
                self.run_extract()
        self.assertEqual(caught.exception.errno, errno.EEXIST)
        self.assertEqual(self.destination.stat().st_ino, self.foreign_inode)
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertEqual(list(self.base.glob('.safe-extract-*')), [])

    def test_concurrent_destination_symlink_at_publication(self):
        publish = helper.native_publisher()
        outside = self.base / 'outside'
        outside.mkdir()
        def race(parent, source, destination):
            os.symlink(str(outside), destination, dir_fd=parent)
            publish(parent, source, destination)
        with mock.patch.object(helper, 'native_publisher', return_value=race):
            with self.assertRaises(OSError):
                self.run_extract()
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(list(self.base.glob('.safe-extract-*')), [])

    def test_symlink_ancestors_of_all_inputs_and_destination(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.base, target_is_directory=True)
        for option in ('archive', 'manifest', 'destination'):
            with self.subTest(option=option):
                args = {k: str(getattr(self, k)) for k in ('archive', 'manifest', 'destination')}
                args[option] = str(alias / Path(args[option]).name)
                with self.assertRaises(OSError):
                    helper.extract(**args)
                self.assertFalse(self.destination.exists())

    def test_input_final_symlink_fifo_and_hardlink(self):
        saved = self.base / 'saved'
        self.archive.rename(saved)
        for kind in ('symlink', 'fifo', 'hardlink'):
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    self.archive.symlink_to(saved)
                elif kind == 'fifo':
                    os.mkfifo(self.archive)
                else:
                    os.link(saved, self.archive)
                self.assert_rejected()
                self.archive.unlink()

    def test_stage_ancestor_replaced_by_symlink_cannot_escape(self):
        outside = self.base / 'outside'
        outside.mkdir()
        original = helper.Tree.file
        def attack(tree, name):
            os.rmdir('contracts', dir_fd=tree.fd)
            os.symlink(str(outside), 'contracts', dir_fd=tree.fd)
            return original(tree, name)
        with mock.patch.object(helper.Tree, 'file', attack):
            with self.assertRaises(helper.ExtractError) as caught:
                self.run_extract()
        self.assertEqual(caught.exception.code, 'CLEANUP_FAILED')
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse(self.destination.exists())
        self.assertEqual(len(list(self.base.glob('.safe-extract-*'))), 1)

    def test_disk_full_after_partial_write(self):
        original, count = os.write, 0
        def disk_full(fd, data):
            nonlocal count
            if count:
                raise OSError(errno.ENOSPC, 'synthetic disk full')
            count += 1
            return original(fd, data[:2])
        with mock.patch.object(helper.os, 'write', side_effect=disk_full):
            error = self.assert_rejected()
        self.assertEqual(error.errno, errno.ENOSPC)

    def test_short_writes_are_completed(self):
        original = os.write
        with mock.patch.object(helper.os, 'write', side_effect=lambda fd, data: original(fd, data[:2])):
            self.run_extract()
        self.assertEqual((self.destination / 'contracts/a.bin').read_bytes(), self.data)

    def test_permission_failure_during_file_creation(self):
        original = os.open
        def denied(path, flags, *args, **kwargs):
            if flags & os.O_WRONLY:
                raise PermissionError(errno.EACCES, 'synthetic access denied')
            return original(path, flags, *args, **kwargs)
        with mock.patch.object(helper.os, 'open', side_effect=denied):
            # check_primitives uses function identity; validate it before patch.
            with mock.patch.object(helper, 'check_primitives'):
                error = self.assert_rejected()
        self.assertEqual(error.errno, errno.EACCES)

    def test_nonprivate_parent_and_no_safe_primitive_fail_closed(self):
        self.base.chmod(0o755)
        self.assert_rejected('PRIVATE_PARENT_REQUIRED')
        self.base.chmod(0o700)
        with mock.patch.object(helper, 'native_publisher', side_effect=helper.ExtractError('ATOMIC_RENAME_UNAVAILABLE')):
            self.assert_rejected('ATOMIC_RENAME_UNAVAILABLE')

    def test_fsync_failure_before_publish_cleans_up(self):
        original, count = os.fsync, 0
        def fail_file_sync(fd):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError(errno.EIO, 'synthetic fsync failed')
            return original(fd)
        with mock.patch.object(helper.os, 'fsync', side_effect=fail_file_sync):
            self.assert_rejected()

    def test_postpublication_sync_failure_never_blindly_rolls_back(self):
        original = helper.Tree.publish
        def failed_confirmation(tree, destination, publisher):
            original(tree, destination, publisher)
            raise OSError(errno.EIO, 'post-rename confirmation lost')
        with mock.patch.object(helper.Tree, 'publish', failed_confirmation):
            with self.assertRaises(OSError):
                self.run_extract()
        self.assertEqual((self.destination / 'contracts/a.bin').read_bytes(), self.data)
        self.assertEqual(list(self.base.glob('.safe-extract-*')), [])

    def test_cleanup_failure_is_reported_and_retains_only_private_staging(self):
        self.write_manifest([row(data=self.data, sha256='0' * 64)])
        with mock.patch.object(helper.os, 'unlink', side_effect=PermissionError(errno.EACCES, 'synthetic cleanup failure')):
            with mock.patch.object(helper, 'check_primitives'):
                with self.assertRaises(helper.ExtractError) as caught:
                    self.run_extract()
        self.assertEqual(caught.exception.code, 'CLEANUP_FAILED')
        self.assertFalse(self.destination.exists())
        remnants = list(self.base.glob('.safe-extract-*'))
        self.assertEqual(len(remnants), 1)
        self.assertEqual(stat.S_IMODE(remnants[0].stat().st_mode), 0o700)

    def test_cleanup_never_deletes_foreign_unjournaled_entries(self):
        original = helper.extract_tar
        def inject(*args):
            tree = args[1]
            fd = os.open('foreign', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=tree.fd)
            os.write(fd, b'foreign invocation')
            os.close(fd)
            return original(*args)
        with mock.patch.object(helper, 'extract_tar', inject):
            with self.assertRaises(helper.ExtractError) as caught:
                self.run_extract()
        self.assertEqual(caught.exception.code, 'CLEANUP_FAILED')
        remnants = list(self.base.glob('.safe-extract-*'))
        self.assertEqual((remnants[0] / 'foreign').read_bytes(), b'foreign invocation')
        self.assertFalse(self.destination.exists())

    def test_source_mutation_before_publication_rejected(self):
        original = helper.extract_tar
        def mutate(*args):
            result = original(*args)
            with self.archive.open('ab') as output:
                output.write(b'changed')
            return result
        with mock.patch.object(helper, 'extract_tar', mutate):
            self.assert_rejected('INPUT_CHANGED')

    def test_provider_and_network_blocked_and_no_sensitive_output(self):
        with mock.patch.object(socket, 'socket', side_effect=AssertionError('NETWORK BLOCKED')):
            self.run_extract()
        result = self.cli('--url', 'https://synthetic.invalid')
        self.assertNotEqual(result.returncode, 0)
        self.destination.rename(self.base / 'first-result')
        result = subprocess.run([sys.executable, '-B', str(HELPER), '--archive',
                                 'https://synthetic.invalid/archive', '--manifest', str(self.manifest),
                                 '--destination', str(self.destination)], capture_output=True, text=True)
        self.assertEqual(json.loads(result.stderr)['error']['code'], 'LOCAL_PATH_REQUIRED')
        self.assertNotIn('synthetic.invalid', result.stderr)
        self.assertNotIn('contracts/a.bin', result.stderr)

    def prepare_large(self, megabytes):
        # Bounded-memory fixture generation; repeated random 1 MiB block keeps
        # the compression ratio within the default even at 256 MiB.
        source = self.base / 'large.bin'
        block, hasher = os.urandom(1024**2), hashlib.sha256()
        with source.open('wb') as output:
            for _ in range(megabytes):
                output.write(block)
                hasher.update(block)
        self.write_manifest([row('large.bin', b'', size=megabytes * 1024**2, sha256=hasher.hexdigest())])
        with tarfile.open(self.raw, 'w', format=tarfile.USTAR_FORMAT) as archive:
            archive.add(source, arcname='contracts/large.bin', recursive=False)
        self.compress()
        return hasher.hexdigest()

    def wait_for_partial_file(self, proc):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and proc.poll() is None:
            for stage in self.base.glob('.safe-extract-*'):
                target = stage / 'contracts/large.bin'
                try:
                    if target.stat().st_size >= 65536:
                        return stage
                except FileNotFoundError:
                    pass
            time.sleep(0.001)
        proc.kill()
        proc.communicate()
        self.fail('did not observe a partial file before process exited')

    def test_sigterm_sigint_sighup_during_real_extraction(self):
        self.prepare_large(128)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=sig):
                with subprocess.Popen([sys.executable, '-B', str(HELPER), '--archive', str(self.archive),
                                       '--manifest', str(self.manifest), '--destination', str(self.destination)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as proc:
                    self.wait_for_partial_file(proc)
                    proc.send_signal(sig)
                    stdout, stderr = proc.communicate(timeout=15)
                self.assertEqual(proc.returncode, 128 + sig, stderr)
                self.assertEqual(stdout, '')
                self.assertEqual(json.loads(stderr)['error']['code'], 'INTERRUPTED')
                self.assertFalse(self.destination.exists())
                self.assertEqual(list(self.base.glob('.safe-extract-*')), [])

    def test_sigkill_leaves_unaccepted_staging_and_retry_never_reaps_it(self):
        self.prepare_large(128)
        with subprocess.Popen([sys.executable, '-B', str(HELPER), '--archive', str(self.archive),
                               '--manifest', str(self.manifest), '--destination', str(self.destination)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
            stage = self.wait_for_partial_file(proc)
            proc.kill()
            proc.communicate(timeout=15)
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        self.assertFalse(self.destination.exists())
        self.assertTrue(stage.is_dir())
        before = stage.stat().st_ino
        self.run_extract()
        self.assertTrue(self.destination.is_dir())
        self.assertEqual(stage.stat().st_ino, before)
        self.assertEqual(stat.S_IMODE(stage.stat().st_mode), 0o700)

    def test_large_file_bounded_memory_measured_rss(self):
        measurements = []
        for megabytes in (32, 256):
            expected_hash = self.prepare_large(megabytes)
            # /usr/bin/time gives a second OS-level observation independent of
            # the helper's self-report. zstd child peak is also reported.
            timing = ['-l'] if sys.platform == 'darwin' else ['-v']
            proc = subprocess.run(['/usr/bin/time', *timing, sys.executable, '-B', str(HELPER),
                                   '--archive', str(self.archive), '--manifest', str(self.manifest),
                                   '--destination', str(self.destination)], capture_output=True,
                                  text=True, timeout=60)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result['totalBytes'], megabytes * 1024**2)
            self.assertLess(result['peakRssBytes'], 96 * 1024**2)
            self.assertLess(result['decompressorPeakRssBytes'], 128 * 1024**2)
            actual = hashlib.sha256()
            with (self.destination / 'contracts/large.bin').open('rb') as stream:
                while chunk := stream.read(65536):
                    actual.update(chunk)
            self.assertEqual(actual.hexdigest(), expected_hash)
            import re
            pattern = r'(\d+)\s+maximum resident set size' if sys.platform == 'darwin' else r'Maximum resident set size \(kbytes\):\s*(\d+)'
            match = re.search(pattern, proc.stderr)
            self.assertIsNotNone(match, proc.stderr)
            external_peak = int(match[1]) * (1 if sys.platform == 'darwin' else 1024)
            self.assertLess(external_peak, 160 * 1024**2)
            measurements.append((megabytes, result['peakRssBytes'], result['decompressorPeakRssBytes'], external_peak))
            shutil.rmtree(self.destination)
        self.assertLess(abs(measurements[1][1] - measurements[0][1]), 32 * 1024**2)
        print('\nRSS_EVIDENCE_MIB_PYTHON_BYTES_ZSTD_BYTES_TIME_BYTES=' + json.dumps(measurements), flush=True)

    def test_native_b8_tar_with_copyfile_disabled_compatibility(self):
        source = self.base / 'exported-bytes'
        (source / 'contracts').mkdir(parents=True)
        (source / 'contracts/a.bin').write_bytes(self.data)
        with self.raw.open('wb') as output:
            subprocess.run(['tar', '-C', str(source), '-cf', '-', '.'], stdout=output,
                           check=True, env={'PATH': os.defpath, 'COPYFILE_DISABLE': '1'})
        self.compress()
        self.run_extract()
        self.assertEqual((self.destination / 'contracts/a.bin').read_bytes(), self.data)

    def test_unmodified_b8_tar_metadata_exact_set_gate(self):
        source = self.base / 'exported-bytes'
        (source / 'contracts').mkdir(parents=True)
        (source / 'contracts/a.bin').write_bytes(self.data)
        with self.raw.open('wb') as output:
            subprocess.run(['tar', '-C', str(source), '-cf', '-', '.'], stdout=output,
                           check=True, env={'PATH': os.defpath})
        with tarfile.open(self.raw) as archive:
            extras = [member.name for member in archive
                      if member.isfile() and member.name != './contracts/a.bin']
        self.compress()
        if extras:
            self.assert_rejected('UNEXPECTED_OBJECT')
            print('\nB8_DEFAULT_EXTRA_MEMBERS=' + json.dumps(extras), flush=True)
        else:
            self.run_extract()

    @unittest.skipUnless(os.environ.get('SAFE_EXTRACT_EXPORT_HELPER'),
                         'set SAFE_EXTRACT_EXPORT_HELPER to existing Helper #3 source')
    def test_actual_helper_three_export_to_b8_to_extract(self):
        source = self.base / 'synthetic-source'
        (source / 'contracts/nested').mkdir(parents=True)
        (source / 'empty-bucket').mkdir()
        (source / 'contracts/nested/café.bin').write_bytes(self.data)
        output = self.base / 'exported-bytes'
        proc = subprocess.run(['node', os.environ['SAFE_EXTRACT_EXPORT_HELPER'],
                               '--source-dir', str(source), '--out', str(output),
                               '--manifest', str(self.manifest) + '.export',
                               '--buckets', str(self.buckets)], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.manifest = Path(str(self.manifest) + '.export')
        with self.raw.open('wb') as raw:
            subprocess.run(['tar', '-C', str(output), '-cf', '-', '.'], stdout=raw, check=True,
                           env={'PATH': os.defpath, 'COPYFILE_DISABLE': '1'})
        self.compress()
        result = self.run_extract(buckets=str(self.buckets))
        self.assertEqual(result['bucketCount'], 2)
        self.assertEqual((self.destination / 'contracts/nested/café.bin').read_bytes(), self.data)
        self.assertTrue((self.destination / 'empty-bucket').is_dir())


if __name__ == '__main__':
    unittest.main()
