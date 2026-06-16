#!/usr/bin/env python3
"""HTTPS dev server for the A Scow tuning app (self-signed cert).

Serves the static files and a tiny shared-storage API so multiple clients
(phone, laptop) sync to one on-disk store:

    GET  /api/store  -> {"rev": N, "store": {...}}
    PUT  /api/store  -> body is the full store JSON; returns {"rev": N+1}

State is persisted to store.json on disk, so it survives restarts.
Concurrency model is last-write-wins. The API is UNAUTHENTICATED — set
ASCOW_TOKEN to require a matching `X-Token` header (or ?token=) if the host
is reachable by others you don't trust.
"""
import http.server
import json
import os
import ssl
import threading
from urllib.parse import urlparse, parse_qs

HOST, PORT = "0.0.0.0", 8443
STORE_FILE = "store.json"
TOKEN = os.environ.get("ASCOW_TOKEN", "")  # empty = no auth
_lock = threading.Lock()


def read_store():
    if os.path.exists(STORE_FILE):
        try:
            with open(STORE_FILE) as f:
                return json.load(f)
        except (ValueError, OSError):
            pass
    return {"rev": 0, "store": {"profiles": [], "activeProfileId": None}}


def write_store(new_store):
    with _lock:
        data = read_store()
        data["rev"] = int(data.get("rev", 0)) + 1
        data["store"] = new_store
        tmp = STORE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, STORE_FILE)  # atomic
        return data


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _authed(self):
        if not TOKEN:
            return True
        q = parse_qs(urlparse(self.path).query)
        return self.headers.get("X-Token") == TOKEN or q.get("token", [""])[0] == TOKEN

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_api(self):
        return urlparse(self.path).path == "/api/store"

    def do_GET(self):
        if self._is_api():
            if not self._authed():
                return self._send_json(401, {"error": "unauthorized"})
            return self._send_json(200, read_store())
        return super().do_GET()

    def do_PUT(self):
        if not self._is_api():
            return self._send_json(404, {"error": "not found"})
        if not self._authed():
            return self._send_json(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self._send_json(400, {"error": "bad json"})
        data = write_store(payload)
        return self._send_json(200, {"rev": data["rev"]})


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(certfile="cert.pem", keyfile="key.pem")

httpd = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f"Serving HTTPS on https://{HOST}:{PORT}/  (store: {STORE_FILE}, auth: {'on' if TOKEN else 'off'})")
httpd.serve_forever()
