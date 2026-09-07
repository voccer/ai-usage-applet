import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "ai-usage@voccer" / "codex_usage.py"
SPEC = importlib.util.spec_from_file_location("codex_usage", MODULE_PATH)
codex_usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(codex_usage)


class ParseRateLimitsTests(unittest.TestCase):
    def fixture_lines(self, name):
        return (ROOT / "tests" / "fixtures" / name).read_text().splitlines()

    def test_maps_codex_primary_secondary_and_plan_without_account_id(self):
        result = codex_usage.parse_rate_limits(
            self.fixture_lines("codex-success.jsonl")
        )

        self.assertEqual(
            result["shortWindow"],
            {
                "usedPercent": 48.0,
                "durationMinutes": 300,
                "resetsAt": 1788808614,
            },
        )
        self.assertEqual(result["longWindow"]["durationMinutes"], 10080)
        self.assertEqual(result["metadata"], {"planType": "plus"})
        self.assertNotIn("accountId", json.dumps(result))
        self.assertNotIn("must-not-leak", json.dumps(result))

    def test_accepts_a_missing_secondary_window(self):
        result = codex_usage.parse_rate_limits(
            self.fixture_lines("codex-missing-secondary.jsonl")
        )

        self.assertIsNone(result["longWindow"])

    def test_rejects_a_missing_codex_bucket(self):
        lines = [
            json.dumps(
                {
                    "id": 2,
                    "result": {
                        "rateLimitsByLimitId": {
                            "other": {"limitId": "other", "primary": {}}
                        }
                    },
                }
            )
        ]

        with self.assertRaisesRegex(
            codex_usage.AdapterError, "usage bucket is unavailable"
        ):
            codex_usage.parse_rate_limits(lines)

    def test_rejects_an_app_server_error_without_copying_its_message(self):
        lines = [
            json.dumps(
                {
                    "id": 2,
                    "error": {"message": "secret upstream response"},
                }
            )
        ]

        with self.assertRaisesRegex(
            codex_usage.AdapterError, "app-server returned an error"
        ) as raised:
            codex_usage.parse_rate_limits(lines)
        self.assertNotIn("secret", str(raised.exception))

    def test_rejects_malformed_jsonl(self):
        with self.assertRaisesRegex(codex_usage.AdapterError, "malformed JSON"):
            codex_usage.parse_rate_limits(["not-json"])


class QueryCodexTests(unittest.TestCase):
    def make_server(self, directory, body):
        path = Path(directory) / "fake-codex"
        path.write_text("#!/usr/bin/python3\n" + textwrap.dedent(body))
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def test_queries_a_real_child_process_and_sets_codex_home(self):
        with tempfile.TemporaryDirectory() as directory:
            server = self.make_server(
                directory,
                """
                import json
                import os
                import sys

                for _ in range(3):
                    sys.stdin.readline()
                response = {
                    "id": 2,
                    "result": {
                        "rateLimitsByLimitId": {
                            "codex": {
                                "limitId": "codex",
                                "primary": {
                                    "usedPercent": 33,
                                    "windowDurationMins": 300,
                                    "resetsAt": 1788808614,
                                },
                                "secondary": None,
                                "planType": os.environ.get("CODEX_HOME"),
                            }
                        }
                    },
                }
                print(json.dumps(response), flush=True)
                sys.stdin.readline()
                """,
            )

            result = codex_usage.query_codex(server, "/expected/codex-home", 2)

        self.assertEqual(result["shortWindow"]["usedPercent"], 33.0)
        self.assertEqual(result["metadata"]["planType"], "/expected/codex-home")

    def test_times_out_and_reaps_a_nonresponsive_child(self):
        with tempfile.TemporaryDirectory() as directory:
            server = self.make_server(
                directory,
                """
                import sys
                import time

                for _ in range(3):
                    sys.stdin.readline()
                time.sleep(30)
                """,
            )

            with self.assertRaisesRegex(codex_usage.AdapterError, "timed out"):
                codex_usage.query_codex(server, directory, 0.05)

    def test_reports_a_missing_executable_without_leaking_its_path(self):
        with self.assertRaisesRegex(codex_usage.AdapterError, "not available") as raised:
            codex_usage.query_codex("/secret/path/to/codex", "/secret/home", 1)

        self.assertNotIn("/secret", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
