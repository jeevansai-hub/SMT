"""L4 interview use cases: session state machine, adaptive follow-up, evaluation hand-off."""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from dataclasses import asdict

from ..domain import solution_features as sf
from .ports import (AssessmentPort, Clock, DocStore, EvidencePort, IntegrityPort, IntelligencePort, ReviewPort)

log = logging.getLogger("interview")
RUBRIC_VERSION = "1.0.0"
MAX_ANSWER = 4000
CONFIDENCE_FLOOR = 0.6
TASK_ID, RUBRIC_ID, TASK_VERSION = "tsk_l4_screening", "rbr_l4_screening", "1.0.0"
LABEL = "AI-assisted feedback"


class InterviewError(Exception):
    code = "error"

    def __init__(self, code: str | None = None):
        super().__init__(code or self.code)
        if code:
            self.code = code


class NotFound(InterviewError):
    code = "not_found"


class Conflict(InterviewError):
    code = "session_not_started"


class Invalid(InterviewError):
    code = "invalid_answer"


class Unavailable(InterviewError):
    code = "unavailable"


def _outcome(score: int) -> str:
    return "fail" if score == 0 else "partial" if score == 1 else "pass"


class InterviewService:
    def __init__(self, store: DocStore, assessment: AssessmentPort, intelligence: IntelligencePort,
                 evidence: EvidencePort, review: ReviewPort, integrity: IntegrityPort | None, clock: Clock):
        self.s, self.assessment, self.intel = store, assessment, intelligence
        self.evidence, self.review, self.integrity, self.clock = evidence, review, integrity, clock
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    # ------------------------------------------------------------- views
    def _key(self, learner_id: str, attempt_id: str) -> str:
        return f"{attempt_id}"

    def _get_l3_solution(self, attempt_id: str, learner_id: str) -> dict | None:
        try:
            return self.assessment.l3_solution(attempt_id, learner_id)
        except TypeError:
            return self.assessment.l3_solution(learner_id)

    def state(self, learner_id: str, attempt_id: str) -> dict:
        sess = self.s.get("sessions", attempt_id)
        if sess is None:
            if self._get_l3_solution(attempt_id, learner_id) is None:
                raise NotFound()
            return {"state": "not_started", "prompt_count": len(sf.CRITERIA)}
        if sess["learner_id"] != learner_id:
            raise NotFound()
        return self._view(sess)

    def _view(self, sess: dict) -> dict:
        if sess["state"] in ("completed", "pending_review") and sess.get("summary"):
            return sess["summary"]
        if sess["state"] == "finalizing":
            return {"state": "finalizing", "prompt_count": len(sess["prompts"])}
        cur = sess["current"]
        return {"state": "in_progress", "criterion": cur["criterion"], "kind": cur["kind"], "prompt": cur["text"],
                "prompt_index": sess["index"] + 1, "prompt_count": len(sess["prompts"])}

    # ------------------------------------------------------------- turn
    def turn(self, learner_id: str, attempt_id: str, answer: str | None) -> dict:
        with self._lock(attempt_id):
            sess = self.s.get("sessions", attempt_id)
            if sess is None:
                sol = self._get_l3_solution(attempt_id, learner_id)
                if sol is None:
                    raise NotFound()
                if answer is not None and answer.strip():
                    raise Conflict()
                prompts = sf.build_prompts(sf.analyse(sol.get("code", "")))
                sess = {"attempt_id": attempt_id, "learner_id": learner_id, "state": "in_progress", "index": 0,
                        "follow_up_used": False, "prompts": [asdict(p) | {"keywords": list(p.keywords)} for p in prompts],
                        "current": {"criterion": prompts[0].criterion, "text": prompts[0].text, "kind": "prompt"},
                        "turns": [{"role": "interviewer", "criterion": prompts[0].criterion, "text": prompts[0].text}],
                        "evaluation": None, "steps": {"events": [], "result": False, "case_id": None},
                        "summary": None, "started_at": self.clock.now().isoformat()}
                self.s.put("sessions", attempt_id, sess)
                return self._view(sess)
            if sess["learner_id"] != learner_id:
                raise NotFound()
            if sess["state"] in ("completed", "pending_review"):
                return sess["summary"]
            if sess["state"] == "finalizing":
                return self._finalize(sess)
            text = (answer or "").strip()
            if not text or len(text) > MAX_ANSWER:
                raise Invalid()
            cur = sess["current"]
            sess["turns"].append({"role": "learner", "criterion": cur["criterion"], "text": text})
            prompt = sess["prompts"][sess["index"]]
            follow = (cur["kind"] == "prompt" and not sess["follow_up_used"]
                      and sf.needs_follow_up(text, sf.Prompt(prompt["criterion"], prompt["text"],
                                                             tuple(prompt["keywords"]), prompt["follow_up"])))
            if follow:
                sess["follow_up_used"] = True
                sess["current"] = {"criterion": cur["criterion"], "text": prompt["follow_up"], "kind": "follow_up"}
                sess["turns"].append({"role": "interviewer", "criterion": cur["criterion"], "text": prompt["follow_up"]})
                self.s.put("sessions", attempt_id, sess)
                return self._view(sess)
            sess["index"] += 1
            sess["follow_up_used"] = False
            if sess["index"] < len(sess["prompts"]):
                nxt = sess["prompts"][sess["index"]]
                sess["current"] = {"criterion": nxt["criterion"], "text": nxt["text"], "kind": "prompt"}
                sess["turns"].append({"role": "interviewer", "criterion": nxt["criterion"], "text": nxt["text"]})
                self.s.put("sessions", attempt_id, sess)
                return self._view(sess)
            sess["state"] = "finalizing"
            self.s.put("sessions", attempt_id, sess)
            return self._finalize(sess)

    # ------------------------------------------------------------- finish
    def _finalize(self, sess: dict) -> dict:
        attempt_id, learner_id = sess["attempt_id"], sess["learner_id"]
        sol = self._get_l3_solution(attempt_id, learner_id)
        if sol is None:
            raise Unavailable("not_recorded")
        transcript = [{"role": t["role"], "criterion": t["criterion"], "text": t["text"]} for t in sess["turns"]]
        if sess["evaluation"] is None:
            try:
                ev_raw = self.intel.evaluate_interview(transcript, sol.get("code", ""), RUBRIC_VERSION)
                sess["evaluation"] = ev_raw.to_dict() if hasattr(ev_raw, "to_dict") else ev_raw
            except Exception:
                log.warning("interview_evaluation_failed", extra={"attempt_id": attempt_id})
                raise Unavailable("not_recorded") from None
            risk = "low"
            if self.integrity is not None:
                try:
                    risk = (self.integrity.summary(attempt_id) or {}).get("risk", "low")
                except Exception:
                    risk = "low"
            sess["risk"] = risk if risk in ("low", "medium", "high") else "low"
            self.s.put("sessions", attempt_id, sess)
        ev, risk = sess["evaluation"], sess["risk"]
        unavailable = ev.get("status") != "evaluated"
        low_conf = bool(ev.get("needs_human_review")) or unavailable
        pending = low_conf or risk == "high"
        crit = ev["criteria"]
        if pending:
            outcome = "inconclusive"
        else:
            outcome = "pass" if ev["passed"] else "fail"
        ctx = {"competency_id": sol.get("competency_id"), "level": 4, "task_id": TASK_ID, "task_version": TASK_VERSION,
               "rubric_id": RUBRIC_ID, "rubric_version": ev["rubric_version"], "seed_id": sol.get("seed_id"),
               "kind": "interview_l4",
               "original_outcome": "inconclusive" if unavailable else ("pass" if ev["passed"] else "fail")}
        try:
            if pending and sess["steps"]["case_id"] is None:
                min_conf = min((c["confidence"] for c in crit), default=0.0)
                sess["steps"]["case_id"] = self.review.enqueue_case(
                    attempt_id=attempt_id, learner_id=learner_id,
                    reason="low_confidence" if low_conf else "integrity_review",
                    uncertainty=1.0 if unavailable else (round(1 - min_conf, 3) if low_conf else 0.3),
                    integrity_risk=risk,
                    summary={"criteria": crit, "total": ev["total"], "passed": ev["passed"], "model_ref": ev["model_ref"],
                             "rubric_version": ev["rubric_version"], "ai_disclosure": True, "status": ev.get("status"),
                             "injection_events": ev.get("events", []), "transcript": transcript},
                    context=ctx)
                self.s.put("sessions", attempt_id, sess)
            self._append_events(sess, sol, ev, outcome, transcript)
            if not sess["steps"]["result"]:
                self.assessment.record_level4_result(attempt_id, {
                    "status": "pending_review" if pending else "final",
                    "passed": None if pending else bool(ev["passed"]), "total": ev["total"],
                    "criteria": [{"criterion": "adapt_constraint" if c["criterion"] == "adapt" else c["criterion"],
                                  "score0to3": c["score0to3"], "confidence": c["confidence"]} for c in crit],
                    "rubric_version": ev["rubric_version"], "model_ref": ev["model_ref"], "ai_disclosure": True,
                    "case_id": sess["steps"]["case_id"]})
                sess["steps"]["result"] = True
                self.s.put("sessions", attempt_id, sess)
        except Unavailable:
            raise
        except Exception:
            log.warning("interview_finalize_incomplete", extra={"attempt_id": attempt_id})
            raise Unavailable("not_recorded") from None
        sess["state"] = "pending_review" if pending else "completed"
        sess["summary"] = {
            "state": sess["state"], "pending_review": pending, "passed": None if pending else bool(ev["passed"]),
            "total": ev["total"], "max_total": 3 * len(crit),
            "criteria": [{"criterion": c["criterion"], "score0to3": c["score0to3"], "rationale": c["rationale"],
                          "confidence": c["confidence"]} for c in crit],
            "ai_disclosure": True, "label": LABEL, "model_ref": ev["model_ref"], "rubric_version": ev["rubric_version"],
            "message": ("A human reviewer will confirm this result. You can appeal any result." if pending
                        else "This feedback is AI-assisted. You can appeal any result."),
        }
        self.s.put("sessions", attempt_id, sess)
        return sess["summary"]

    def _append_events(self, sess: dict, sol: dict, ev: dict, level_outcome: str, transcript: list) -> None:
        now = self.clock.now().strftime("%Y-%m-%dT%H:%M:%SZ")
        ref = "sha256:" + hashlib.sha256(json.dumps(transcript, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        injected = {e.get("criterion") for e in ev.get("events", []) if e.get("type") == "injection_attempt"}
        base = {
            "schema_version": "0.1", "source_system": "sandbox", "learner_id": sess["learner_id"],
            "competency_id": sol.get("competency_id"), "level": 4, "method": "live_screening",
            "task_id": TASK_ID, "task_version": TASK_VERSION, "rubric_id": RUBRIC_ID,
            "rubric_version": ev["rubric_version"], "seed_id": sol.get("seed_id"), "occurred_at": now,
            "ai_disclosure": True, "model_ref": str(ev["model_ref"])[:80],
        }
        attempt = sess["attempt_id"]
        todo = []
        for c in ev["criteria"]:
            name = c["criterion"]
            flags = [f for f, on in (("low_confidence", c["confidence"] < CONFIDENCE_FLOOR),
                                     ("injection_attempt", name in injected)) if on]
            e = {**base, "idempotency_key": f"interview-l4-{attempt}-{name}", "event_type": "criterion_result",
                 "criterion_id": f"crt_l4_{name}", "outcome": _outcome(c["score0to3"]),
                 "score": round(c["score0to3"] / 3, 3), "confidence": round(float(c["confidence"]), 3),
                 "submission_ref": ref, "rationale": str(c["rationale"])[:1000]}
            if flags:
                e["flags"] = flags
            todo.append(e)
        todo.append({**base, "idempotency_key": f"interview-l4-{attempt}-level", "event_type": "level_outcome",
                     "outcome": level_outcome, "confidence": round(min((c["confidence"] for c in ev["criteria"]), default=0.0), 3),
                     "submission_ref": ref})
        done = set(sess["steps"]["events"])
        for e in todo:
            if e["idempotency_key"] in done:
                continue
            try:
                self.evidence.append(e)  # idempotent on idempotency_key
            except TypeError:
                payload = {k: v for k, v in e.items()
                           if k not in ("schema_version", "event_type", "learner_id", "idempotency_key")}
                self.evidence.append(e["event_type"], e["learner_id"], payload, e["idempotency_key"])
            done.add(e["idempotency_key"])
            sess["steps"]["events"] = sorted(done)
            self.s.put("sessions", sess["attempt_id"], sess)
