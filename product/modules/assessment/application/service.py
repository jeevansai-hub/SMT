"""Assessment use cases: attempts, items, grading orchestration, progression, gating."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional, Sequence

from assessment.application import plan as planning
from assessment.application.ports import (
    Attempt,
    AttemptRepository,
    BankPort,
    FeedbackPort,
    IntegrityPort,
    LedgerPort,
    NullFeedback,
    NullIntegrity,
    RunnerPort,
    ScoringPort,
)
from assessment.domain import rules as R

log = logging.getLogger("assessment")

CONSENT_VERSION = "2026-10-v1"
REQUIRED_SCOPES = ("camera", "microphone", "screen", "events")
EVENT_TYPES = ("focus_loss", "tab_hidden", "fullscreen_exit", "paste", "copy", "context_menu",
               "devtools_heuristic", "multi_display", "camera_lost", "screen_share_ended",
               "network_drop", "face_absent")
STREAMS = ("camera", "screen")
MAX_CODE_BYTES = 20 * 1024
MAX_EXPLANATION = 2000
MAX_EVENTS = 100
MAX_CHUNK_BYTES = 8 * 1024 * 1024
MODEL_REF_RUBRIC = "keyword-rubric-1.0.0"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", text.lower())


def _sha(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


class AssessmentService:
    def __init__(self, bank: BankPort, repo: AttemptRepository, runner: RunnerPort, ledger: LedgerPort,
                 scoring: ScoringPort, clock: Callable[[], datetime],
                 integrity: Optional[IntegrityPort] = None, feedback: Optional[FeedbackPort] = None,
                 proctoring_required: bool = True) -> None:
        self._bank = bank
        self._repo = repo
        self._runner = runner
        self._ledger = ledger
        self._scoring = scoring
        self._clock = clock
        self._integrity = integrity or NullIntegrity()
        self._feedback = feedback or NullFeedback()
        self._proctoring = proctoring_required
        self._lock = threading.RLock()

    @property
    def rules(self) -> R.Rules:
        return self._bank.rules

    # ------------------------------------------------------------------ setup
    def register_tasks(self) -> int:
        count = 0
        for track in R.TRACKS:
            for level in (2, 3):
                for item in self._bank.items(track, level):
                    for tid, kind, spec in planning.task_specs(track, level, item):
                        self._runner.register(tid, kind, spec)
                        count += 1
        return count

    # ------------------------------------------------------------------ helpers
    def _now(self) -> str:
        return _iso(self._clock())

    def _owned(self, attempt_id: str, learner_id: str) -> Attempt:
        att = self._repo.get(attempt_id) if isinstance(attempt_id, str) and len(attempt_id) <= 64 else None
        if att is None or att.learner_id != learner_id:
            raise R.NotFound("not found")  # identical for unknown and foreign ids
        return att

    def _bank_item(self, att: Attempt, bank_id: str) -> dict:
        for it in self._bank.items(att.track, att.level):
            if it["id"] == bank_id:
                return it
        raise R.NotFound("not found")

    def _plan_item(self, att: Attempt, item_ref: str) -> dict:
        for p in att.plan:
            if p["ref"] == item_ref or p.get("task_uuid") == item_ref or p.get("bank_id") == item_ref:
                return p
        raise R.NotFound("not found")

    def _source(self, att: Attempt, p: Mapping[str, Any]) -> Mapping[str, Any]:
        it = self._bank_item(att, p["bank_id"])
        return it["stages"][p["stage"]] if p.get("stage") else it

    def _dataset(self, att: Attempt, p: Mapping[str, Any]) -> Mapping[str, Any]:
        for ds in self._source(att, p)["datasets"]:
            if ds["name"] == p["dataset"]:
                return ds
        raise R.NotFound("not found")

    def _tests_total(self, att: Attempt, p: Mapping[str, Any]) -> int:
        return len(self._dataset(att, p)["tests"])

    def _competency(self, att_or_track) -> str:
        track = att_or_track.track if isinstance(att_or_track, Attempt) else att_or_track
        return R.TRACK_COMPETENCY[track]

    def attempt_for(self, attempt_id: str, learner_id: str) -> Optional[Attempt]:
        """The attempt when owned by learner_id, else None (no distinction between unknown and foreign)."""
        try:
            return self._owned(attempt_id, learner_id)
        except R.NotFound:
            return None

    # ------------------------------------------------------------------ attempts
    def create_attempt(self, learner_id: str, track: Optional[str], level: Any) -> tuple[Attempt, bool]:
        if isinstance(level, bool) or not isinstance(level, int) or level not in (1, 2, 3, 4):
            raise R.InvalidInput("level")
        if track not in R.TRACKS:
            raise R.Conflict("track required", "track_required")
        with self._lock:
            attempts = self._repo.for_learner(learner_id, track)
            passed = {a.level for a in attempts if a.status == "passed"}
            if level in passed:
                raise R.Conflict("already passed", "already_passed")
            if any(lv not in passed for lv in range(1, level)):
                raise R.Conflict("level locked", "level_locked")
            same = [a for a in attempts if a.level == level]
            if any(a.status == "awaiting_review" for a in same):
                raise R.Conflict("awaiting review", "awaiting_review")
            open_ = [a for a in same if a.status in R.OPEN_STATUSES]
            if open_:
                return open_[-1], False
            seed = secrets.token_hex(6)
            used = [p["bank_id"] for a in same for p in a.plan]
            plan = planning.build_plan(track, level, seed, self._bank.items(track, level) if level < 4 else [],
                                       self.rules, used) if level < 4 else []
            att = Attempt(id="att_" + secrets.token_hex(8), learner_id=learner_id, track=track, level=level,
                          attempt_no=len(same) + 1, seed=seed, status="created", plan=tuple(plan),
                          created_at=self._now())
            self._repo.add(att)
            log.info("attempt_created", extra={"event": "attempt_created", "attempt": att.id, "level": level})
            return att, True

    def record_consent(self, attempt_id: str, learner_id: str, version: Any, scopes: Any) -> Attempt:
        if version != CONSENT_VERSION or not isinstance(scopes, (list, tuple)) \
                or any(not isinstance(s, str) for s in scopes) or len(set(scopes)) != len(scopes):
            raise R.InvalidInput("consent", "consent_incomplete")
        # Normalize scopes (supporting both compound aliases and atomic scopes)
        expanded: list[str] = []
        for s in scopes:
            if s == "camera_microphone":
                expanded.extend(["camera", "microphone"])
            elif s == "integrity_events":
                expanded.append("events")
            else:
                expanded.append(s)
        expanded_set = set(expanded)
        if not set(REQUIRED_SCOPES) <= expanded_set or not expanded_set <= set(REQUIRED_SCOPES):
            raise R.InvalidInput("consent", "consent_incomplete")
        normalized_scopes = list(sorted(expanded_set))
        with self._lock:
            att = self._owned(attempt_id, learner_id)
            if att.status in R.FINAL_STATUSES:
                raise R.Conflict("attempt closed", "attempt_closed")
            if att.consent is not None:
                return att
            try:
                self._integrity.record_consent(att.id, learner_id, version, normalized_scopes)
            except Exception:
                log.exception("consent_record_failed")
                raise R.Unavailable("consent could not be stored")
            att = att.with_(consent={"version": version, "scopes": normalized_scopes, "at": self._now()},
                            status="ready" if att.status == "created" else att.status)
            self._repo.update(att)
            return att

    def start(self, attempt_id: str, learner_id: str) -> Attempt:
        with self._lock:
            att = self._owned(attempt_id, learner_id)
            if att.status == "in_progress":
                return att
            if att.status not in ("created", "ready"):
                raise R.Conflict("attempt closed", "attempt_closed")
            if self._proctoring and att.consent is None:
                raise R.Conflict("consent required", "consent_required")
            if att.level == 4 and self.l3_solution(learner_id, att.track) is None:
                raise R.Conflict("level 3 solution missing", "l3_solution_missing")
            att = att.with_(status="in_progress", started_at=self._now())
            self._repo.update(att)
            return att

    # ------------------------------------------------------------------ views
    def view(self, attempt_id: str, learner_id: str) -> dict:
        return self.view_of(self._owned(attempt_id, learner_id))

    def view_of(self, att: Attempt) -> dict:
        out: dict[str, Any] = {
            "attempt_id": att.id, "level": att.level, "level_name": R.LEVEL_NAMES[att.level], "track": att.track,
            "status": att.status, "attempt_no": att.attempt_no,
            "consent_required": self._proctoring and att.consent is None,
            "items": [],
        }
        if att.status == "in_progress":
            out["items"] = self._public_items(att)
        if att.result is not None:
            out["result"] = dict(att.result)
        return out

    def _public_items(self, att: Attempt) -> list[dict]:
        answers = self._repo.answers(att.id)
        items = []
        for p in att.plan:
            it = self._bank_item(att, p["bank_id"])
            answered = p["ref"] in answers
            if att.level == 1:
                variant = ({} if p["variant"] == 0 else it["variants"][p["variant"] - 1])
                opts = {o["id"]: o for o in variant.get("options", it.get("options", []))}
                view = {"item_id": p["ref"], "kind": it["kind"], "prompt": variant.get("prompt", it["prompt"]),
                        "answered": answered}
                code = variant.get("code", it.get("code"))
                if code is not None:
                    view["code"] = code
                if it["kind"] in ("single", "multi"):
                    view["options"] = [{"id": i, "text": opts[i]["text"]} for i in p["option_order"] if i in opts]
            elif att.level == 2:
                view = {"item_id": p["ref"], "kind": it["kind"], "title": it["title"], "prompt": it["prompt"],
                        "broken_code": it["broken_code"], "answered": answered}
                if it.get("schema"):
                    view["schema"] = it["schema"]
            else:
                st = it["stages"][p["stage"]]
                base_ref = planning.item_ref(p["bank_id"], "base")
                view = {"item_id": p["ref"], "kind": it["kind"], "title": it["title"], "stage": p["stage"],
                        "prompt": st["prompt"], "starter_code": st["starter_code"], "answered": answered,
                        "locked": p["stage"] == "mutated" and base_ref not in answers}
                if st.get("schema"):
                    view["schema"] = st["schema"]
            items.append(view)
        return items

    # ------------------------------------------------------------------ answering
    def _check_active(self, att: Attempt) -> None:
        if att.status != "in_progress":
            raise R.Conflict("attempt not active", "attempt_not_active")

    def _unlocked(self, att: Attempt, p: Mapping[str, Any]) -> bool:
        if p.get("stage") != "mutated":
            return True
        return planning.item_ref(p["bank_id"], "base") in self._repo.answers(att.id)

    def _validate_code(self, code: Any) -> str:
        if not isinstance(code, str) or not code.strip() or len(code.encode("utf-8")) > MAX_CODE_BYTES or "\x00" in code:
            raise R.InvalidInput("code")
        return code

    def _execute(self, att: Attempt, p: Mapping[str, Any], code: str, profile_kind: str) -> tuple[Any, int, int]:
        kind = self._bank_item(att, p["bank_id"])["kind"]
        profile = {("python", "check"): "py_check", ("python", "tests"): "py_tests",
                   ("sql", "check"): "sql_check", ("sql", "tests"): "sql_submit"}[(kind, profile_kind)]
        try:
            out = self._runner.run(kind, p["task_uuid"], p["dataset_uuid"], profile, code)
        except Exception:
            log.exception("runner_call_failed")
            raise R.Unavailable("runner unavailable", "runner_unavailable")
        if out.status == "runner_unavailable":
            raise R.Unavailable("runner unavailable", "runner_unavailable")
        total = self._tests_total(att, p)
        passed = sum(1 for t in out.tests if t["passed"]) if out.status in ("passed", "failed_tests") else 0
        return out, min(passed, total), total

    def submit_item(self, attempt_id: str, learner_id: str, item_id: Any, answer: Any,
                    explanation: Optional[str]) -> dict:
        with self._lock:
            att = self._owned(attempt_id, learner_id)
            if not isinstance(item_id, str):
                raise R.NotFound("not found")
            self._check_active(att)
            p = self._plan_item(att, item_id)
            if not self._unlocked(att, p):
                raise R.Conflict("variant locked", "variant_locked")
            it = self._bank_item(att, p["bank_id"])
            result: dict[str, Any] = {"item_id": item_id, "recorded": True}
            if att.level == 1:
                answer = self._validate_l1_answer(it, p, answer)
                variant = {} if p["variant"] == 0 else it["variants"][p["variant"] - 1]
                graded = {"correct": R.check_answer(it, variant, answer)}
                fp_text = _canon(sorted(answer) if isinstance(answer, list) else str(answer).strip().lower())
                explanation = None
            else:
                answer = self._validate_code(answer)
                if explanation is not None and (not isinstance(explanation, str) or len(explanation) > MAX_EXPLANATION):
                    raise R.InvalidInput("explanation")
                out, passed, total = self._execute(att, p, answer, "tests")
                graded = {"passed": passed, "total": total, "status": out.status,
                          "isolation_mode": out.isolation_mode}
                result.update(status=out.status, tests_passed=passed, tests_total=total)
                fp_text = " ".join(answer.split())
                if att.level == 3:
                    explanation = None
            self._repo.upsert_answer(att.id, item_id, answer, explanation, graded, self._now())
        try:  # similarity fingerprint (reviewer-only flag); never blocks the learner
            self._integrity.fingerprint_submit(att.id, self._task_label(att, p), _sha(fp_text))
        except Exception:
            log.warning("fingerprint_failed")
        return result

    def _task_label(self, att: Attempt, p: Mapping[str, Any]) -> str:
        return p.get("task_uuid") or str(uuid.uuid5(planning.NAMESPACE, f"{att.track}/{p['bank_id']}"))

    def _validate_l1_answer(self, it: Mapping[str, Any], p: Mapping[str, Any], answer: Any):
        if it["kind"] == "short":
            if not isinstance(answer, str) or len(answer) > 200:
                raise R.InvalidInput("answer")
            return answer
        if isinstance(answer, str):
            answer = [answer]
        valid = set(p["option_order"])
        if (not isinstance(answer, list) or len(answer) > len(valid) + 3 or
                any(not isinstance(a, str) or len(a) > 8 for a in answer)):
            raise R.InvalidInput("answer")
        if it["kind"] == "single" and len(answer) != 1:
            raise R.InvalidInput("answer")
        return answer

    def run(self, attempt_id: str, learner_id: str, item_id: Any, code: Any) -> dict:
        with self._lock:
            att = self._owned(attempt_id, learner_id)
            if not isinstance(item_id, str):
                raise R.NotFound("not found")
            self._check_active(att)
            p = self._plan_item(att, item_id)
            if att.level not in (2, 3):
                raise R.InvalidInput("not runnable", "not_runnable")
            if not self._unlocked(att, p):
                raise R.Conflict("variant locked", "variant_locked")
            code = self._validate_code(code)
            if self._repo.count_runs(att.id, item_id) >= self.rules.run_limit:
                raise R.RateLimited("run limit reached")
            out, passed, total = self._execute(att, p, code, "check")
            self._repo.add_run(att.id, item_id, self._now())
            tests = [{"id": t["id"], "passed": bool(t["passed"]), "message_safe": t.get("message_safe", "")}
                     for t in out.tests]
            res = {"status": out.status, "tests": tests, "tests_passed": passed, "tests_total": total,
                   "stdout_trunc": out.stdout_trunc}
            failed = [t for t in tests if not t["passed"]]
            if failed:
                try:
                    note = self._feedback.explain_failures(
                        self._bank_item(att, p["bank_id"]).get("title", ""), failed, passed)
                except Exception:
                    note = None
                if note:
                    res["feedback"] = {"text": note, "ai_generated": True}
            return res

    # ------------------------------------------------------------------ finishing
    def finish(self, attempt_id: str, learner_id: str) -> dict:
        with self._lock:
            att = self._owned(attempt_id, learner_id)
            if att.status in R.FINAL_STATUSES:
                return dict(att.result or {})
            if att.status != "in_progress":
                raise R.Conflict("not started", "not_started")
            if att.level == 4:
                raise R.Conflict("use the interview", "use_interview")
            answers = self._repo.answers(att.id)
            items = []
            for p in att.plan:
                g = (answers.get(p["ref"]) or {}).get("graded")
                if att.level == 1:
                    items.append({"ref": p["ref"], "bank_id": p["bank_id"], "passed": bool(g and g.get("correct")), "p": 1 if g and g.get("correct") else 0, "t": 1})
                else:
                    total = g["total"] if g else self._tests_total(att, p)
                    done = g["passed"] if g else 0
                    items.append({"ref": p["ref"], "passed": bool(g) and done == total and total > 0, "p": done, "t": total,
                                  "bank_id": p["bank_id"], "stage": p.get("stage")})
            ok = self._qualify(att, items)
            self._write_events(att, items, answers, ok)

            result_items = []
            for i in items:
                b_item = self._bank_item(att, i["bank_id"]) if "bank_id" in i else None
                title = b_item.get("title") if b_item else None
                label = f"Item {i['ref']}" + (f": {title}" if title else "")
                frac = (i["p"] / i["t"]) if i["t"] else 0.0
                outcome = "pass" if i["passed"] else ("partial" if i["p"] > 0 else "fail")
                reason = (f"{i['p']} of {i['t']} automated tests passed." if att.level > 1
                          else ("Answer matched the correct solution." if i["passed"] else "Answer did not match the key."))
                event_id = f"{att.id}:{i['ref']}:crit"
                result_items.append({
                    "item_id": i["ref"],
                    "label": label,
                    "passed": i["passed"],
                    "outcome": outcome,
                    "method": "deterministic_test",
                    "score": frac,
                    "reason": reason,
                    "event_id": event_id
                })

            passed_count = sum(1 for i in items if i["passed"])
            total_count = len(items)
            pct = int(round((passed_count / total_count) * 100)) if total_count else 0
            ev_hash = f"ev_{att.seed[:8]}_{secrets.token_hex(4)}"

            result = {
                "outcome": "passed" if ok else "failed",
                "level": att.level,
                "next_level": (att.level + 1) if (ok and att.level < 4) else None,
                "all_passed": (ok and att.level == 4),
                "items_passed": passed_count,
                "items_total": total_count,
                "score_percentage": pct,
                "evidence_hash": ev_hash,
                "evidence_receipt": f"SHA256:{_sha(f'{att.id}:{ev_hash}:{passed_count}')[:32]}",
                "items": result_items,
                "score_update": "not_applicable"
            }
            att = att.with_(status="passed" if ok else "failed", result=result, finished_at=self._now())
            self._repo.update(att)
            log.info("attempt_finished", extra={"event": "attempt_finished", "attempt": att.id,
                                                "level": att.level, "outcome": result["outcome"]})
            return result

    def _qualify(self, att: Attempt, items: list[dict]) -> bool:
        if att.level == 1:
            return R.qualify_l1(sum(1 for i in items if i["passed"]), self.rules)
        if att.level == 2:
            return R.qualify_l2(sum(1 for i in items if i["passed"]), self.rules)
        tasks: dict[str, list[tuple[int, int]]] = {}
        for i in items:
            tasks.setdefault(i["bank_id"], []).append((i["p"], i["t"]))
        return R.qualify_l3(tasks, self.rules)

    # ------------------------------------------------------------------ evidence
    def _base_event(self, att: Attempt, level_meta: Mapping[str, Any]) -> dict:
        return {"competency_id": "cmp_" + self._competency(att), "level": att.level,
                "task_version": level_meta["version"], "rubric_id": level_meta["rubric_id"],
                "rubric_version": level_meta["version"], "seed_id": "sd_" + att.seed}

    def _write_events(self, att: Attempt, items: list[dict], answers: Mapping[str, dict], ok: bool) -> None:
        meta = self._bank.meta(att.track, att.level)
        base = self._base_event(att, meta)
        for i in items:
            ans = answers.get(i["ref"])
            slug = _slug(i["ref"].replace("-", "_").replace(":", "_"))
            ref = _sha(_canon(ans["answer"])) if ans else _sha("unanswered:" + i["ref"])
            frac = (i["p"] / i["t"]) if i["t"] else 0.0
            outcome = "pass" if i["passed"] else ("partial" if i["p"] > 0 else "fail")
            self._ledger.append("criterion_result", att.learner_id, dict(
                base, criterion_id="crt_" + slug, task_id="tsk_" + slug, method="deterministic_test",
                outcome=outcome, score=frac, submission_ref=ref,
                rationale=f"{i['p']} of {i['t']} hidden checks passed." if att.level > 1
                else ("Answer matched the key." if i["passed"] else "Answer did not match the key."),
            ), f"{att.id}:{i['ref']}:crit")
            if att.level == 2 and ans and ans.get("explanation"):
                self._explanation_event(att, base, i, ans, slug)
        passed_n = sum(1 for i in items if i["passed"])
        self._ledger.append("level_outcome", att.learner_id, dict(
            base, task_id=f"tsk_level_{att.level}_{_slug(att.track)}", method="deterministic_test",
            outcome="pass" if ok else "fail", score=passed_n / len(items) if items else 0.0,
            rationale=f"{passed_n} of {len(items)} items passed; qualify rule {'met' if ok else 'not met'}.",
        ), f"{att.id}:level")

    def _explanation_event(self, att: Attempt, base: Mapping[str, Any], i: Mapping[str, Any], ans: Mapping[str, Any], slug: str) -> None:
        bank_item = self._bank_item(att, i["bank_id"])
        covered, total = R.explanation_coverage(ans["explanation"], bank_item["rubric"])
        model_ref, confidence = MODEL_REF_RUBRIC, 0.5
        try:
            fb = self._feedback.explanation_feedback(ans["explanation"])
        except Exception:
            fb = None
        if fb:
            model_ref = str(fb.get("model_ref") or model_ref)[:80]
            confidence = float(fb.get("confidence", confidence))
        outcome = "pass" if covered == total and total else ("partial" if covered else "fail")
        self._ledger.append("criterion_result", att.learner_id, dict(
            base, criterion_id=("crt_" + slug)[:36] + "_exp", task_id="tsk_" + slug, method="ai_judged",
            outcome=outcome, score=(covered / total) if total else 0.0, confidence=max(0.0, min(1.0, confidence)),
            ai_disclosure=True, model_ref=model_ref, submission_ref=_sha(ans["explanation"]),
            rationale=f"Explanation covered {covered} of {total} rubric points (recorded, not blocking).",
            flags=["low_confidence"] if confidence < 0.6 else [],
        ), f"{att.id}:{i['ref']}:exp")

    # ------------------------------------------------------------------ level 4
    def record_level4_result(self, attempt_id: str, evaluation: Mapping[str, Any]) -> dict:
        with self._lock:
            att = self._repo.get(attempt_id)
            if att is None or att.level != 4:
                raise R.NotFound("not found")
            if att.status in ("passed", "failed"):
                return dict(att.result or {})
            if att.status != "in_progress":
                raise R.Conflict("attempt not active", "attempt_not_active")
            if not isinstance(evaluation, Mapping) or not isinstance(evaluation.get("criteria"), list):
                raise R.InvalidInput("evaluation", "invalid_evaluation")
            verdict = R.qualify_l4(evaluation["criteria"], self.rules,
                                   bool(evaluation.get("needs_human_review")))
            meta = self._bank_meta_l4(att)
            base = self._base_event(att, meta)
            model_ref = str(evaluation.get("model_ref") or "unspecified")[:80]
            by_name = {c["criterion"]: c for c in evaluation["criteria"]}
            for name in R.L4_CRITERIA:
                c = by_name[name]
                s = verdict.scores[name]
                conf = c.get("confidence", evaluation.get("confidence", 0.5))
                conf = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else 0.5
                self._ledger.append("criterion_result", att.learner_id, dict(
                    base, criterion_id="crt_l4_" + name, task_id="tsk_l4_screening", method="live_screening",
                    outcome="pass" if s >= 2 else ("partial" if s == 1 else "fail"),
                    score=s / self.rules.l4_max_per, confidence=max(0.0, min(1.0, conf)), ai_disclosure=True,
                    model_ref=model_ref,
                    submission_ref=_sha(_canon({"criterion": name, "score": s, "rationale": str(c.get("rationale", ""))[:300]})),
                    rationale=str(c.get("rationale", ""))[:240],
                    flags=["low_confidence"] if conf < self.rules.l4_low_confidence else [],
                ), f"{att.id}:l4:{name}")
            outcome_base = dict(base, task_id="tsk_level_4_screening", method="live_screening", confidence=0.5,
                                ai_disclosure=True, model_ref=model_ref, score=verdict.total / (5 * self.rules.l4_max_per))
            if verdict.needs_review:
                self._ledger.append("level_outcome", att.learner_id, dict(
                    outcome_base, outcome="inconclusive", flags=["low_confidence"],
                    rationale="Low confidence or review flag; routed to human review."), f"{att.id}:level")
                result = {"outcome": "awaiting_review", "total": verdict.total, "score_update": "not_applicable"}
                att = att.with_(status="awaiting_review", result=result, finished_at=self._now())
                self._repo.update(att)
                return result
            self._ledger.append("level_outcome", att.learner_id, dict(
                outcome_base, outcome="pass" if verdict.passed else "fail",
                rationale=f"Rubric total {verdict.total}; qualify rule {'met' if verdict.passed else 'not met'}."),
                f"{att.id}:level")
            result = {"outcome": "passed" if verdict.passed else "failed", "total": verdict.total,
                      "criteria": [{"criterion": n, "score": verdict.scores[n]} for n in R.L4_CRITERIA],
                      "score_update": "not_applicable"}
            if verdict.passed:
                result["score_update"] = self._publish_score(att)
            att = att.with_(status="passed" if verdict.passed else "failed", result=result, finished_at=self._now())
            self._repo.update(att)
            return result

    def record_review_outcome(self, attempt_id: str, outcome: str) -> dict:
        with self._lock:
            att = self._repo.get(attempt_id)
            if att is None or att.status != "awaiting_review":
                raise R.NotFound("not found")
            if outcome not in ("pass", "fail"):
                raise R.InvalidInput("outcome")
            meta = self._bank_meta_l4(att)
            self._ledger.append("level_outcome", att.learner_id, dict(
                self._base_event(att, meta), task_id="tsk_level_4_screening", method="human_review",
                outcome=outcome, rationale="Human review decision on a flagged live screening."),
                f"{att.id}:review")
            result = dict(att.result or {}, outcome="passed" if outcome == "pass" else "failed")
            if outcome == "pass":
                result["score_update"] = self._publish_score(att)
            att = att.with_(status="passed" if outcome == "pass" else "failed", result=result)
            self._repo.update(att)
            return result

    def _bank_meta_l4(self, att: Attempt) -> Mapping[str, Any]:
        return {"version": "1.0.0", "rubric_id": "rbr_l4_screening"}

    def _publish_score(self, att: Attempt) -> str:
        try:
            applied = self._scoring.apply_gated_update(att.learner_id, self._competency(att))
        except Exception:
            log.exception("score_update_failed")
            return "withheld"
        return "applied" if applied else "withheld"

    # ------------------------------------------------------------------ solutions for L4
    def l3_solution(self, learner_id: str, track: Optional[str] = None) -> Optional[dict]:
        attempts = [a for a in self._repo.for_learner(learner_id, track, 3) if a.status == "passed"]
        if not attempts:
            return None
        att = attempts[-1]
        answers = self._repo.answers(att.id)
        graded = {}
        for p in att.plan:
            g = (answers.get(p["ref"]) or {}).get("graded")
            graded[p["ref"]] = bool(g) and g["total"] > 0 and g["passed"] == g["total"]
        for bank_id in dict.fromkeys(p["bank_id"] for p in att.plan):
            base_ref, mut_ref = planning.item_ref(bank_id, "base"), planning.item_ref(bank_id, "mutated")
            if graded.get(base_ref) and graded.get(mut_ref):
                item = self._bank.items(att.track, 3)
                it = next(x for x in item if x["id"] == bank_id)
                return {"task_id": bank_id, "code": answers[base_ref]["answer"],
                        "mutated_code": answers[mut_ref]["answer"], "title": it["title"],
                        "language": it["kind"], "track": att.track,
                        "base_prompt": it["stages"]["base"]["prompt"],
                        "mutated_prompt": it["stages"]["mutated"]["prompt"],
                        "competency_id": "cmp_" + self._competency(att), "seed_id": "sd_" + att.seed}
        return None

    # ------------------------------------------------------------------ progress
    def progress(self, learner_id: str, track: Optional[str]) -> dict:
        if track not in R.TRACKS:
            return {"track": None, "competency": None, "levels": [], "all_passed": False}
        attempts = self._repo.for_learner(learner_id, track)
        levels = []
        previous_passed = True
        for level in (1, 2, 3, 4):
            same = [a for a in attempts if a.level == level]
            open_ = [a for a in same if a.status in R.OPEN_STATUSES]
            if any(a.status == "passed" for a in same):
                status = "passed"
            elif any(a.status == "awaiting_review" for a in same):
                status = "awaiting_review"
            elif not previous_passed:
                status = "locked"
            elif open_:
                status = "in_progress"
            else:
                status = "available"
            levels.append({
                "level": level, "name": R.LEVEL_NAMES[level], "status": status, "attempts": len(same),
                "open_attempt_id": open_[-1].id if open_ else None,
                "history": [{"attempt_no": a.attempt_no, "status": a.status, "finished_at": a.finished_at}
                            for a in same]})
            previous_passed = status == "passed"
        return {"track": track, "competency": self._competency(track), "levels": levels,
                "all_passed": all(lv["status"] == "passed" for lv in levels)}

    # ------------------------------------------------------------------ integrity pass-through
    def ingest_events(self, attempt_id: str, learner_id: str, events: Any) -> int:
        if not isinstance(events, list) or len(events) > MAX_EVENTS:
            raise R.InvalidInput("events")
        clean = []
        for e in events:
            if not isinstance(e, Mapping) or e.get("type") not in EVENT_TYPES:
                raise R.InvalidInput("event")
            t = e.get("t_ms", e.get("t"))
            if isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 <= t <= 1e12:
                raise R.InvalidInput("event")
            item_id = e.get("item_id")
            if item_id is not None and (not isinstance(item_id, str) or len(item_id) > 64):
                raise R.InvalidInput("event")
            detail = e.get("detail")
            if detail is not None and (not isinstance(detail, Mapping) or len(_canon(detail)) > 500):
                raise R.InvalidInput("event")
            clean.append({"type": e["type"], "t_ms": float(t), "item_id": item_id, "detail": dict(detail or {})})
        att = self._owned(attempt_id, learner_id)
        self._check_active(att)
        try:
            self._integrity.ingest_events(att.id, learner_id, clean)
        except Exception:
            log.exception("event_ingest_failed")
            raise R.Unavailable("could not store events")
        return len(clean)

    def store_chunk(self, attempt_id: str, learner_id: str, stream: Any, seq: Any, data: bytes) -> Any:
        if stream not in STREAMS or isinstance(seq, bool) or not isinstance(seq, int) or not 0 <= seq <= 100000:
            raise R.InvalidInput("chunk")
        if not data or len(data) > MAX_CHUNK_BYTES:
            raise R.InvalidInput("chunk")
        att = self._owned(attempt_id, learner_id)
        self._check_active(att)
        try:
            return self._integrity.store_chunk(att.id, learner_id, stream, seq, data)
        except Exception:
            log.exception("chunk_store_failed")
            raise R.Unavailable("could not store chunk")

    def finalize_recording(self, attempt_id: str, learner_id: str) -> dict:
        att = self._owned(attempt_id, learner_id)
        try:
            manifest = dict(self._integrity.finalize_recording(att.id, learner_id))
        except Exception:
            log.exception("recording_finalize_failed")
            raise R.Unavailable("could not finalise recording")
        digest = manifest.get("manifest_hash")
        if digest:
            self._ledger.append("integrity_flag", att.learner_id, {
                "competency_id": "cmp_" + self._competency(att), "level": att.level, "method": "deterministic_test",
                "outcome": "inconclusive", "seed_id": "sd_" + att.seed,
                "meta": {"kind": "recording_manifest", "attempt": att.id, "manifest_hash": digest,
                         "chunks": manifest.get("chunks", 0)}}, f"{att.id}:recording")
        return {"manifest_hash": digest, "chunks": manifest.get("chunks", 0)}
