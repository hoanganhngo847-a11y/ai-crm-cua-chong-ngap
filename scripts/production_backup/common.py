"""Private workspace, strict integrity checks and redacted process execution."""
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
from datetime import datetime, timezone
from urllib.parse import urlsplit, unquote

PROJECT = 'yrauljxzyklhisxijeim'
TENANT = 'de6a7bf3-b5bc-418d-92d6-f9b241472598'
IMAGE = 'supabase/postgres:17.11.0.002@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53'
LIMITATIONS = [
    'Auth provider/SMTP/JWT and platform settings are not exported by database credentials.',
    'Edge Function source and deployment secrets require a separate Management API export.',
    'Vault/column-encryption external key custody and role passwords require owner recovery procedures.',
    'PostgreSQL rehearsal does not verify Auth, Storage, Realtime or application service recovery.',
    'Storage binaries are verified locally; no Storage service import is performed.',
    'Database locale and per-database role settings are captured but not reapplied; rehearsal initializes UTF8/C and does not prove locale-dependent behavior.',
]


class Failure(Exception):
    def __init__(self, code, status='FAIL'):
        super().__init__(code)
        self.code, self.status = code, status


def now():
    return datetime.now(timezone.utc).isoformat()


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
        r = subprocess.run(args, input=input_bytes, env=env, capture_output=True,
                           timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Failure('PROCESS_UNAVAILABLE_OR_TIMEOUT') from None
    if r.returncode:
        detail = r.stderr.lower()
        if b'permission denied' in detail or b'password authentication failed' in detail:
            raise Failure('PROCESS_ACCESS_DENIED', 'BLOCKED')
        raise Failure('PROCESS_EXIT_NONZERO')
    return r.stdout


def require(names):
    missing = [name for name in names if not os.environ.get(name, '').strip()]
    if missing:
        raise Failure('MISSING_SECRET_' + '_AND_'.join(missing), 'BLOCKED')


def age_recipient():
    require(['BACKUP_AGE_RECIPIENT'])
    value = os.environ['BACKUP_AGE_RECIPIENT'].strip()
    if not re.fullmatch(r'age1[0-9a-z]{58}',value):
        raise Failure('RECIPIENT_MUST_BE_ONE_NATIVE_AGE_X25519_KEY','BLOCKED')
    return value


def workspace():
    parent = Path(os.environ['RUNNER_TEMP']).resolve()
    root = Path(os.environ['BACKUP_WORK_ROOT']).resolve()
    if root.parent != parent or not root.name.startswith('crm-backup-'):
        raise Failure('UNSAFE_WORKSPACE')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


def object_path(name):
    if (not isinstance(name, str) or not name or name.startswith('/')
            or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(x in ('', '.', '..') for x in name.split('/'))):
        raise Failure('UNSAFE_OBJECT_PATH', 'PARTIAL')
    return PurePosixPath(name)


def db_environment(url):
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
    result = os.environ.copy()
    result.update(PGHOST=host, PGPORT=str(port), PGUSER=user, PGPASSWORD=password,
                  PGDATABASE='postgres', PGSSLMODE='verify-full',
                  PGSSLROOTCERT='/etc/ssl/certs/ca-certificates.crt',
                  PGCONNECT_TIMEOUT='20', PGAPPNAME='crm-production-backup-readonly',
                  PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=10000')
    return result


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
    with tarfile.open(archive, 'r:gz') as t:
        members, seen, total = t.getmembers(), set(), 0
        for m in members:
            object_path(m.name)
            if (m.name.split('/')[0] != 'production-backup' or m.name in seen
                    or not (m.isfile() or m.isdir())):
                raise Failure('UNSAFE_ARCHIVE_MEMBER')
            seen.add(m.name)
            total += m.size
            if total > 48 * 1024**3:
                raise Failure('ARCHIVE_SIZE_LIMIT')
        # No links/devices, no traversal, duplicate paths or unbounded members.
        if len(members) > 1000000:
            raise Failure('ARCHIVE_MEMBER_LIMIT')
        t.extractall(destination, members=members, filter='data')
    root = destination / 'production-backup'
    verify_checksums(root)
    return root
