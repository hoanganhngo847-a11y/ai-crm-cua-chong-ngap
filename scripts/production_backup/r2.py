"""Single-object S3 PUT and SHA-256 readback, limited to the approved R2 bucket."""
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import getpass
import hashlib
import hmac
import http.client
import os
from pathlib import Path
import re
import ssl
import sys
from uuid import uuid4
import warnings
from xml.etree import ElementTree

from common import Failure, IMAGE, MAX_CIPHERTEXT, PROJECT, load_json

HOST = '77d10a7237a8e76fe23cc7a63d99e8c8.r2.cloudflarestorage.com'
BUCKET = 'ai-crm-prod-pg-backups'
BLOCK = 1024 * 1024
AGE_MAGIC = b'age-encryption.org/v1\n'
RUN_ID = r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}'
KEYS = {
    'synthetic': rf'smoke/pg17\.11-{RUN_ID}\.tar\.gz\.age',
    'production': rf'pre-migration/{RUN_ID}/supabase-production-pg17\.11\.tar\.gz\.age',
}
SOURCE_PROJECTS = {'synthetic': 'synthetic-fixture', 'production': PROJECT}
LIFECYCLES = {'synthetic': ('smoke-expire-1d', 1), 'production': ('pre-migration-expire-91d', 91)}
SAFE_CODES = frozenset({
    'AccessDenied', 'BadDigest', 'IncompleteBody', 'InternalError', 'InvalidAccessKeyId',
    'InvalidRequest', 'NoSuchBucket', 'NoSuchKey', 'ObjectLockedByBucketPolicy',
    'PreconditionFailed', 'RequestTimeTooSkewed', 'ServiceUnavailable', 'SignatureDoesNotMatch',
})


def new_key(source):
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex
    if source == 'synthetic':
        return f'smoke/pg17.11-{run_id}.tar.gz.age'
    return f'pre-migration/{run_id}/supabase-production-pg17.11.tar.gz.age'


def validate_receipt(receipt):
    fields = {'format', 'scope', 'export_status', 'source', 'project_ref', 'image',
              'snapshot_utc', 'recipient_sha256', 'key', 'bytes', 'sha256'}
    if not isinstance(receipt, dict) or set(receipt) != fields:
        raise Failure('INVALID_RECEIPT', 'BLOCKED')
    if (type(receipt['format']) is not int or receipt['format'] != 1
            or type(receipt['bytes']) is not int or not 0 < receipt['bytes'] <= MAX_CIPHERTEXT):
        raise Failure('INVALID_RECEIPT', 'BLOCKED')
    if any(not isinstance(receipt[k], str) for k in fields - {'format', 'bytes'}):
        raise Failure('INVALID_RECEIPT', 'BLOCKED')
    source = receipt['source']
    if (receipt['scope'] != 'db-only' or receipt['export_status'] != 'complete'
            or source not in KEYS or receipt['project_ref'] != SOURCE_PROJECTS[source]
            or receipt['image'] != IMAGE or not re.fullmatch(KEYS[source], receipt['key'])
            or not re.fullmatch(r'[0-9a-f]{64}', receipt['sha256'])
            or not re.fullmatch(r'[0-9a-f]{64}', receipt['recipient_sha256'])):
        raise Failure('INVALID_RECEIPT', 'BLOCKED')
    try:
        if datetime.fromisoformat(receipt['snapshot_utc']).utcoffset() != timedelta(0):
            raise ValueError()
    except ValueError:
        raise Failure('INVALID_RECEIPT', 'BLOCKED') from None
    return receipt


def load_receipt(path):
    if not path.is_file() or path.stat().st_size > 8192:
        raise Failure('INVALID_RECEIPT_FILE', 'BLOCKED')
    return validate_receipt(load_json(path))


def hidden(prompt):
    if not sys.stdin.isatty():
        raise Failure('HIDDEN_INPUT_REQUIRES_TTY', 'BLOCKED')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass(prompt)
    except (EOFError, OSError, getpass.GetPassWarning):
        raise Failure('HIDDEN_INPUT_UNAVAILABLE', 'BLOCKED') from None


class R2HTTPError(Failure):
    def __init__(self, method, status, service_code):
        self.http_status = status
        self.service_code = service_code
        suffix = '_' + service_code if service_code else ''
        super().__init__(f'R2_{method}_HTTP_{status}{suffix}')


def error_code(response):
    # HEAD errors have no XML body. Error bodies on other methods may echo headers.
    try:
        body = response.read(8193)
        if len(body) > 8192 or b'<!DOCTYPE' in body:
            return None
        root = ElementTree.fromstring(body)
        code = root.findtext('{*}Code')
        if root.tag.rsplit('}', 1)[-1] == 'Error' and code in SAFE_CODES:
            return code
    except (ElementTree.ParseError, OSError, http.client.HTTPException):
        pass
    return None


def expiry_matches(response, source):
    rule, days = LIFECYCLES[source]
    header = response.getheader('x-amz-expiration', '')
    expiry_match = re.search(r'(?:^|,)\s*expiry-date="([^"]+)"', header)
    rule_match = re.search(r'(?:^|,)\s*rule-id="([^"]+)"', header)
    if not expiry_match or not rule_match or rule_match[1] != rule:
        return False
    try:
        expiry = parsedate_to_datetime(expiry_match[1])
        modified = parsedate_to_datetime(response.getheader('Last-Modified', ''))
        return expiry > datetime.now(timezone.utc) and timedelta(days=days) <= expiry - modified < timedelta(days=days + 1)
    except (ValueError, TypeError, OverflowError):
        return False


class R2:
    def __init__(self, access_id, secret):
        if not re.fullmatch(r'[0-9a-fA-F]{32}', access_id) or not re.fullmatch(r'[0-9a-fA-F]{64}', secret):
            raise Failure('INVALID_R2_CREDENTIAL_FORMAT', 'BLOCKED')
        self._access_id = access_id
        self._secret = secret

    @classmethod
    def prompt(cls):
        return cls(hidden('R2 Access Key ID (hidden): '), hidden('R2 Secret Access Key (hidden): '))

    def _headers(self, method, path, receipt):
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        day = stamp[:8]
        content_hash = receipt['sha256'] if method == 'PUT' else hashlib.sha256(b'').hexdigest()
        headers = {'host': HOST, 'x-amz-content-sha256': content_hash, 'x-amz-date': stamp}
        if method == 'PUT':
            headers.update({'content-length': str(receipt['bytes']), 'content-type': 'application/octet-stream',
                            'if-none-match': '*'})
        names = sorted(headers)
        block = ''.join(f'{name}:{headers[name]}\n' for name in names)
        signed = ';'.join(names)
        canonical = '\n'.join((method, path, '', block, signed, content_hash))
        scope = f'{day}/auto/s3/aws4_request'
        to_sign = '\n'.join(('AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode('ascii')).hexdigest()))
        key = ('AWS4' + self._secret).encode('ascii')
        for part in (day, 'auto', 's3', 'aws4_request'):
            key = hmac.digest(key, part.encode('ascii'), 'sha256')
        sig = hmac.digest(key, to_sign.encode('ascii'), 'sha256').hex()
        headers['authorization'] = (
            f'AWS4-HMAC-SHA256 Credential={self._access_id}/{scope}, SignedHeaders={signed}, Signature={sig}'
        )
        return headers

    @contextmanager
    def _request(self, method, receipt, body=None):
        validate_receipt(receipt)
        if method not in ('PUT', 'GET'):
            raise Failure('UNSUPPORTED_R2_METHOD', 'BLOCKED')
        path = f"/{BUCKET}/{receipt['key']}"
        # Unlike create_default_context(), this does not honor SSLKEYLOGFILE.
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        tls.minimum_version = ssl.TLSVersion.TLSv1_2
        tls.load_default_certs()
        connection = http.client.HTTPSConnection(HOST, timeout=60, context=tls)
        try:
            connection.request(method, path, body=body, headers=self._headers(method, path, receipt))
            response = connection.getresponse()
            if response.status != 200:
                raise R2HTTPError(method, response.status, error_code(response))
            yield response
        except (OSError, http.client.HTTPException):
            raise Failure(f'R2_{method}_TRANSPORT_OR_TIMEOUT') from None
        finally:
            connection.close()

    def readback(self, receipt, destination=None):
        """Check the same object by streaming it. An optional file is created exclusively."""
        validate_receipt(receipt)
        destination = Path(destination) if destination is not None else None
        output = destination.open('xb') if destination is not None else nullcontext()
        try:
            with output as target, self._request('GET', receipt) as response:
                expected = receipt['bytes']
                if response.getheader('Content-Length') != str(expected):
                    raise Failure('R2_OBJECT_LENGTH_MISMATCH')
                digest = hashlib.sha256()
                remaining = expected
                while remaining:
                    block = response.read(min(BLOCK, remaining))
                    if not block:
                        raise Failure('R2_OBJECT_LENGTH_MISMATCH')
                    remaining -= len(block)
                    digest.update(block)
                    if target is not None:
                        target.write(block)
                if not hmac.compare_digest(digest.hexdigest(), receipt['sha256']):
                    raise Failure('R2_OBJECT_SHA256_MISMATCH')
                if not expiry_matches(response, receipt['source']):
                    raise Failure('R2_LIFECYCLE_NOT_VERIFIED', 'BLOCKED')
        except BaseException:
            if destination is not None:
                destination.unlink(missing_ok=True)
            raise

    def publish(self, ciphertext, receipt):
        validate_receipt(receipt)
        with Path(ciphertext).open('rb') as body:
            if os.fstat(body.fileno()).st_size != receipt['bytes'] or body.read(len(AGE_MAGIC)) != AGE_MAGIC:
                raise Failure('CIPHERTEXT_NOT_ELIGIBLE_FOR_UPLOAD', 'BLOCKED')
            body.seek(0)
            if not hmac.compare_digest(hashlib.file_digest(body, 'sha256').hexdigest(), receipt['sha256']):
                raise Failure('LOCAL_CIPHERTEXT_SHA256_MISMATCH', 'BLOCKED')
            body.seek(0)
            ambiguous = False
            try:
                with self._request('PUT', receipt, body=body):
                    pass
            except R2HTTPError as error:
                if error.http_status not in (408, 409, 412, 429) and error.http_status < 500:
                    raise
                ambiguous = True
            except Failure as error:
                if error.code != 'R2_PUT_TRANSPORT_OR_TIMEOUT':
                    raise
                ambiguous = True
        try:
            self.readback(receipt)
        except R2HTTPError as error:
            if error.http_status == 404 and error.service_code == 'NoSuchKey':
                raise Failure('R2_PUT_OUTCOME_UNCERTAIN_OBJECT_NOT_VISIBLE', 'BLOCKED') from None
            raise
        return 'RECONCILED' if ambiguous else 'PUBLISHED'
