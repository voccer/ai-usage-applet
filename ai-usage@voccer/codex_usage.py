#!/usr/bin/python3
"""Read Codex subscription rate limits through the Codex app-server."""

from __future__ import annotations

import argparse
from collections.abc import Iterable
import json
import os
import selectors
import subprocess
import sys
import time
from typing import Any


REQUEST_ID = 2


class AdapterError(RuntimeError):
    """A user-safe Codex adapter error."""


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AdapterError(f"Codex {field} is invalid")
    return float(value)


def _window(value: Any, required: bool = False) -> dict[str, Any] | None:
    if value is None:
        if required:
            raise AdapterError("Codex primary usage window is unavailable")
        return None
    if not isinstance(value, dict):
        raise AdapterError("Codex usage window is invalid")

    used_percent = _number(value.get("usedPercent"), "usage percentage")
    duration = _number(value.get("windowDurationMins"), "window duration")
    resets_at_value = value.get("resetsAt")

    if used_percent < 0 or used_percent > 100:
        raise AdapterError("Codex usage percentage is invalid")
    if duration <= 0 or not duration.is_integer():
        raise AdapterError("Codex window duration is invalid")

    resets_at = None
    if resets_at_value is not None:
        resets_at_number = _number(resets_at_value, "reset time")
        if resets_at_number <= 0 or not resets_at_number.is_integer():
            raise AdapterError("Codex reset time is invalid")
        resets_at = int(resets_at_number)

    return {
        "usedPercent": used_percent,
        "durationMinutes": int(duration),
        "resetsAt": resets_at,
    }


def parse_rate_limits(
    lines: Iterable[str], request_id: int = REQUEST_ID
) -> dict[str, Any]:
    """Parse a sanitized rate-limit response from app-server JSONL."""

    for line in lines:
        try:
            message = json.loads(line)
        except (json.JSONDecodeError, TypeError) as error:
            raise AdapterError("Codex app-server returned malformed JSON") from error

        if not isinstance(message, dict) or message.get("id") != request_id:
            continue
        if message.get("error"):
            raise AdapterError("Codex app-server returned an error")

        result = message.get("result")
        if not isinstance(result, dict):
            raise AdapterError("Codex app-server returned no usage result")

        buckets = result.get("rateLimitsByLimitId")
        bucket = buckets.get("codex") if isinstance(buckets, dict) else None
        if bucket is None:
            fallback = result.get("rateLimits")
            if isinstance(fallback, dict) and fallback.get("limitId") == "codex":
                bucket = fallback
        if not isinstance(bucket, dict) or bucket.get("limitId") != "codex":
            raise AdapterError("Codex usage bucket is unavailable")

        plan_type = bucket.get("planType")
        if plan_type is not None and not isinstance(plan_type, str):
            plan_type = None

        return {
            "ok": True,
            "provider": "codex",
            "shortWindow": _window(bucket.get("primary"), required=True),
            "longWindow": _window(bucket.get("secondary")),
            "metadata": {"planType": plan_type},
        }

    raise AdapterError("Codex app-server returned no usage response")


def _messages() -> str:
    messages = [
        {
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "ai_usage_cinnamon",
                    "title": "AI Usage Cinnamon Applet",
                    "version": "1.0.0",
                }
            },
        },
        {"method": "initialized", "params": {}},
        {"method": "account/rateLimits/read", "id": REQUEST_ID},
    ]
    return "".join(json.dumps(message, separators=(",", ":")) + "\n" for message in messages)


def _stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=1)


def query_codex(
    codex_path: str, codex_home: str, timeout: float = 10.0
) -> dict[str, Any]:
    """Run app-server long enough to receive one rate-limit response."""

    environment = os.environ.copy()
    environment["CODEX_HOME"] = codex_home
    codex_bin_directory = os.path.dirname(os.path.abspath(codex_path))
    environment["PATH"] = os.pathsep.join(
        part for part in (codex_bin_directory, environment.get("PATH")) if part
    )
    try:
        process = subprocess.Popen(
            [codex_path, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=environment,
        )
    except (FileNotFoundError, PermissionError, OSError) as error:
        raise AdapterError("Codex executable is not available") from error

    if process.stdin is None or process.stdout is None:
        _stop_process(process)
        raise AdapterError("Codex app-server pipes are unavailable")

    selector = selectors.DefaultSelector()
    try:
        process.stdin.write(_messages())
        process.stdin.flush()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterError("Codex app-server timed out")

            events = selector.select(remaining)
            if not events:
                raise AdapterError("Codex app-server timed out")

            line = process.stdout.readline()
            if not line:
                if process.poll() is not None:
                    raise AdapterError("Codex app-server closed unexpectedly")
                continue

            try:
                message = json.loads(line)
            except json.JSONDecodeError as error:
                raise AdapterError("Codex app-server returned malformed JSON") from error

            if isinstance(message, dict) and message.get("id") == REQUEST_ID:
                return parse_rate_limits([line])
    finally:
        selector.close()
        try:
            process.stdin.close()
        except OSError:
            pass
        _stop_process(process)
        try:
            process.stdout.close()
        except OSError:
            pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True, help="Path to the Codex executable")
    parser.add_argument("--codex-home", required=True, help="Codex configuration directory")
    parser.add_argument("--timeout", type=float, default=10.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = query_codex(args.codex, args.codex_home, args.timeout)
    except AdapterError as error:
        print(
            json.dumps(
                {"ok": False, "provider": "codex", "error": str(error)},
                separators=(",", ":"),
            )
        )
        return 1
    except Exception:
        print(
            json.dumps(
                {
                    "ok": False,
                    "provider": "codex",
                    "error": "Unexpected Codex adapter failure",
                },
                separators=(",", ":"),
            )
        )
        return 1

    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
