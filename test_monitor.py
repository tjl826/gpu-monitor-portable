import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import urlopen

import monitor


def sample(timestamp, index=0):
    return dict(zip(monitor.FIELDS, [timestamp, "2026-11-18T12:00:00+08:00", index,
                                     "GPU-{}".format(index), "NVIDIA RTX A6000", 200.5,
                                     300.0, 80.0, None, 10000.0, 49140.0, 65.0]))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gpu-monitor-test-")
        self.addCleanup(self.temp.cleanup)
        self.now = 1000000.0
        self.store = monitor.Store(self.temp.name, clock=lambda: self.now)

    def test_retention_roundtrip_and_unrelated_file(self):
        unrelated = Path(self.temp.name) / "keep.txt"
        unrelated.write_text("keep")
        self.store.append([sample(self.now - monitor.RETENTION - 1),
                           sample(self.now - monitor.RETENTION), sample(self.now, 0), sample(self.now, 1)])
        self.assertEqual(len(self.store.rows), 3)
        self.assertEqual(len(self.store.payload(1)["history"]), 2)
        self.assertEqual(self.store.payload(72)["sample_count"], 2)
        self.assertEqual(len(self.store.payload(1)["latest"]), 2)
        self.now += 1
        self.store.prune()
        reloaded = monitor.Store(self.temp.name, clock=lambda: self.now)
        self.assertEqual(len(reloaded.rows), 2)
        self.assertIsNone(reloaded.rows[0]["memory_util_pct"])
        self.assertEqual(unrelated.read_text(), "keep")
        self.now += monitor.RETENTION
        reloaded = monitor.Store(self.temp.name, clock=lambda: self.now)
        self.assertEqual(reloaded.rows, [])
        self.assertEqual(reloaded.payload(72)["latest"], [])

    def test_failed_write_preserves_previous_data(self):
        self.store.append([sample(self.now)])
        previous = self.store.path.read_bytes()
        with mock.patch.object(monitor.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                self.store.append([sample(self.now + 1)])
        self.assertEqual(self.store.path.read_bytes(), previous)
        self.assertEqual(len(self.store.rows), 1)
        self.assertEqual(list(Path(self.temp.name).glob("*.tmp")), [])

    def test_symlink_is_rejected(self):
        self.store.path.unlink()
        self.store.path.symlink_to(Path(self.temp.name) / "elsewhere.csv")
        with self.assertRaises(RuntimeError):
            monitor.Store(self.temp.name)

    def test_gpu_failure_prunes_and_remains_retryable(self):
        self.store.append([sample(self.now)])
        self.now += monitor.RETENTION + 1
        stop = threading.Event()
        def failure():
            stop.set()
            raise RuntimeError("GPU unavailable")
        with mock.patch.object(monitor, "collect", side_effect=failure):
            monitor.sample_loop(self.store, stop)
        self.assertEqual(self.store.rows, [])
        self.assertIn("GPU unavailable", self.store.last_error)
        self.assertGreater(self.store.next_sample_at, self.store.last_attempt)


class CollectionTests(unittest.TestCase):
    def test_nvidia_csv_and_unsupported_metrics(self):
        result = subprocess.CompletedProcess([], 0, stdout='0, GPU-abc, NVIDIA RTX A6000, 250.25, 300, 86, [N/A], 19000, 49140, 70\n')
        with mock.patch.object(monitor.subprocess, "run", return_value=result):
            rows = monitor.collect()
        self.assertEqual(rows[0]["power_w"], 250.25)
        self.assertEqual(rows[0]["gpu_util_pct"], 86)
        self.assertIsNone(rows[0]["memory_util_pct"])
        self.assertIn("+08:00", rows[0]["timestamp_iso"])
        self.assertIsNone(monitor.number("NaN"))

    def test_malformed_query_is_not_silently_saved(self):
        result = subprocess.CompletedProcess([], 0, stdout="0, GPU-abc\n")
        with mock.patch.object(monitor.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError):
                monitor.collect()


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gpu-monitor-http-test-")
        self.addCleanup(self.temp.cleanup)
        self.store = monitor.Store(self.temp.name)
        self.store.append([sample(self.store.clock())])
        self.server = monitor.ThreadingHTTPServer(("127.0.0.1", 0), monitor.handler_for(self.store))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:{}".format(self.server.server_address[1])
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_api_csv_and_invalid_requests(self):
        with urlopen(self.url + "/api/data?hours=6") as result:
            payload = json.load(result)
            self.assertEqual(len(payload["latest"]), 1)
            self.assertEqual(payload["interval_seconds"], 300)
            self.assertEqual(result.headers["Cache-Control"], "no-store")
        with urlopen(self.url + "/api/export.csv?hours=72") as result:
            rows = list(csv.DictReader(io.StringIO(result.read().decode("utf-8-sig"))))
            self.assertEqual(rows[0]["power_w"], "200.5")
        for path, expected in [("/api/data?hours=nan", 400), ("/api/data?hours=73", 400),
                               ("/api/data?hours=0", 400), ("/../monitor.py", 404),
                               ("/monitor.log", 404)]:
            with self.assertRaises(HTTPError) as raised:
                urlopen(self.url + path)
            self.assertEqual(raised.exception.code, expected)


if __name__ == "__main__":
    unittest.main()
