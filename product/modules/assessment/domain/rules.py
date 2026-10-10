"""Assessment domain: levels, qualify rules, answer checking, deterministic selection. Pure."""
from __future__ import annotations

import random
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional, Sequence

LEVEL_NAMES = {1: "Conceptual", 2: "Debugging", 3: "Applied", 4: "Live AI screening"}
TRACKS = ("python", "data_analyst")
TRACK_COMPETENCY = {"python": "python", "data_analyst": "sql"}

OPEN_STATUSES = ("created", "ready", "in_progress")
FINAL_STATUSES = ("passed", "failed", "awaiting_review")

L4_CRITERIA = ("explain", "justify_approach", "complexity", "edge_cases", "adapt_constraint")


class AssessmentError(Exception):
    """Typed, stable error. `code` is safe to return to clients."""

    status = 400
    code = "assessment_error"

    def __init__(self, message: str = "", code: Optional[str] = None):
        super().__init__(message or (code or self.code))
        if code:
            self.code = code


class NotFound(AssessmentError):
    status = 404
    code = "not_found"


class Conflict(AssessmentError):
    status = 409
    code = "conflict"


class InvalidInput(AssessmentError):
    status = 422
    code = "invalid_input"


class RateLimited(AssessmentError):
    status = 429
    code = "run_limit_reached"


class Unavailable(AssessmentError):
    status = 503
    code = "service_unavailable"


@dataclass(frozen=True)
class Rules:
    version: str
    l1_count: int
    l1_min_correct: int
    l2_count: int
    l2_min_pass: int
    l3_tasks: int
    l3_min_full_tasks: int
    l3_min_ratio: float
    l4_min_total: int
    l4_min_each: int
    l4_max_per: int
    l4_low_confidence: float
    run_limit: int

    @staticmethod
    def from_json(d: Mapping[str, Any]) -> "Rules":
        return Rules(
            version=d["version"], l1_count=d["L1"]["count"], l1_min_correct=d["L1"]["min_correct"],
            l2_count=d["L2"]["count"], l2_min_pass=d["L2"]["min_pass"],
            l3_tasks=d["L3"]["tasks"], l3_min_full_tasks=d["L3"]["min_full_tasks"],
            l3_min_ratio=float(d["L3"]["min_test_ratio"]),
            l4_min_total=d["L4"]["min_total"], l4_min_each=d["L4"]["min_each"],
            l4_max_per=d["L4"]["max_per_criterion"], l4_low_confidence=float(d["L4"]["low_confidence_below"]),
            run_limit=int(d["run_limit_per_item"]),
        )


# ----------------------------------------------------------------- qualify rules
def qualify_l1(correct: int, rules: Rules) -> bool:
    return correct >= rules.l1_min_correct


def qualify_l2(passed: int, rules: Rules) -> bool:
    return passed >= rules.l2_min_pass


def qualify_l3(stage_results: Mapping[str, Sequence[tuple[int, int]]], rules: Rules) -> bool:
    """stage_results: task id -> [(tests_passed, tests_total) for base, mutated].

    Pass when both variants of at least `min_full_tasks` tasks pass all hidden tests and the
    overall hidden-test ratio is at least `min_test_ratio`.
    """
    full = 0
    passed_tests = total_tests = 0
    for results in stage_results.values():
        for p, t in results:
            passed_tests += p
            total_tests += t
        if len(results) == 2 and all(t > 0 and p == t for p, t in results):
            full += 1
    ratio = (passed_tests / total_tests) if total_tests else 0.0
    return full >= rules.l3_min_full_tasks and ratio >= rules.l3_min_ratio


def l3_ratio(stage_results: Mapping[str, Sequence[tuple[int, int]]]) -> float:
    p = sum(a for r in stage_results.values() for a, _ in r)
    t = sum(b for r in stage_results.values() for _, b in r)
    return (p / t) if t else 0.0


@dataclass(frozen=True)
class L4Verdict:
    total: int
    passed: bool
    needs_review: bool
    scores: dict


def qualify_l4(criteria: Sequence[Mapping[str, Any]], rules: Rules, flagged_for_review: bool = False) -> L4Verdict:
    """Each of the five criteria scored 0..max; pass if total >= min_total and no criterion below min_each.

    Low confidence (or an upstream review flag) routes to human review instead of a final verdict.
    """
    scores: dict[str, int] = {}
    low = flagged_for_review
    for c in criteria:
        name = c.get("criterion")
        raw = c.get("score0to3", c.get("score"))
        if name not in L4_CRITERIA or isinstance(raw, bool) or not isinstance(raw, int):
            raise InvalidInput("evaluation criterion", "invalid_evaluation")
        if not 0 <= raw <= rules.l4_max_per or name in scores:
            raise InvalidInput("evaluation score", "invalid_evaluation")
        scores[name] = raw
        conf = c.get("confidence")
        if isinstance(conf, (int, float)) and conf < rules.l4_low_confidence:
            low = True
    if set(scores) != set(L4_CRITERIA):
        raise InvalidInput("evaluation must cover all criteria", "invalid_evaluation")
    total = sum(scores.values())
    ok = total >= rules.l4_min_total and min(scores.values()) >= rules.l4_min_each
    return L4Verdict(total, ok, low, scores)


# ----------------------------------------------------------------- answer checking
def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text).strip().lower())


def check_answer(item: Mapping[str, Any], variant: Mapping[str, Any], answer: Any) -> bool:
    kind = item["kind"]
    if kind in ("single", "multi"):
        expected = set(variant.get("answer", item.get("answer", [])))
        if isinstance(answer, str):
            answer = [answer]
        if not isinstance(answer, (list, tuple)):
            return False
        given = set(a for a in answer if isinstance(a, str))
        return given == expected and len(given) == len(answer)
    if kind == "short":
        accepted = variant.get("accepted", item.get("accepted", []))
        if not isinstance(answer, str):
            return False
        return _norm(answer) in {_norm(a) for a in accepted}
    if kind == "decision":
        # Decision Arena: the learner picks one action and the evidence that supports it.
        # Both must match exactly - wrong or unsupported evidence choices fail the item the
        # same way a wrong action does, so "avoid unsupported claims" is enforced by the
        # scoring itself rather than a separate penalty dimension.
        expected_action = variant.get("action", item.get("action"))
        expected_evidence = set(variant.get("evidence", item.get("evidence", [])))
        if not isinstance(answer, Mapping):
            return False
        given_action = answer.get("action")
        given_evidence = answer.get("evidence")
        if not isinstance(given_evidence, (list, tuple)):
            return False
        given_evidence_set = set(e for e in given_evidence if isinstance(e, str))
        return given_action == expected_action and given_evidence_set == expected_evidence and len(given_evidence_set) == len(given_evidence)
    return False


# ----------------------------------------------------------------- selection
def draw(pool: Sequence[str], count: int, rng: random.Random, avoid: Iterable[str] = ()) -> list[str]:
    """Pick `count` ids deterministically for a seed, preferring ids not in `avoid`."""
    avoid_set = set(avoid)
    fresh = [p for p in pool if p not in avoid_set]
    stale = [p for p in pool if p in avoid_set]
    rng.shuffle(fresh)
    rng.shuffle(stale)
    return (fresh + stale)[:count]


def explanation_coverage(explanation: str, rubric: Mapping[str, Any]) -> tuple[int, int]:
    """Deterministic keyword rubric: (criteria covered, criteria total)."""
    text = _norm(explanation or "")
    criteria = rubric.get("criteria", [])
    covered = sum(1 for c in criteria if any(k.lower() in text for k in c.get("keywords", [])))
    return covered, len(criteria)
