"""Read-only Storage pagination and bounded, checked binary export."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from common import Failure, PROJECT, digest, object_path, write_json

BASE = f'https://{PROJECT}.supabase.co/storage/v1'
PAGE_SIZE = 1000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise Failure('STORAGE_REDIRECT_REJECTED', 'PARTIAL')


class Storage:
    def __init__(self, key):
        self.key = key
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, payload=None, destination=None):
        url = BASE + path
        # Endpoint is fixed; never consume an object-provided URL or redirect.
        for attempt in range(5):
            try:
                req = urllib.request.Request(url, method='GET' if payload is None else 'POST',
                    data=None if payload is None else json.dumps(payload).encode(),
                    headers={'apikey': self.key, 'Authorization': 'Bearer ' + self.key,
                             'Content-Type': 'application/json', 'Accept-Encoding': 'identity'})
                with self.opener.open(req, timeout=90) as response:
                    if destination is None:
                        body = response.read(32 * 1024 * 1024 + 1)
                        if len(body) > 32 * 1024 * 1024:
                            raise Failure('STORAGE_RESPONSE_SIZE_LIMIT', 'PARTIAL')
                        return json.loads(body)
                    destination = Path(destination)
                    fd, temporary_name = tempfile.mkstemp(prefix='.crm-backup-',dir=destination.parent)
                    temporary = Path(temporary_name)
                    h, size = hashlib.sha256(), 0
                    try:
                        with os.fdopen(fd,'wb') as output:
                            for block in iter(lambda: response.read(1024 * 1024), b''):
                                size += len(block)
                                if size > 4 * 1024**3:
                                    raise Failure('STORAGE_OBJECT_SIZE_LIMIT', 'PARTIAL')
                                h.update(block)
                                output.write(block)
                        content_length = response.headers.get('Content-Length')
                        if content_length is not None and int(content_length) != size:
                            raise OSError('Incomplete response')
                        os.replace(temporary, destination)
                    finally:
                        temporary.unlink(missing_ok=True)
                    return {'bytes': size, 'sha256': h.hexdigest()}
            except urllib.error.HTTPError as error:
                if error.code in (401, 403):
                    raise Failure('STORAGE_READ_PERMISSION_DENIED', 'BLOCKED') from None
                if error.code not in (408, 429, 500, 502, 503, 504):
                    raise Failure('STORAGE_HTTP_ERROR', 'PARTIAL') from None
            except (urllib.error.URLError, OSError, TimeoutError):
                pass
            if attempt < 4:
                time.sleep(min(2**attempt, 8))
        raise Failure('STORAGE_RETRIES_EXHAUSTED', 'PARTIAL')

    def enumerate(self, buckets):
        result = {}
        for bucket in buckets:
            bucket_id = bucket['id']
            object_path(bucket_id)
            queue, folders = [''], set()
            while queue:
                prefix = queue.pop()
                if prefix in folders:
                    raise Failure('STORAGE_FOLDER_CYCLE', 'PARTIAL')
                folders.add(prefix)
                if len(folders) > 100000:
                    raise Failure('STORAGE_FOLDER_LIMIT', 'PARTIAL')
                offset = 0
                while True:
                    page = self.request('/object/list/' + urllib.parse.quote(bucket_id, safe=''),
                        {'prefix': prefix, 'limit': PAGE_SIZE, 'offset': offset,
                         'sortBy': {'column': 'name', 'order': 'asc'}})
                    if not isinstance(page, list) or len(page) > PAGE_SIZE:
                        raise Failure('STORAGE_INVALID_LIST_RESPONSE', 'PARTIAL')
                    for item in page:
                        name = item.get('name')
                        if not isinstance(name, str) or '/' in name:
                            raise Failure('STORAGE_INVALID_LIST_NAME', 'PARTIAL')
                        full_name = prefix + name
                        object_path(full_name)
                        if item.get('id') is None:
                            queue.append(full_name + '/')
                        else:
                            key = (bucket_id, full_name)
                            if key in result:
                                raise Failure('STORAGE_DUPLICATE_OR_PAGE_DRIFT', 'PARTIAL')
                            result[key] = {**item, 'bucket_id': bucket_id, 'name': full_name}
                    if len(page) < PAGE_SIZE:
                        break
                    offset += PAGE_SIZE
                    if offset > 10000000:
                        raise Failure('STORAGE_PAGE_LIMIT', 'PARTIAL')
        return result


def signature(item):
    metadata = item.get('metadata') or {}
    size = metadata.get('size')
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise Failure('STORAGE_MISSING_OR_INVALID_SIZE', 'PARTIAL')
    updated = item.get('updated_at')
    if not isinstance(updated, str):
        raise Failure('STORAGE_MISSING_UPDATED_AT', 'PARTIAL')
    try:
        timestamp = datetime.fromisoformat(updated.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat()
    except ValueError:
        raise Failure('STORAGE_INVALID_UPDATED_AT', 'PARTIAL') from None
    return str(item['id']), timestamp, size, metadata.get('eTag') or metadata.get('etag')


def same_objects(expected, actual):
    return expected.keys() == actual.keys() and all(signature(expected[k]) == signature(actual[k]) for k in expected)


def export_storage(root, buckets, expected, storage):
    write_json(root / 'buckets.json', buckets)
    if any(b.get('type', 'STANDARD') != 'STANDARD' for b in buckets):
        raise Failure('NONSTANDARD_STORAGE_BUCKET_UNSUPPORTED', 'PARTIAL')
    listed = storage.enumerate(buckets)
    if not same_objects(expected, listed):
        raise Failure('STORAGE_CHANGED_SINCE_DATABASE_SNAPSHOT', 'PARTIAL')
    # Reject prefix collisions before concurrent downloads can touch disk.
    targets = set()
    for bucket, name in expected:
        relative = object_path(bucket + '/' + name)
        if any(p.as_posix() in targets for p in relative.parents):
            raise Failure('STORAGE_FILE_DIRECTORY_COLLISION', 'PARTIAL')
        targets.add(relative.as_posix())
    for target in targets:
        if any(parent.as_posix() in targets for parent in object_path(target).parents):
            raise Failure('STORAGE_FILE_DIRECTORY_COLLISION', 'PARTIAL')
    results = []

    def download(key):
        bucket, name = key
        item = expected[key]
        relative = (object_path(bucket) / object_path(name)).as_posix()
        path = root / 'files' / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            stats = storage.request('/object/authenticated/' + urllib.parse.quote(bucket, safe='')
                                    + '/' + urllib.parse.quote(name, safe='/'), destination=path)
            if stats['bytes'] != signature(item)[2]:
                raise Failure('STORAGE_BINARY_SIZE_MISMATCH', 'PARTIAL')
            return {'bucket_id': bucket, 'name': name, 'metadata': item,
                    'relative_file': 'files/' + relative, 'status': 'EXPORTED', **stats}
        except Failure as error:
            return {'bucket_id': bucket, 'name': name, 'status': error.status, 'error_code': error.code}
        except OSError:
            return {'bucket_id': bucket, 'name': name, 'status':'PARTIAL','error_code':'STORAGE_LOCAL_IO_ERROR'}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(download, key) for key in expected]
        for future in as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda x: (x['bucket_id'], x['name']))
    write_json(root / 'objects-manifest.json', results)
    if any(r['status'] != 'EXPORTED' for r in results):
        raise Failure('STORAGE_OBJECT_EXPORT_INCOMPLETE', 'PARTIAL')
    if not same_objects(expected, storage.enumerate(buckets)):
        raise Failure('STORAGE_CHANGED_DURING_EXPORT', 'PARTIAL')
    return {'buckets': len(buckets), 'objects': len(expected),
            'declared_bytes': sum(signature(v)[2] for v in expected.values()),
            'downloaded_bytes': sum(r['bytes'] for r in results),
            'files_succeeded': len(results), 'files_failed': 0}


def verify_storage(root):
    manifest = json.loads((root / 'objects-manifest.json').read_text())
    seen, total = set(), 0
    for item in manifest:
        name = item['relative_file']
        expected = 'files/' + (object_path(item['bucket_id']) / object_path(item['name'])).as_posix()
        if name != expected or name in seen or item['status'] != 'EXPORTED':
            raise Failure('STORAGE_MANIFEST_INVALID')
        seen.add(name)
        path = root / name
        if not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            raise Failure('STORAGE_BINARY_CHECKSUM_MISMATCH')
        total += item['bytes']
    files = {p.relative_to(root).as_posix() for p in (root / 'files').rglob('*') if p.is_file()}
    if files != seen:
        raise Failure('STORAGE_MANIFEST_FILE_SET_MISMATCH')
    return {'objects_verified': len(manifest), 'bytes_verified': total}
