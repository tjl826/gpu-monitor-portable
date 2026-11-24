#!/usr/bin/env python3
"""GPU monitor: Python standard library + nvidia-smi; no third-party packages."""
import argparse
import csv
import fcntl
import io
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

BASE = Path(__file__).resolve().parent
INTERVAL = 300
RETENTION = 72 * 3600
TZ = timezone(timedelta(hours=8))
FIELDS = ["timestamp", "timestamp_iso", "gpu_index", "gpu_uuid", "name",
          "power_w", "power_limit_w", "gpu_util_pct", "memory_util_pct",
          "memory_used_mib", "memory_total_mib", "temperature_c"]
QUERY = ["index", "uuid", "name", "power.draw", "power.limit", "utilization.gpu",
         "utilization.memory", "memory.used", "memory.total", "temperature.gpu"]
LOG = logging.getLogger("gpu-monitor")


def owned_path(path):
    """Do not follow symlinks or write another user's files."""
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError("Refusing symlink: {}".format(path))
    if path.exists() and path.stat().st_uid != os.getuid():
        raise RuntimeError("Not owned by current user: {}".format(path))
    if not path.parent.is_dir() or path.parent.stat().st_uid != os.getuid():
        raise RuntimeError("Parent must be owned by current user: {}".format(path.parent))
    return path


def number(value):
    try:
        result = float(value.strip())
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def collect():
    result = subprocess.run(
        [shutil.which("nvidia-smi") or "/usr/bin/nvidia-smi", "--query-gpu=" + ",".join(QUERY),
         "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=25, check=True)
    timestamp = round(time.time(), 3)
    stamp = datetime.fromtimestamp(timestamp, TZ).isoformat(timespec="seconds")
    rows = []
    for values in csv.reader(io.StringIO(result.stdout), skipinitialspace=True):
        if not values:
            continue
        if len(values) != len(QUERY):
            raise ValueError("Unexpected nvidia-smi column count")
        rows.append(dict(zip(FIELDS, [timestamp, stamp, int(values[0]),
                                     values[1].strip(), values[2].strip()] +
                             [number(value) for value in values[3:]])))
    if not rows:
        raise RuntimeError("nvidia-smi returned no GPUs")
    return rows


class Store:
    def __init__(self, base=BASE, clock=time.time):
        self.path = owned_path(Path(base) / "gpu_metrics.csv")
        for leftover in self.path.parent.glob(".gpu-metrics-*.tmp"):
            owned_path(leftover).unlink()
        self.clock = clock
        self.lock = threading.RLock()
        self.rows = []
        self.last_error = None
        self.last_attempt = None
        self.next_sample_at = self.clock()
        if self.path.exists():
            with self.path.open(newline="", encoding="utf-8-sig") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames != FIELDS:
                    raise RuntimeError("Existing gpu_metrics.csv has an incompatible header")
                for raw in reader:
                    row = dict(raw)
                    row["timestamp"] = float(row["timestamp"])
                    row["gpu_index"] = int(row["gpu_index"])
                    for key in FIELDS[5:]:
                        row[key] = number(row[key])
                    self.rows.append(row)
        self.rows.sort(key=lambda row: (row["timestamp"], row["gpu_index"]))
        self.prune()

    def _write(self, rows):
        owned_path(self.path)
        fd, name = tempfile.mkstemp(prefix=".gpu-metrics-", suffix=".tmp", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", newline="", encoding="utf-8-sig") as handle:
                writer = csv.DictWriter(handle, fieldnames=FIELDS)
                writer.writeheader()
                writer.writerows(rows)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, str(self.path))
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def prune(self):
        with self.lock:
            cutoff = self.clock() - RETENTION
            rows = [row for row in self.rows if row["timestamp"] >= cutoff]
            if len(rows) != len(self.rows) or not self.path.exists():
                self._write(rows)
                self.rows = rows

    def append(self, new_rows):
        with self.lock:
            cutoff = self.clock() - RETENTION
            merged = {(row["timestamp"], row["gpu_uuid"]): row
                      for row in self.rows + new_rows if row["timestamp"] >= cutoff}
            rows = sorted(merged.values(), key=lambda row: (row["timestamp"], row["gpu_index"]))
            self._write(rows)
            self.rows = rows

    def payload(self, hours):
        with self.lock:
            now = self.clock()
            retained = [row for row in self.rows if row["timestamp"] >= now - RETENTION]
            latest_timestamp = retained[-1]["timestamp"] if retained else None
            latest = [row for row in retained if row["timestamp"] == latest_timestamp]
            history = [row for row in retained if row["timestamp"] >= now - hours * 3600]
            return dict(hostname=socket.gethostname(), server_time=now,
                        interval_seconds=INTERVAL, retention_hours=RETENTION // 3600,
                        latest_timestamp=latest_timestamp, last_attempt=self.last_attempt,
                        next_sample_at=self.next_sample_at, last_error=self.last_error,
                        sample_count=len({row["timestamp"] for row in history}),
                        latest=latest, history=history)


def sample_loop(store, stop):
    next_sample = time.time()
    next_prune = time.time()
    while not stop.is_set():
        now = time.time()
        if now >= next_sample:
            with store.lock:
                store.last_attempt = now
            try:
                rows = collect()
                store.append(rows)
                with store.lock:
                    store.last_error = None
                LOG.info("Recorded %d GPUs", len(rows))
            except Exception as exc:
                # Keep valid historical data; never turn a failed reading into a zero.
                error = str(exc)
                if isinstance(exc, subprocess.CalledProcessError):
                    error = (exc.stderr or exc.stdout or str(exc)).strip()[:1000]
                with store.lock:
                    store.last_error = error
                LOG.error("Sampling failed: %s", error)
            next_sample = (math.floor(time.time() / INTERVAL) + 1) * INTERVAL
            with store.lock:
                store.next_sample_at = next_sample
        if now >= next_prune:
            try:
                store.prune()
            except Exception as exc:
                with store.lock:
                    store.last_error = "CSV cleanup failed: " + str(exc)
                LOG.exception("CSV cleanup failed")
            next_prune = time.time() + 30
        stop.wait(max(0.1, min(next_sample, next_prune) - time.time()))


def handler_for(store):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GPU-Monitor"

        def log_message(self, message, *args):
            if len(args) >= 2 and str(args[1]).startswith("5"):
                LOG.warning(message, *args)

        def respond(self, status, body, mime, attachment=None):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
            if attachment:
                self.send_header("Content-Disposition", 'attachment; filename="{}"'.format(attachment))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            try:
                parsed = urlsplit(self.path)
                route = parsed.path
                if route in ("/api/data", "/api/export.csv"):
                    try:
                        hours = float(parse_qs(parsed.query).get("hours", ["72"])[0])
                        if not math.isfinite(hours) or not 0 < hours <= 72:
                            raise ValueError()
                    except (ValueError, IndexError):
                        return self.respond(400, b'{"error":"hours must be greater than 0 and at most 72"}', "application/json")
                    payload = store.payload(hours)
                    if route == "/api/data":
                        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
                        return self.respond(200, body, "application/json; charset=utf-8")
                    output = io.StringIO(newline="")
                    writer = csv.DictWriter(output, fieldnames=FIELDS)
                    writer.writeheader()
                    writer.writerows(payload["history"])
                    return self.respond(200, output.getvalue().encode("utf-8-sig"),
                                        "text/csv; charset=utf-8", "gpu_metrics.csv")
                resources = {"/": ("index.html", "text/html; charset=utf-8"),
                             "/index.html": ("index.html", "text/html; charset=utf-8"),
                             "/style.css": ("style.css", "text/css; charset=utf-8"),
                             "/app.js": ("app.js", "text/javascript; charset=utf-8")}
                if route in resources:
                    name, mime = resources[route]
                    return self.respond(200, (BASE / "static" / name).read_bytes(), mime)
                self.respond(404, b"Not found", "text/plain; charset=utf-8")
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                LOG.exception("Request failed")
                self.respond(500, b"Internal error", "text/plain; charset=utf-8")
    return Handler


def acquire_lock(name):
    path = owned_path(BASE / name)
    handle = path.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def daemon_running():
    handle = acquire_lock(".monitor.lock")
    if handle is None:
        return True
    handle.close()
    return False


def setup_logging():
    for name in ("monitor.log", "monitor.log.1", "monitor.log.2"):
        owned_path(BASE / name)
    handler = RotatingFileHandler(str(BASE / "monitor.log"), maxBytes=1024 * 1024, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)


def serve(args):
    lock = acquire_lock(".monitor.lock")
    if lock is None:
        print("GPU monitor is already running")
        return 0
    setup_logging()
    store = Store()
    server = ThreadingHTTPServer((args.host, args.port), handler_for(store))
    server.daemon_threads = True
    server.timeout = 1
    stop = threading.Event()
    pid_path = owned_path(BASE / "monitor.pid")
    pid_path.write_text(str(os.getpid()) + "\n", encoding="ascii")
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    sampler = threading.Thread(target=sample_loop, args=(store, stop), name="gpu-sampler", daemon=True)
    sampler.start()
    LOG.info("Listening on %s:%d, interval=%ds, retention=%dh", args.host, args.port, INTERVAL, RETENTION // 3600)
    try:
        while not stop.is_set():
            server.handle_request()
    finally:
        stop.set()
        sampler.join(timeout=30)
        server.server_close()
        if pid_path.exists():
            pid_path.unlink()
        lock.close()
        LOG.info("Stopped")
    return 0


def ensure(args):
    start_lock = acquire_lock(".start.lock")
    if start_lock is None:
        return 0
    try:
        if (BASE / ".disabled").exists():
            print("GPU monitor is paused; use start to resume")
            return 0
        if daemon_running():
            return 0
        with open(os.devnull, "rb") as source, open(os.devnull, "ab") as output:
            child = subprocess.Popen([sys.executable, str(BASE / "monitor.py"), "serve",
                                      "--host", args.host, "--port", str(args.port)],
                                     cwd=str(BASE), stdin=source, stdout=output, stderr=output,
                                     start_new_session=True, close_fds=True)
        for _ in range(30):
            if child.poll() is not None:
                raise RuntimeError("Monitor failed to start; inspect monitor.log and the listen port")
            pid_path = BASE / "monitor.pid"
            if pid_path.exists():
                try:
                    ready_pid = int(pid_path.read_text().strip())
                except ValueError:
                    ready_pid = None
                if ready_pid == child.pid and daemon_running() and child.poll() is None:
                    print("GPU monitor started (PID {})".format(child.pid))
                    return 0
            time.sleep(0.1)
        raise RuntimeError("Monitor did not become ready within 3 seconds")
    finally:
        start_lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["serve", "start", "ensure", "stop", "status"], nargs="?", default="status")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=18770)
    args = parser.parse_args()
    if BASE.stat().st_uid != os.getuid():
        parser.error("The monitor directory must belong to the current user")
    os.umask(0o077)
    if args.action == "serve":
        return serve(args)
    if args.action == "start":
        paused = owned_path(BASE / ".disabled")
        if paused.exists():
            paused.unlink()
        return ensure(args)
    if args.action == "ensure":
        return ensure(args)
    if args.action == "stop":
        start_lock = owned_path(BASE / ".start.lock").open("a+")
        fcntl.flock(start_lock.fileno(), fcntl.LOCK_EX)
        owned_path(BASE / ".disabled").touch()
        if daemon_running():
            pid = int(owned_path(BASE / "monitor.pid").read_text().strip())
            proc = Path("/proc") / str(pid)
            command = (proc / "cmdline").read_bytes().split(b"\0")
            if proc.stat().st_uid != os.getuid() or str(BASE / "monitor.py").encode() not in command or b"serve" not in command:
                raise RuntimeError("Refusing to stop an unrelated process")
            os.kill(pid, signal.SIGTERM)
            for _ in range(60):
                if not daemon_running():
                    break
                time.sleep(0.5)
            if daemon_running():
                raise RuntimeError("Monitor is still stopping; inspect status/logs")
        print("GPU monitor stopped; automatic restart paused")
        start_lock.close()
        return 0
    running = daemon_running()
    print("running" if running else "stopped")
    return 0 if running else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        LOG.exception("Monitor error")
        print(str(exc), file=sys.stderr)
        sys.exit(1)
