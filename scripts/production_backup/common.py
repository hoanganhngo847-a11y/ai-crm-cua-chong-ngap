"""Private workspace, strict integrity checks and redacted process execution."""
import hashlib
import json
import os
import re
import resource
import shutil
import signal
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit, unquote

PROJECT = 'yrauljxzyklhisxijeim'
IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.002@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53'
REPO = Path(__file__).resolve().parents[2]
GIB = 1024**3
MAX_CIPHERTEXT = 4 * GIB
PROCESS_ENV = {key: os.environ[key] for key in ('PATH', 'HOME', 'SYSTEMROOT') if key in os.environ}
PROCESS_ENV.update(LC_ALL='C', TZ='UTC')


class Failure(Exception):
    def __init__(self, code, status='FAIL'):
        super().__init__(code)
        self.code, self.status = code, status


def protect_process():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=False) + '\n')
    path.chmod(0o600)


def unique_object(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise Failure('DUPLICATE_JSON_KEY')
        d[k] = v
    return d


def load_json(path):
    return json.loads(Path(path).read_text(), object_pairs_hook=unique_object)


def run(args, *, env=None, input_bytes=None, timeout=1800):
    # Never expose stderr/SQL/passwords to logs, including CalledProcessError.
    try:
        r = subprocess.run(args, input=input_bytes, env=PROCESS_ENV | (env or {}), capture_output=True,
                           timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Failure('PROCESS_UNAVAILABLE_OR_TIMEOUT') from None
    if r.returncode:
        detail = r.stderr.lower()
        if b'permission denied' in detail or b'password authentication failed' in detail:
            raise Failure('PROCESS_ACCESS_DENIED', 'BLOCKED')
        raise Failure('PROCESS_EXIT_NONZERO')
    return r.stdout


def age_recipient(value):
    if not re.fullmatch(r'age1[0-9a-z]{58}',value):
        raise Failure('RECIPIENT_MUST_BE_ONE_NATIVE_AGE_X25519_KEY','BLOCKED')
    return value


def private_scratch(path):
    root = Path(path).resolve(strict=True)
    if (root.is_relative_to(REPO) or not root.is_dir()
            or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077):
        raise Failure('UNSAFE_SCRATCH', 'BLOCKED')
    if (shutil.disk_usage(root).free < 5 * GIB
            or (sys.platform == 'darwin' and shutil.disk_usage('/System/Volumes/Data').free < 5 * GIB)):
        raise Failure('INSUFFICIENT_SCRATCH_SPACE', 'BLOCKED')
    return root


def verified_age(path, expected_sha256):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK) or digest(path) != expected_sha256:
        raise Failure('AGE_BINARY_CHECKSUM_MISMATCH', 'BLOCKED')
    return path


def object_path(name):
    if (not isinstance(name, str) or not name or name.startswith('/')
            or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(x in ('', '.', '..') for x in name.split('/'))):
        raise Failure('UNSAFE_OBJECT_PATH', 'PARTIAL')
    return PurePosixPath(name)


def db_environment(url, ca_file):
    try:
        p = urlsplit(url)
        host, port = p.hostname, p.port or 5432
        user = unquote(p.username or '')
        password = unquote(p.password or '')
        direct = host == f'db.{PROJECT}.supabase.co' and user == 'postgres'
        pooler = (host is not None and host.endswith('.pooler.supabase.com')
                  and user == f'postgres.{PROJECT}')
        if (p.scheme not in ('postgres', 'postgresql') or not (direct or pooler)
                or port != 5432 or p.path != '/postgres' or not password or p.fragment):
            raise ValueError()
    except (ValueError, TypeError):
        raise Failure('INVALID_PRODUCTION_DB_TARGET', 'BLOCKED') from None
    # Do not pass URL query options through; they can override host/options.
    ca_file = Path(ca_file).resolve(strict=True)
    if not ca_file.is_file() or not os.access(ca_file, os.R_OK):
        raise Failure('UNAVAILABLE_POSTGRES_CA_FILE', 'BLOCKED')
    return dict(PGHOST=host, PGPORT=str(port), PGUSER=user, PGPASSWORD=password,
                PGDATABASE='postgres', PGSSLMODE='verify-full', PGSSLROOTCERT=str(ca_file),
                PGCONNECT_TIMEOUT='20', PGAPPNAME='crm-production-backup-readonly',
                PGOPTIONS='-c default_transaction_read_only=on -c row_security=off '
                          '-c lock_timeout=10000 -c statement_timeout=2400000')


def checksums(root):
    root = Path(root)
    files = sorted(p for p in root.rglob('*') if p.is_file()
                   and p.relative_to(root).as_posix() != 'checksums.sha256')
    for p in files:
        if p.is_symlink():
            raise Failure('SYMLINK_IN_BUNDLE')
        object_path(p.relative_to(root).as_posix())
    (root / 'checksums.sha256').write_text(''.join(
        f'{digest(p)}  {p.relative_to(root).as_posix()}\n' for p in files))


def verify_checksums(root):
    root = Path(root)
    seen = set()
    for line in (root / 'checksums.sha256').read_text().splitlines():
        expected, name = line.split('  ', 1)
        object_path(name)
        if len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
            raise Failure('MALFORMED_CHECKSUM')
        if name in seen or name == 'checksums.sha256':
            raise Failure('CHECKSUM_SET_INVALID')
        seen.add(name)
        p = root / name
        if p.is_symlink() or not p.is_file() or digest(p) != expected:
            raise Failure('CHECKSUM_MISMATCH')
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != seen | {'checksums.sha256'}:
        raise Failure('CHECKSUM_SET_INVALID')


def extract_archive(archive, destination):
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    budget = min(8 * GIB, shutil.disk_usage(destination).free - GIB)
    with tarfile.open(archive, 'r|gz') as t:
        seen, total = set(), 0
        for m in t:
            object_path(m.name)
            if (m.name.split('/')[0] != 'production-backup' or m.name in seen
                    or not (m.isfile() or m.isdir())):
                raise Failure('UNSAFE_ARCHIVE_MEMBER')
            seen.add(m.name)
            total += m.size
            if total > budget:
                raise Failure('ARCHIVE_SIZE_LIMIT')
            if len(seen) > 10000:
                raise Failure('ARCHIVE_MEMBER_LIMIT')
            t.extract(m, destination, filter='data')
    root = destination / 'production-backup'
    verify_checksums(root)
    return root
