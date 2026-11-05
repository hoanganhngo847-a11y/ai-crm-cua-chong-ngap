#!/usr/bin/env python3
"""Integration tests for Helper #4 Targeted Runbook Amendment (B8 & R1).

Scope: Local synthetic verification of:
1. Finding B8: Prepending COPYFILE_DISABLE=1 to the tar archiving command
   prevents AppleDouble (._*) artifact emission on macOS bsdtar, eliminating
   UNEXPECTED_OBJECT / UNEXPECTED_DIRECTORY rejections in safe-extract-storage.py.
2. Finding R1: Passing --buckets "$RESTORE_ROOT/plaintext/storage/buckets.json"
   to safe-extract-storage.py authorizes empty buckets and correctly extracts
   and restores empty bucket directories.
3. Cross-reference B7: Verifies that storage-export.mjs produces buckets.json,
   which is archived via amended B8 and restored via amended R1.
4. Platform compatibility: Runs cleanly under both macOS (darwin) and Linux (linux).

Zero external network or hosted service connections are made.
All fixtures are synthetic and transient.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HELPER4 = REPO_ROOT / "scripts/backup/safe-extract-storage.py"
HELPER2 = REPO_ROOT / "scripts/backup/storage-export.mjs"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Helper4RunbookAmendmentTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="crm-helper4-amend-test-")
        self.base = Path(self.temp_dir.name).resolve()
        self.assertTrue(HELPER4.is_file(), f"Helper #4 missing at {HELPER4}")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_finding_b8_appledouble_prevention(self):
        """Finding B8: Test tar with and without COPYFILE_DISABLE=1 on macOS."""
        source = self.base / "storage-bytes"
        source.mkdir(parents=True)
        (source / "contracts").mkdir()
        doc = source / "contracts/doc1.bin"
        doc_content = b"Contract 2026 Payload"
        doc.write_bytes(doc_content)

        # On macOS, attempt to set an extended attribute to simulate macOS metadata
        is_macos = sys.platform == "darwin"
        if is_macos:
            try:
                subprocess.run(
                    ["xattr", "-w", "com.apple.metadata:kMDItemWhereFroms", "synthetic-origin", str(doc)],
                    check=False,
                    capture_output=True,
                )
            except Exception:
                pass

        manifest_data = [{
            "bucket": "contracts",
            "path": "doc1.bin",
            "size": len(doc_content),
            "sha256": sha256_bytes(doc_content),
            "id": "item-1",
        }]
        manifest_file = self.base / "storage-manifest.json"
        manifest_file.write_text(json.dumps(manifest_data), encoding="utf-8")

        # 1. Baseline B8: run tar without COPYFILE_DISABLE=1
        baseline_tar = self.base / "baseline.tar"
        baseline_zst = self.base / "baseline.tar.zst"
        with baseline_tar.open("wb") as out:
            subprocess.run(
                ["tar", "-C", str(source), "-cf", "-", "."],
                stdout=out,
                check=True,
                env={"PATH": os.environ.get("PATH", os.defpath)},
            )
        subprocess.run(["zstd", "-q", "-19", "-T0", str(baseline_tar), "-o", str(baseline_zst)], check=True)

        with tarfile.open(baseline_tar) as tf:
            baseline_members = tf.getnames()
        has_appledouble = any("._" in m for m in baseline_members)

        dest_baseline = self.base / "dest-baseline"
        proc_baseline = subprocess.run(
            [sys.executable, "-B", str(HELPER4),
             "--archive", str(baseline_zst),
             "--manifest", str(manifest_file),
             "--destination", str(dest_baseline)],
            capture_output=True,
            text=True,
        )

        if is_macos and has_appledouble:
            # Baseline fails on macOS due to unexpected AppleDouble entries
            self.assertNotEqual(proc_baseline.returncode, 0)
            self.assertIn("UNEXPECTED_OBJECT", proc_baseline.stderr)
            self.assertFalse(dest_baseline.exists())

        # 2. Amended B8: run tar with COPYFILE_DISABLE=1
        amended_tar = self.base / "amended.tar"
        amended_zst = self.base / "amended.tar.zst"
        amended_env = os.environ.copy()
        amended_env["COPYFILE_DISABLE"] = "1"

        with amended_tar.open("wb") as out:
            subprocess.run(
                ["tar", "-C", str(source), "-cf", "-", "."],
                stdout=out,
                check=True,
                env=amended_env,
            )
        subprocess.run(["zstd", "-q", "-19", "-T0", str(amended_tar), "-o", str(amended_zst)], check=True)

        with tarfile.open(amended_tar) as tf:
            amended_members = tf.getnames()

        # Strict check: NO AppleDouble entries must be present
        appledouble_entries = [m for m in amended_members if "._" in m]
        self.assertEqual(appledouble_entries, [], f"Found AppleDouble entries: {appledouble_entries}")

        dest_amended = self.base / "dest-amended"
        proc_amended = subprocess.run(
            [sys.executable, "-B", str(HELPER4),
             "--archive", str(amended_zst),
             "--manifest", str(manifest_file),
             "--destination", str(dest_amended)],
            capture_output=True,
            text=True,
        )

        self.assertEqual(proc_amended.returncode, 0, f"Amended extraction failed: {proc_amended.stderr}")
        result = json.loads(proc_amended.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["objectCount"], 1)
        self.assertEqual((dest_amended / "contracts/doc1.bin").read_bytes(), doc_content)

    def test_finding_r1_empty_bucket_restoration(self):
        """Finding R1: Verify that passing --buckets restores empty buckets."""
        source = self.base / "storage-bytes"
        source.mkdir(parents=True)
        (source / "active-bucket").mkdir()
        (source / "empty-bucket-alpha").mkdir()
        (source / "empty-bucket-beta").mkdir()

        file_payload = b"Active bucket file payload data 12345"
        (source / "active-bucket/file1.txt").write_bytes(file_payload)

        # Archive using amended B8 (COPYFILE_DISABLE=1)
        archive_tar = self.base / "objects.tar"
        archive_zst = self.base / "objects.tar.zst"
        env = os.environ.copy()
        env["COPYFILE_DISABLE"] = "1"
        with archive_tar.open("wb") as out:
            subprocess.run(["tar", "-C", str(source), "-cf", "-", "."], stdout=out, check=True, env=env)
        subprocess.run(["zstd", "-q", "-19", "-T0", str(archive_tar), "-o", str(archive_zst)], check=True)

        manifest_data = [{
            "bucket": "active-bucket",
            "path": "file1.txt",
            "size": len(file_payload),
            "sha256": sha256_bytes(file_payload),
            "id": "file-1",
        }]
        manifest_file = self.base / "storage-manifest.json"
        manifest_file.write_text(json.dumps(manifest_data), encoding="utf-8")

        buckets_data = [
            {"id": "active-bucket", "name": "active-bucket"},
            {"id": "empty-bucket-alpha", "name": "empty-bucket-alpha"},
            {"id": "empty-bucket-beta", "name": "empty-bucket-beta"},
        ]
        buckets_file = self.base / "buckets.json"
        buckets_file.write_text(json.dumps(buckets_data), encoding="utf-8")

        # 1. Baseline R1 without --buckets: MUST reject because empty buckets are unlisted in manifest
        dest_without_buckets = self.base / "dest-without-buckets"
        proc_without = subprocess.run(
            [sys.executable, "-B", str(HELPER4),
             "--archive", str(archive_zst),
             "--manifest", str(manifest_file),
             "--destination", str(dest_without_buckets)],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc_without.returncode, 0)
        self.assertIn("UNEXPECTED_DIRECTORY", proc_without.stderr)
        self.assertFalse(dest_without_buckets.exists(), "Destination must not be created on rejection")

        # 2. Amended R1 with --buckets: MUST succeed and create empty bucket directories
        dest_with_buckets = self.base / "dest-with-buckets"
        proc_with = subprocess.run(
            [sys.executable, "-B", str(HELPER4),
             "--archive", str(archive_zst),
             "--manifest", str(manifest_file),
             "--buckets", str(buckets_file),
             "--destination", str(dest_with_buckets)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc_with.returncode, 0, f"Amended extraction failed: {proc_with.stderr}")
        result = json.loads(proc_with.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["bucketInventoryVerified"])
        self.assertEqual(result["bucketCount"], 3)
        self.assertEqual(result["objectCount"], 1)

        # Verify destination filesystem hierarchy and permissions
        self.assertTrue(dest_with_buckets.is_dir())
        self.assertTrue((dest_with_buckets / "active-bucket/file1.txt").is_file())
        self.assertEqual((dest_with_buckets / "active-bucket/file1.txt").read_bytes(), file_payload)
        self.assertTrue((dest_with_buckets / "empty-bucket-alpha").is_dir())
        self.assertEqual(list((dest_with_buckets / "empty-bucket-alpha").iterdir()), [])
        self.assertTrue((dest_with_buckets / "empty-bucket-beta").is_dir())
        self.assertEqual(list((dest_with_buckets / "empty-bucket-beta").iterdir()), [])

        # Verify permissions: directories 0700, files 0600
        self.assertEqual(oct(dest_with_buckets.stat().st_mode & 0o777), oct(0o700))
        self.assertEqual(oct((dest_with_buckets / "empty-bucket-alpha").stat().st_mode & 0o777), oct(0o700))
        self.assertEqual(oct((dest_with_buckets / "active-bucket/file1.txt").stat().st_mode & 0o777), oct(0o600))

    def test_b7_cross_reference_full_pipeline(self):
        """Cross-check B7: verify full flow from storage export to amended B8 and amended R1."""
        if not HELPER2.is_file():
            self.skipTest(f"Helper #2 (storage-export.mjs) not available at {HELPER2}")

        # Synthetic source data representing Staging Storage
        raw_source = self.base / "synthetic-remote-storage"
        (raw_source / "contracts/nested").mkdir(parents=True)
        (raw_source / "customer-avatars").mkdir()
        (raw_source / "empty-staging-bucket").mkdir()

        contract_bytes = b"%PDF-1.7 Synthetic Contract File Bytes"
        avatar_bytes = b"PNG Synthetic Avatar Image Bytes"
        (raw_source / "contracts/nested/agreement.pdf").write_bytes(contract_bytes)
        (raw_source / "customer-avatars/user-99.png").write_bytes(avatar_bytes)

        # B7 Step: Execute storage-export.mjs in synthetic mode
        b7_export_bytes = self.base / "backup-storage-bytes"
        b7_buckets = self.base / "backup-buckets.json"
        b7_manifest = self.base / "backup-storage-manifest.json"

        proc_export = subprocess.run(
            ["node", str(HELPER2),
             "--source-dir", str(raw_source),
             "--out", str(b7_export_bytes),
             "--buckets", str(b7_buckets),
             "--manifest", str(b7_manifest)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc_export.returncode, 0, f"storage-export.mjs failed: {proc_export.stderr}")
        self.assertTrue(b7_buckets.is_file(), "B7 MUST produce buckets.json")
        self.assertTrue(b7_manifest.is_file(), "B7 MUST produce storage-manifest.json")

        buckets_json = json.loads(b7_buckets.read_text(encoding="utf-8"))
        bucket_ids = {b["id"] for b in buckets_json}
        self.assertEqual(bucket_ids, {"contracts", "customer-avatars", "empty-staging-bucket"})

        # B8 Step (Amended): Tar and zstd with COPYFILE_DISABLE=1
        b8_archive_tar = self.base / "objects.tar"
        b8_archive_zst = self.base / "objects.tar.zst"
        b8_env = os.environ.copy()
        b8_env["COPYFILE_DISABLE"] = "1"

        with b8_archive_tar.open("wb") as out:
            subprocess.run(
                ["tar", "-C", str(b7_export_bytes), "-cf", "-", "."],
                stdout=out,
                check=True,
                env=b8_env,
            )
        subprocess.run(["zstd", "-q", "-19", "-T0", str(b8_archive_tar), "-o", str(b8_archive_zst)], check=True)

        # R1 Step (Amended): Safe extraction with --buckets
        r1_destination = self.base / "restored-objects"
        proc_r1 = subprocess.run(
            [sys.executable, "-B", str(HELPER4),
             "--archive", str(b8_archive_zst),
             "--manifest", str(b7_manifest),
             "--buckets", str(b7_buckets),
             "--destination", str(r1_destination)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc_r1.returncode, 0, f"R1 safe extraction failed: {proc_r1.stderr}")
        r1_result = json.loads(proc_r1.stdout)
        self.assertEqual(r1_result["status"], "ok")
        self.assertTrue(r1_result["bucketInventoryVerified"])
        self.assertEqual(r1_result["bucketCount"], 3)
        self.assertEqual(r1_result["objectCount"], 2)

        # Verify restored files and empty bucket
        self.assertEqual((r1_destination / "contracts/nested/agreement.pdf").read_bytes(), contract_bytes)
        self.assertEqual((r1_destination / "customer-avatars/user-99.png").read_bytes(), avatar_bytes)
        self.assertTrue((r1_destination / "empty-staging-bucket").is_dir())
        self.assertEqual(list((r1_destination / "empty-staging-bucket").iterdir()), [])

    def test_unauthorized_empty_bucket_rejected_even_with_buckets_flag(self):
        """Defense-in-depth: An empty bucket in the archive NOT in buckets.json is rejected."""
        source = self.base / "storage-bytes"
        source.mkdir(parents=True)
        (source / "legit-bucket").mkdir()
        (source / "unauthorized-bucket").mkdir()
        doc = b"Document"
        (source / "legit-bucket/doc.txt").write_bytes(doc)

        archive_tar = self.base / "objects.tar"
        archive_zst = self.base / "objects.tar.zst"
        env = os.environ.copy()
        env["COPYFILE_DISABLE"] = "1"
        with archive_tar.open("wb") as out:
            subprocess.run(["tar", "-C", str(source), "-cf", "-", "."], stdout=out, check=True, env=env)
        subprocess.run(["zstd", "-q", "-19", "-T0", str(archive_tar), "-o", str(archive_zst)], check=True)

        manifest_data = [{
            "bucket": "legit-bucket",
            "path": "doc.txt",
            "size": len(doc),
            "sha256": sha256_bytes(doc),
            "id": "item-1",
        }]
        manifest_file = self.base / "storage-manifest.json"
        manifest_file.write_text(json.dumps(manifest_data), encoding="utf-8")

        # buckets.json only authorizes 'legit-bucket'
        buckets_data = [{"id": "legit-bucket", "name": "legit-bucket"}]
        buckets_file = self.base / "buckets.json"
        buckets_file.write_text(json.dumps(buckets_data), encoding="utf-8")

        dest = self.base / "dest-unauthorized"
        proc = subprocess.run(
            [sys.executable, "-B", str(HELPER4),
             "--archive", str(archive_zst),
             "--manifest", str(manifest_file),
             "--buckets", str(buckets_file),
             "--destination", str(dest)],
            capture_output=True,
            text=True,
        )
        # Even with --buckets, unauthorized-bucket MUST trigger UNEXPECTED_DIRECTORY rejection
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("UNEXPECTED_DIRECTORY", proc.stderr)
        self.assertFalse(dest.exists())


if __name__ == "__main__":
    unittest.main()
