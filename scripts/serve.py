#!/usr/bin/env python3
"""Static dev server with caching disabled (ES modules are otherwise cached
aggressively by browsers, which hides edits). Usage: python scripts/serve.py [port]"""
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
    print(f"Serving http://localhost:{port}")
    http.server.ThreadingHTTPServer(("", port), NoCache).serve_forever()
