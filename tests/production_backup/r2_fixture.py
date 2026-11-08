"""Loopback S3 test server. The operational R2 endpoint has no override."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch

import r2


class S3Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def error_xml(self, status, code):
        body = f'<Error><Code>{code}</Code></Error>'.encode()
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        self.server.requests.append(('PUT', self.path))
        if (self.headers.get('Host') != r2.HOST
                or self.headers.get('If-None-Match') != '*'
                or not self.path.startswith(f'/{r2.BUCKET}/smoke/')
                or 'if-none-match' not in self.headers.get('Authorization', '')):
            self.error_xml(403, 'AccessDenied')
            return
        body = self.rfile.read(int(self.headers['Content-Length']))
        if hashlib.sha256(body).hexdigest() != self.headers.get('x-amz-content-sha256'):
            self.error_xml(400, 'BadDigest')
            return
        if self.path in self.server.objects:
            self.error_xml(412, 'PreconditionFailed')
            return
        if not self.server.drop_before_commit:
            self.server.objects[self.path] = body
        if self.server.drop_before_commit or self.server.drop_after_commit:
            self.close_connection = True
            return
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        self.server.requests.append(('GET', self.path))
        if self.path not in self.server.objects:
            self.error_xml(404, 'NoSuchKey')
            return
        body = self.server.objects[self.path]
        modified = datetime.now(timezone.utc).replace(microsecond=0)
        expiry = format_datetime(modified + timedelta(days=1), usegmt=True)
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Last-Modified', format_datetime(modified, usegmt=True))
        if self.server.lifecycle:
            self.send_header('x-amz-expiration', f'expiry-date="{expiry}", rule-id="smoke-expire-1d"')
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def local_r2():
    with ThreadingHTTPServer(('127.0.0.1', 0), S3Fixture) as server:
        server.objects = {}
        server.requests = []
        server.drop_before_commit = server.drop_after_commit = False
        server.lifecycle = True
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def loopback(host, *, timeout, context):
            assert host == r2.HOST and context.check_hostname
            return http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=timeout)

        try:
            with patch.object(r2.http.client, 'HTTPSConnection', side_effect=loopback):
                yield server
        finally:
            server.shutdown()
            thread.join()
