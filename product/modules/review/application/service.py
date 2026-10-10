"""Review use cases: queue, decisions, appeals, share grants, shared-evidence query."""
from __future__ import annotations

import base64
import logging
import re
from datetime import datetime, timezone
from typing import Protocol

from ..domain import rules
from .ports import (AssessmentPort, Clock, DocStore, EvidencePort, IdentityPort, Ids, IntegrityPort,
                    ScoringPort)

log = logging.getLogger("review")
REVIEW_DESK = "org_review_desk"
_ATTEMPT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ITEM_TYPES = ("criterion_result", "probe_result", "level_outcome", "review_decision")
_CONTEXT_KEYS = ("competency_id", "level", "task_id", "task_version", "rubric_id", "rubric_version", "seed_id")


class ReviewError(Exception):
    code = "error"

    def __init__(self, code: str | None = None):
        super().__init__(code or self.code)
        if code:
            self.code = code


class NotFound(ReviewError):
    code = "not_found"


class Conflict(ReviewError):
    code = "already_decided"


class Invalid(ReviewError):
    code = "invalid"


class Unavailable(ReviewError):
    code = "unavailable"


class QueryError(ReviewError):
    code = "invalid_request"


class Contracts(Protocol):
    def is_valid(self, name: str, doc: dict) -> bool: ...


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


class ReviewService:
    def __init__(self, store: DocStore, identity: IdentityPort, evidence: EvidencePort, scoring: ScoringPort,
                 integrity: IntegrityPort, assessment: AssessmentPort, clock: Clock, ids: Ids, contracts: Contracts):
        self.s, self.identity, self.evidence, self.scoring = store, identity, evidence, scoring
        self.integrity, self.assessment, self.clock, self.ids, self.contracts = integrity, assessment, clock, ids, contracts

    # ------------------------------------------------------------ queue
    def enqueue_case(self, attempt_id, learner_id, reason, uncertainty, integrity_risk, summary, context) -> str:
        if reason not in rules.REASONS or integrity_risk not in rules.RISK_RANK:
            raise Invalid("invalid_case")
        if not 0 <= float(uncertainty) <= 1:
            raise Invalid("invalid_case")
        case_id = self.ids.new_id()
        if not self.s.put_if_absent("case_index", f"{attempt_id}:{reason}", {"case_id": case_id}):
            return self.s.get("case_index", f"{attempt_id}:{reason}")["case_id"]
        self.s.put("cases", case_id, {
            "case_id": case_id, "attempt_id": attempt_id, "learner_id": learner_id, "reason": reason,
            "uncertainty": float(uncertainty), "integrity_risk": integrity_risk, "summary": summary,
            "context": context, "status": "open", "created_at": _iso(self.clock.now()),
        })
        log.info("review_case_enqueued", extra={"case_id": case_id, "reason": reason})
        return case_id

    def _alias_for(self, learner_id: str, recipient_id: str = "internal_review") -> str:
        try:
            return self.identity.alias_for(learner_id, recipient_id)
        except TypeError:
            return self.identity.alias_for(learner_id) or f"cnd_{learner_id[:16]}"

    def _queue_row(self, c: dict) -> dict:
        return {
            "case_id": c["case_id"], "alias": self._alias_for(c["learner_id"], "internal_review"),
            "reason": c["reason"], "uncertainty": c["uncertainty"],
            "confidence_label": "Low" if c["uncertainty"] >= 0.5 else "Moderate",
            "integrity_risk": c["integrity_risk"], "created_at": c["created_at"], "status": c["status"],
            "level": c.get("context", {}).get("level"),
        }

    def list_queue(self, reason: str | None, limit: int, offset: int) -> list[dict]:
        if reason is not None and reason not in rules.REASONS:
            raise Invalid("invalid_filter")
        cases = [c for c in self.s.all("cases") if c["status"] == "open" and (reason is None or c["reason"] == reason)]
        cases.sort(key=rules.queue_key)
        return [self._queue_row(c) for c in cases[offset:offset + limit]]

    def case_detail(self, case_id: str) -> dict:
        c = self.s.get("cases", case_id)
        if c is None:
            raise NotFound()
        out = self._queue_row(c)
        ctx = c.get("context", {})
        out["context"] = {k: ctx.get(k) for k in ("competency_id", "level", "task_version", "rubric_version", "kind")}
        out["summary"] = c["summary"]
        out["integrity"] = None
        out["recordings"] = []
        if _ATTEMPT_RE.match(c["attempt_id"] or ""):
            out["integrity"] = self.integrity.summary(c["attempt_id"])
            out["recordings"] = [s for s in rules.RECORDING_STREAMS
                                 if self.integrity.recording_info(c["attempt_id"], s)]
        d = self.s.get("decisions", case_id)
        out["decision"] = {k: d[k] for k in ("decision", "outcome", "reason", "ledger_entry")} if d and d["status"] == "recorded" else None
        out["note"] = "A flag does not change the result. Decide only on the rubric."
        return out

    # ------------------------------------------------------------ decisions
    def decide(self, case_id, reviewer_id, outcome, new_outcome, reason) -> dict:
        c = self.s.get("cases", case_id)
        if c is None:
            raise NotFound()
        reason = (reason or "").strip()
        if not 3 <= len(reason) <= 1000:
            raise Invalid("invalid_reason")
        existing = self.s.get("decisions", case_id)
        if existing and existing["status"] == "recorded":
            raise Conflict()
        if existing is None:
            resolved = rules.resolve_decision(outcome, new_outcome, c.get("context", {}).get("original_outcome", "inconclusive"))
            if resolved is None:
                raise Invalid("invalid_decision")
            decision, final = resolved
            doc = {"case_id": case_id, "decision": decision, "outcome": final, "reason": reason,
                   "reviewer": reviewer_id, "status": "pending", "created_at": _iso(self.clock.now())}
            if not self.s.put_if_absent("decisions", case_id, doc):
                existing = self.s.get("decisions", case_id)
                if existing["status"] == "recorded":
                    raise Conflict()
                doc = existing
        else:
            doc = existing  # retry of a decision whose ledger/assessment write failed
        ctx = c.get("context", {})
        event = {
            "schema_version": "0.1", "idempotency_key": f"review-decision-{case_id}", "source_system": "trust",
            "event_type": "review_decision", "learner_id": c["learner_id"], "method": "human_review",
            "outcome": doc["outcome"], "rationale": doc["reason"], "occurred_at": doc["created_at"],
        }
        event.update({k: ctx.get(k) for k in _CONTEXT_KEYS})
        if ctx.get("criterion_id"):
            event["criterion_id"] = ctx["criterion_id"]
        if not self.contracts.is_valid("evidence-event.schema.json", event):
            log.error("review_event_invalid", extra={"case_id": case_id})
            raise Invalid("case_context_incomplete")
        try:
            receipt = self.evidence.append(event)
            if ctx.get("kind") == "interview_l4" and doc["decision"] != "needs_more_info":
                self.assessment.record_level4_result(c["attempt_id"], {
                    "status": "final", "source": "human_review", "passed": doc["outcome"] == "pass",
                    "decision": doc["decision"], "ledger_entry": receipt["sequence"]})
        except Exception:
            log.warning("review_decision_pending", extra={"case_id": case_id})
            raise Unavailable("not_recorded") from None
        doc = {**doc, "status": "recorded", "ledger_entry": receipt["sequence"]}
        self.s.put("decisions", case_id, doc)
        self.s.put("cases", case_id, {**c, "status": "decided"})
        return {"case_id": case_id, "decision": doc["decision"], "outcome": doc["outcome"],
                "ledger_entry": receipt["sequence"]}

    # ------------------------------------------------------------ appeals
    def file_appeal(self, learner_id: str, event_id: str, reason: str) -> dict:
        reason = (reason or "").strip()
        if not 10 <= len(reason) <= 1000:
            raise Invalid("invalid_reason")
        ev = next((e for e in self.evidence.list_for_learner(learner_id) if e.get("event_id") == event_id), None)
        if ev is None:
            raise NotFound()
        for a in self.s.all("appeals"):
            if a["learner_id"] == learner_id and a["event_id"] == event_id and self._appeal_status(a) == "open":
                return self._appeal_view(a)
        appeal_id = self.ids.new_id()
        now = _iso(self.clock.now())
        ctx = {k: ev.get(k) for k in _CONTEXT_KEYS}
        ctx.update({"kind": "appeal", "original_outcome": ev.get("outcome"), "criterion_id": ev.get("criterion_id")})
        filed = {
            "schema_version": "0.1", "idempotency_key": f"appeal-filed-{appeal_id}", "source_system": "trust",
            "event_type": "appeal_filed", "learner_id": learner_id, "method": "human_review",
            "outcome": "inconclusive", "occurred_at": now, **{k: ctx[k] for k in _CONTEXT_KEYS},
        }
        if ev.get("criterion_id"):
            filed["criterion_id"] = ev["criterion_id"]
        if not self.contracts.is_valid("evidence-event.schema.json", filed):
            raise Invalid("appeal_context_incomplete")
        try:
            self.evidence.append(filed)
        except Exception:
            raise Unavailable("not_recorded") from None
        case_id = self.enqueue_case(f"event-{event_id}", learner_id, "appeal", 0.9, "low",
                                    {"event_id": event_id, "appeal_reason": reason, "method": ev.get("method"),
                                     "original_outcome": ev.get("outcome")}, ctx)
        a = {"appeal_id": appeal_id, "learner_id": learner_id, "event_id": event_id, "case_id": case_id,
             "created_at": now}
        self.s.put("appeals", appeal_id, a)
        return self._appeal_view(a)

    def _appeal_status(self, a: dict) -> str:
        c = self.s.get("cases", a["case_id"])
        return "decided" if c and c["status"] == "decided" else "open"

    def _appeal_view(self, a: dict) -> dict:
        out = {"appeal_id": a["appeal_id"], "event_id": a["event_id"], "created_at": a["created_at"],
               "status": self._appeal_status(a)}
        d = self.s.get("decisions", a["case_id"])
        if d and d["status"] == "recorded":
            out["outcome"] = d["outcome"]
        return out

    def list_appeals(self, learner_id: str) -> list[dict]:
        mine = [a for a in self.s.all("appeals") if a["learner_id"] == learner_id]
        mine.sort(key=lambda a: (a["created_at"], a["appeal_id"]))
        return [self._appeal_view(a) for a in mine]

    # ------------------------------------------------------------ grants
    def create_grant(self, learner_id, recipient_id, competencies, include, role_ref, expires_at: datetime,
                     consent_text_version) -> dict:
        now = self.clock.now()
        include = list(include) if include is not None else rules.default_scope()
        problem = rules.scope_problem(include) or rules.expiry_problem(expires_at, now)
        if problem:
            raise Invalid(problem)
        grant = {
            "schema_version": "0.1", "learner_id": learner_id, "recipient_id": recipient_id,
            "competencies": list(competencies), "scope": {"include": include}, "created_at": _iso(now),
            "expires_at": _iso(expires_at), "revoked_at": None, "consent_text_version": consent_text_version,
        }
        if role_ref:
            grant["role_ref"] = role_ref
        if not self.contracts.is_valid("share-grant.schema.json", grant):
            raise Invalid("invalid_grant")
        grant["grant_id"] = self.ids.new_id()
        self.s.put("grants", grant["grant_id"], grant)
        log.info("share_grant_created", extra={"grant_id": grant["grant_id"]})
        return {**grant, "status": "active"}

    def list_grants(self, learner_id: str) -> list[dict]:
        now = self.clock.now()
        gs = [g for g in self.s.all("grants") if g["learner_id"] == learner_id]
        gs.sort(key=lambda g: (g["created_at"], g["grant_id"]))
        return [{**g, "status": rules.grant_status(g, now)} for g in gs]

    def revoke_grant(self, learner_id: str, grant_id: str) -> None:
        g = self.s.get("grants", grant_id)
        if g is None or g["learner_id"] != learner_id:
            raise NotFound()
        if not g.get("revoked_at"):
            g["revoked_at"] = _iso(self.clock.now())
            self.s.put("grants", grant_id, g)
            log.info("share_grant_revoked", extra={"grant_id": grant_id})

    # ------------------------------------------------------------ shared evidence
    def query_shared_evidence(self, request: dict, caller_recipient_id: str) -> dict:
        if not isinstance(request, dict) or not self.contracts.is_valid("shared-evidence-query-request.schema.json", request):
            raise QueryError("invalid_request")
        if request["recipient_id"] != caller_recipient_id:
            raise QueryError("recipient_mismatch")
        page = request.get("page", {})
        limit = page.get("limit", 25)
        offset = 0
        if page.get("cursor"):
            try:
                offset = int(base64.urlsafe_b64decode(page["cursor"].encode()).decode())
                if offset < 0:
                    raise ValueError
            except (ValueError, UnicodeDecodeError):
                raise QueryError("invalid_cursor") from None
        now = self.clock.now()
        refs = set(request.get("candidate_refs", []))
        wanted = set(request["competency_ids"])
        # latest active grant per (learner, competency)
        chosen: dict[tuple[str, str], dict] = {}
        for g in self.s.all("grants"):
            if g["recipient_id"] != request["recipient_id"] or rules.grant_status(g, now) != "active":
                continue
            if g.get("role_ref") and g["role_ref"] != request["role_id"]:
                continue
            for cmp_id in set(g["competencies"]) & wanted:
                k = (g["learner_id"], cmp_id)
                if k not in chosen or g["created_at"] > chosen[k]["created_at"]:
                    chosen[k] = g
        built: list[tuple[str, str, dict, str]] = []
        head = self.evidence.head()
        for (learner, cmp_id), g in chosen.items():
            alias = self._alias_for(learner, request["recipient_id"])
            if refs and alias not in refs:
                continue
            item = self._shared_item(learner, alias, cmp_id, g, head)
            if item is not None:
                built.append((alias, cmp_id, item, learner))
        built.sort(key=lambda t: (t[0], t[1]))
        window = built[offset:offset + limit]
        nxt = base64.urlsafe_b64encode(str(offset + limit).encode()).decode() if offset + limit < len(built) else None
        for alias, cmp_id, _, learner in window:
            self.s.put("access_log", self.ids.new_id(), {
                "request_id": request["request_id"], "recipient_id": request["recipient_id"],
                "learner_id": learner, "competency_id": cmp_id, "at": _iso(now)})
        log.info("shared_evidence_queried", extra={"recipient": request["recipient_id"], "returned": len(window)})
        return {
            "schema_version": "0.1", "request_id": request["request_id"], "recipient_id": request["recipient_id"],
            "as_of": _iso(now), "results": [w[2] for w in window],
            "page": {"returned": len(window), "next_cursor": nxt},
            "ledger_head": {"sequence": head["sequence"], "hash": head["hash"]},
        }

    def _shared_item(self, learner: str, alias: str, cmp_id: str, grant: dict, head: dict) -> dict | None:
        # scoring's competency names may be bare ("python") in production, or prefixed ("cmp_python") in test fakes
        scoring_competency = cmp_id[4:] if cmp_id.startswith("cmp_") else cmp_id
        est = self.scoring.competency_estimate(learner, cmp_id) or self.scoring.competency_estimate(learner, scoring_competency)
        if not est:
            return None
        events = [e for e in self.evidence.list_for_learner(learner)
                  if e.get("competency_id") == cmp_id and e.get("event_type") in _ITEM_TYPES
                  and e.get("event_id") and e.get("ledger")]
        if not events:
            return None
        events.sort(key=lambda e: e["occurred_at"])
        items, counts, ai_used = [], {m: 0 for m in ("deterministic_test", "probe", "ai_judged", "live_screening", "human_review")}, False
        levels: set[int] = set()
        understanding = "not_attempted"
        for e in events:
            if e["method"] not in counts:
                continue
            counts[e["method"]] += 1
            it = {"event_id": e["event_id"], "method": e["method"], "outcome": e["outcome"],
                  "occurred_at": e["occurred_at"], "task_version": e["task_version"],
                  "rubric_version": e["rubric_version"], "receipt_hash": e["ledger"]["hash"]}
            if e.get("criterion_id"):
                it["criterion_id"] = e["criterion_id"]
            if e.get("understanding_status"):
                it["understanding_status"] = e["understanding_status"]
            if "ai_disclosure" in e:
                it["ai_disclosure"] = bool(e["ai_disclosure"])
                ai_used = ai_used or bool(e["ai_disclosure"])
            items.append(it)
            # a reviewer decision on a whole-level case (no criterion) settles that level's outcome
            level_event = e["event_type"] == "level_outcome" or (
                e["event_type"] == "review_decision" and not e.get("criterion_id"))
            if level_event and e["outcome"] == "pass":
                levels.add(int(e["level"]))
            if e["event_type"] == "probe_result" and e.get("understanding_status"):
                understanding = e["understanding_status"]
        seq = head["sequence"] if head["sequence"] >= 1 and head["hash"] != "genesis" else max(e["ledger"]["sequence"] for e in events)
        hh = head["hash"] if head["hash"] != "genesis" else next(e["ledger"]["hash"] for e in events if e["ledger"]["sequence"] == seq)
        doc = {
            "schema_version": "0.1", "candidate_ref": alias, "grant_id": grant["grant_id"], "competency_id": cmp_id,
            "proficiency": {"estimate": est["estimate"], "lower": est["lower"], "upper": est["upper"],
                            "scale": "0-1", "as_of": est["as_of"]},
            "levels_passed": sorted(levels), "method_counts": counts, "understanding_status": understanding,
            "evidence_items": items, "last_evidence_at": events[-1]["occurred_at"],
            "ledger_proof": {"head_hash": hh, "head_sequence": seq},
            "labels": {"experimental": True, "ai_used": ai_used},
        }
        if not self.contracts.is_valid("shared-evidence.schema.json", doc):
            log.error("shared_evidence_invalid", extra={"competency": cmp_id})
            return None
        return doc

    # ------------------------------------------------------------ recordings
    def recording_info(self, attempt_id: str, stream: str) -> dict:
        if not _ATTEMPT_RE.match(attempt_id) or stream not in rules.RECORDING_STREAMS:
            raise NotFound()
        info = self.integrity.recording_info(attempt_id, stream)
        if not info:
            raise NotFound()
        return info

    def read_recording(self, attempt_id: str, stream: str, start: int, end: int) -> bytes:
        return self.integrity.read_recording(attempt_id, stream, start, end)
