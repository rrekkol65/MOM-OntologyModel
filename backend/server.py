import argparse
import json
import re
import sqlite3
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from trace_data import read_trace

ROOT = Path(__file__).resolve().parent
GRAPH = json.loads((ROOT / "graph.json").read_text(encoding="utf-8"))
PRODUCTS = {row["code"] for row in GRAPH["products"]}
FIELDS = set(GRAPH["interfaces"][0]) - {"id"}
LEGACY_NAMES = re.compile(r"中控技术|中控|和利时|SUPCON|InPlant\s*|SystemM", re.IGNORECASE)


def public_interface(row):
    return {
        key: LEGACY_NAMES.sub(
            lambda match: "系统管理" if match[0].casefold() == "systemm" else "", value
        ).strip() if isinstance(value, str) else value
        for key, value in row.items()
    }


FEATURES = [
    {**feature, "module": module["id"], "product": module["code"]}
    for module in GRAPH["modules"] for feature in module["features"]
]


def initialize(db):
    db.execute("PRAGMA journal_mode=WAL")
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS interfaces (number INTEGER PRIMARY KEY, body TEXT NOT NULL)")
        db.executemany(
            "INSERT OR IGNORE INTO interfaces VALUES (?, ?)",
            [(int(row["id"].split("-")[1]), json.dumps(row, ensure_ascii=False))
             for row in GRAPH["interfaces"]],
        )


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        if self.headers.get("Origin") in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.respond(204)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/api/trace":
            query = parse_qs(url.query)
            return self.respond(*read_trace(
                self.server.trace_dir, query.get("mode", ["overview"])[0],
                query.get("id", [""])[0].strip(),
                query.get("type", [""])[0], query.get("category", [""])[0],
            ))
        if url.path == "/api/health":
            with closing(sqlite3.connect(self.server.db)) as db:
                db.execute("SELECT number FROM interfaces LIMIT 1").fetchone()
            return self.respond(200, {"status": "ok"})
        if not url.path.startswith("/api/"):
            return self.respond(404, {"error": "Route not found"})
        collection, _, key = url.path[5:].partition("/")
        if collection in {"graph", "interfaces"}:
            with closing(sqlite3.connect(self.server.db)) as db:
                rows = [public_interface(json.loads(body)) for (body,) in db.execute(
                    "SELECT body FROM interfaces ORDER BY number")]
            if collection == "graph" and not key:
                return self.respond(200, {**GRAPH, "interfaces": rows})
        elif collection == "features":
            rows = FEATURES
        else:
            rows = GRAPH.get(collection)
        if rows is None or collection == "graph":
            return self.respond(404, {"error": "Route not found"})
        if key:
            row = next((row for row in rows if key == row.get("id", row.get("code"))), None)
            return self.respond(200, row) if row else self.respond(404, {"error": "Record not found"})
        query = parse_qs(url.query)
        term = query.get("q", [""])[0].casefold()
        filters = {k: v[0] for k, v in query.items() if k != "q"}
        return self.respond(200, [
            row for row in rows
            if all(row.get(k) == v for k, v in filters.items())
            and term in json.dumps(row, ensure_ascii=False).casefold()
        ])

    def do_POST(self):
        self.write_interface()

    def do_PUT(self):
        self.write_interface()

    def write_interface(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/api/interfaces/IF-(\d{3,12})", path)
        creating = self.command == "POST" and path == "/api/interfaces"
        if not creating and not (self.command == "PUT" and match):
            return self.respond(404, {"error": "Route not found"})
        if self.headers.get("Origin") and self.headers["Origin"] not in self.server.origins:
            return self.respond(403, {"error": "Origin not allowed"})
        if self.headers.get_content_type() != "application/json":
            return self.respond(415, {"error": "Expected application/json"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                raise ValueError()
            row = json.loads(self.rfile.read(length))
            if not isinstance(row, dict) or set(row) != FIELDS:
                raise ValueError()
            if any(not isinstance(value, str) for value in row.values()):
                raise ValueError()
            if not row["name"].strip() or any(row[k] not in PRODUCTS for k in ("from", "to")):
                raise ValueError()
            if row["type"] not in {item["type"] for item in GRAPH["interfaces"]}:
                raise ValueError()
        except (ValueError, UnicodeError):
            return self.respond(400, {"error": "Invalid interface record"})

        with closing(sqlite3.connect(self.server.db)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if creating:
                number = db.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM interfaces").fetchone()[0]
                row["id"] = f"IF-{number:03d}"
                db.execute("INSERT INTO interfaces VALUES (?, ?)", (number, json.dumps(row, ensure_ascii=False)))
            else:
                number = int(match[1])
                row["id"] = f"IF-{number:03d}"
                cursor = db.execute("UPDATE interfaces SET body = ? WHERE number = ?",
                                    (json.dumps(row, ensure_ascii=False), number))
                if not cursor.rowcount:
                    return self.respond(404, {"error": "Record not found"})
        self.respond(201 if creating else 200, public_interface(row))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9284)
    parser.add_argument("--db", type=Path, default=ROOT / "interfaces.sqlite3")
    parser.add_argument("--origin", action="append", default=["http://127.0.0.1:2321", "http://localhost:2321"])
    parser.add_argument("--trace-dir", type=Path, help="Business trace data directory")
    args = parser.parse_args()
    args.db.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(args.db)) as connection:
        initialize(connection)
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        server.db = args.db
        server.trace_dir = args.trace_dir
        server.origins = set(args.origin)
        print(f"MOM API http://{args.host}:{args.port}", flush=True)
        server.serve_forever()
