"""Integrity domain rules: events, consent, pre-check thresholds, risk label, byte ranges.

Pure logic: no I/O, no frameworks. Wording is neutral; nothing here decides an outcome.
The risk label is advisory for human reviewers and never alters a result.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

EVENT_TYPES = (
    "focus_loss", "tab_hidden", "fullscreen_exit", "paste", "copy", "context_menu",
    "devtools_heuristic", "multi_display", "camera_lost", "screen_share_ended",
    "network_drop", "face_absent", "multiple_faces", "instruction_like_text",
)
STREAMS = ("camera", "screen")
CONSENT_SCOPES = ("camera", "screen", "microphone", "events")
SIMILARITY_FLAG = "similar_answer_values"

DEFAULT_WEIGHTS: dict[str, float] = {
    "focus_loss": 1.0, "tab_hidden": 1.0, "fullscreen_exit": 2.0, "paste": 2.0, "copy": 1.0,
    "context_menu": 0.5, "devtools_heuristic": 2.0, "multi_display": 3.0, "camera_lost": 2.0,
    "screen_share_ended": 3.0, "network_drop": 0.25, "face_absent": 1.0, "multiple_faces": 2.0,
    "instruction_like_text": 1.0,
    SIMILARITY_FLAG: 3.0,
}

MAX_BATCH_EVENTS = 100
MAX_DETAIL_KEYS = 8
MAX_ITEM_ID = 64

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{5,63}$", re.ASCII)
_SHORT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$", re.ASCII)
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$", re.ASCII)
_SHA_RE = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
_DETAIL_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$", re.ASCII)


class IntegrityError(Exception):
    """Base for typed, stable errors. `code` is safe to return to clients."""
    code = "integrity_error"


class InvalidInput(IntegrityError):
    code = "invalid_input"


class NotFound(IntegrityError):
    """Unknown OR foreign object: callers must not be able to tell the difference."""
    code = "not_found"


class Conflict(IntegrityError):
    code = "conflict"


class TooLarge(IntegrityError):
    code = "too_large"


class Unsatisfiable(IntegrityError):
    code = "range_not_satisfiable"


def check_attempt_id(value: Any) -> str:
    if not isinstance(value, str) or not _ID_RE.match(value):
        raise InvalidInput("attempt_id")
    return value


def check_learner_id(value: Any) -> str:
    if not isinstance(value, str) or not _SHORT_ID_RE.match(value):
        raise InvalidInput("learner_id")
    return value


def check_stream(value: Any) -> str:
    if value not in STREAMS:
        raise InvalidInput("stream")
    return value


def check_seq(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100_000:
        raise InvalidInput("seq")
    return value


def check_sha256(value: Any) -> str:
    if not isinstance(value, str) or not _SHA_RE.match(value):
        raise InvalidInput("hash")
    return value


def check_task_id(value: Any) -> str:
    if not isinstance(value, str) or not _SHORT_ID_RE.match(value):
        raise InvalidInput("task_id")
    return value


# ---------------------------------------------------------------- consent

@dataclass(frozen=True)
class ConsentRecord:
    attempt_id: str
    learner_id: str
    version: str
    scopes: tuple[str, ...]
    recorded_at: float


def check_consent(version: Any, scopes: Any) -> tuple[str, tuple[str, ...]]:
    if not isinstance(version, str) or not _VERSION_RE.match(version):
        raise InvalidInput("version")
    if not isinstance(scopes, (list, tuple)) or not scopes:
        raise InvalidInput("scopes")
    expanded: list[str] = []
    for s in scopes:
        if s == "camera_microphone":
            expanded.extend(["camera", "microphone"])
        elif s == "integrity_events":
            expanded.append("events")
        else:
            expanded.append(s)
    if any(s not in CONSENT_SCOPES for s in expanded) or len(set(expanded)) != len(expanded):
        raise InvalidInput("scopes")
    return version, tuple(sorted(expanded))


# ---------------------------------------------------------------- events

@dataclass(frozen=True)
class Event:
    type: str
    t_ms: float
    item_id: str | None = None
    detail: Mapping[str, Any] = field(default_factory=dict)


def validate_event(raw: Any) -> Event:
    if isinstance(raw, Event):
        raw = {"type": raw.type, "t_ms": raw.t_ms, "item_id": raw.item_id, "detail": dict(raw.detail)}
    if not isinstance(raw, Mapping) or not set(raw) <= {"type", "t_ms", "item_id", "detail"}:
        raise InvalidInput("event")
    etype = raw.get("type")
    if etype not in EVENT_TYPES:
        raise InvalidInput("event_type")
    t = raw.get("t_ms")
    if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or not 0 <= t <= 1e12:
        raise InvalidInput("t_ms")
    item = raw.get("item_id")
    if item is not None and (not isinstance(item, str) or not _SHORT_ID_RE.match(item)):
        raise InvalidInput("item_id")
    detail = raw.get("detail") or {}
    if not isinstance(detail, Mapping) or len(detail) > MAX_DETAIL_KEYS:
        raise InvalidInput("detail")
    clean: dict[str, Any] = {}
    for k, v in detail.items():
        if not isinstance(k, str) or not _DETAIL_KEY_RE.match(k):
            raise InvalidInput("detail")
        if isinstance(v, str):
            if len(v) > 64:
                raise InvalidInput("detail")
        elif isinstance(v, bool) or v is None:
            pass
        elif isinstance(v, (int, float)):
            if isinstance(v, float) and not math.isfinite(v):
                raise InvalidInput("detail")
        else:
            raise InvalidInput("detail")
        clean[k] = v
    return Event(etype, float(t), item, clean)


def validate_events(raw: Any) -> list[Event]:
    if not isinstance(raw, (list, tuple)) or len(raw) > MAX_BATCH_EVENTS:
        raise InvalidInput("events")
    return [validate_event(e) for e in raw]


# ---------------------------------------------------------------- risk (advisory only)

def risk_summary(counts: Mapping[str, int], weights: Mapping[str, float], medium: float, high: float) -> tuple[float, str]:
    score = sum(weights.get(k, 0.0) * n for k, n in counts.items())
    score = round(score, 3)
    label = "high" if score >= high else "medium" if score >= medium else "low"
    return score, label


# ---------------------------------------------------------------- pre-check

@dataclass(frozen=True)
class PrecheckThresholds:
    min_down_mbps: float = 2.0
    min_up_mbps: float = 1.0
    max_latency_ms: float = 400.0


@dataclass(frozen=True)
class PrecheckResult:
    passed: bool
    checks: tuple[tuple[str, bool, str], ...]

    def to_dict(self) -> dict:
        return {"passed": self.passed,
                "checks": [{"name": n, "passed": ok, "message": msg} for n, ok, msg in self.checks]}


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or v > 1e7:
        return None
    return float(v)


def evaluate_precheck(report: Any, th: PrecheckThresholds) -> PrecheckResult:
    """Evaluate a browser-supplied report. Reject unknown fields; missing/invalid values fail their check."""
    allowed = {"down_mbps", "up_mbps", "latency_ms", "camera", "mic", "screen_surface", "fullscreen",
               "single_display", "browser"}
    if not isinstance(report, Mapping) or not set(report) <= allowed:
        raise InvalidInput("report")
    down, up, lat = _num(report.get("down_mbps")), _num(report.get("up_mbps")), _num(report.get("latency_ms"))
    browser = report.get("browser")
    browser_ok = isinstance(browser, str) and len(browser) <= 80 and any(
        t in browser.lower() for t in ("chrom", "edg", "brave", "opera")) or browser is True
    single = report.get("single_display")
    checks = [
        ("download", down is not None and down >= th.min_down_mbps, "Download speed is below the minimum needed."),
        ("upload", up is not None and up >= th.min_up_mbps, "Upload speed is below the minimum needed."),
        ("latency", lat is not None and lat < th.max_latency_ms, "Connection delay is above the maximum allowed."),
        ("camera", report.get("camera") is True, "Camera access is needed."),
        ("microphone", report.get("mic") is True, "Microphone access is needed."),
        ("screen", report.get("screen_surface") == "monitor", "Please share your entire screen."),
        ("fullscreen", report.get("fullscreen") is True, "Full screen mode is needed."),
        # None means the browser cannot report it: not a failure (spec: "where API available")
        ("single_display", single is None or single is True, "Please use a single display."),
        ("browser", bool(browser_ok), "Please use a Chromium-based browser."),
    ]
    return PrecheckResult(all(ok for _, ok, _ in checks),
                          tuple((n, bool(ok), "" if ok else msg) for n, ok, msg in checks))


# ---------------------------------------------------------------- HTTP Range

def parse_range(header: str | None, total: int) -> tuple[int, int] | None:
    """Return (start, end_inclusive) for a single satisfiable range, None for no/ignored Range.
    Raises Unsatisfiable for ranges outside the resource."""
    if not header:
        return None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip(), re.ASCII)
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return None  # malformed or multi-range: ignore and serve the whole resource
    first, last = m.group(1), m.group(2)
    if first == "":  # suffix range
        n = int(last)
        if n == 0 or total == 0:
            raise Unsatisfiable("range")
        return max(total - n, 0), total - 1
    start = int(first)
    end = int(last) if last else total - 1
    if start >= total or end < start:
        raise Unsatisfiable("range")
    return start, min(end, total - 1)
