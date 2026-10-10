"""Shared fixtures: real identity/evidence/scoring/assessment, fake runner and integrity (stream B)."""
import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import assessment.api as assessment
import evidence.api as evidence
import identity.api as identity
import scoring.api as scoring

HERE = Path(__file__).resolve().parent
BANK = HERE.parent / "bank"
REFS = json.loads((HERE / "reference_solutions.json").read_text(encoding="utf-8"))
PW = "correct-horse-battery"


# ------------------------------------------------------------------ fake runner (spec = runner module's)
@dataclass
class _T:
    id: str
    passed: bool
    message_safe: str = ""


@dataclass
class _R:
    run_id: str
    status: str
    tests: tuple = ()
    stdout_trunc: str = ""
    isolation_mode: str = "container"
    reason: str = ""


class FakeRunner:
    def __init__(self):
        self.specs = {}
        self.calls = []
        self.unavailable = False

    def register_task(self, task_id, kind, spec_json):
        self.specs[task_id] = (kind, json.loads(spec_json) if isinstance(spec_json, str) else spec_json)

    def _dataset(self, task_id, dataset_id):
        kind, spec = self.specs[task_id]
        return kind, spec, spec["datasets"][dataset_id]

    def run_python(self, run_id, task_id, dataset_id, limits_profile, submission):
        self.calls.append(("python", task_id, dataset_id, limits_profile))
        if self.unavailable:
            return _R(run_id, "runner_unavailable")
        _, spec, ds = self._dataset(task_id, dataset_id)
        ns = {}
        try:
            exec(compile(submission, "<submission>", "exec"), ns)
            fn = ns[spec["function"]]
        except Exception:
            return _R(run_id, "error")
        outcomes = []
        for t in ds["tests"]:
            try:
                got = json.loads(json.dumps(fn(*json.loads(json.dumps(t["args"])))))
                outcomes.append(_T(t["id"], got == t["expected"]))
            except Exception:
                outcomes.append(_T(t["id"], False, "raised"))
        return _R(run_id, "passed" if all(o.passed for o in outcomes) else "failed_tests", tuple(outcomes))

    def run_sql(self, run_id, task_id, dataset_id, limits_profile, submission):
        self.calls.append(("sql", task_id, dataset_id, limits_profile))
        if self.unavailable:
            return _R(run_id, "runner_unavailable")
        _, spec, ds = self._dataset(task_id, dataset_id)
        outcomes = []
        for t in ds["tests"]:
            setup = t.get("setup_sql", ds.get("setup_sql", spec.get("setup_sql", "")))
            try:
                con = sqlite3.connect(":memory:")
                con.executescript(setup)
                exp = [list(r) for r in con.execute(t["expected_query"]).fetchall()]
                got = [list(r) for r in con.execute(submission).fetchall()]
                if t.get("ordered"):
                    ok = json.dumps(got) == json.dumps(exp)
                else:
                    ok = sorted(map(json.dumps, got)) == sorted(map(json.dumps, exp))
                outcomes.append(_T(t["id"], ok))
            except Exception:
                outcomes.append(_T(t["id"], False, "error"))
        return _R(run_id, "passed" if all(o.passed for o in outcomes) else "failed_tests", tuple(outcomes))


class FakeIntegrity:
    def __init__(self):
        self.consents = []
        self.events = []
        self.chunks = []
        self.fingerprints = []
        self.finalized = []

    def record_consent(self, attempt_id, learner_id, version, scopes):
        self.consents.append((attempt_id, learner_id, version, tuple(scopes)))

    def ingest_events(self, attempt_id, learner_id, events):
        self.events.append((attempt_id, learner_id, list(events)))

    def store_chunk(self, attempt_id, learner_id, stream, seq, data):
        self.chunks.append((attempt_id, learner_id, stream, seq, len(data)))
        return {"seq": seq}

    def finalize_recording(self, attempt_id, learner_id):
        self.finalized.append(attempt_id)
        return {"manifest_hash": "sha256:" + "d" * 64, "chunks": len(self.chunks)}

    def fingerprint_submit(self, attempt_id, task_id, answer_values_hash):
        self.fingerprints.append((attempt_id, task_id, answer_values_hash))
        return []


# ------------------------------------------------------------------ world
class World:
    def __init__(self, app, runner, integrity):
        self.app = app
        self.client = TestClient(app)
        self.runner = runner
        self.integrity = integrity
        self._n = 0

    def new_client(self):
        return TestClient(self.app)

    def register(self, track="python", client=None):
        client = client or self.client
        self._n += 1
        email = f"learner{self._n}@example.test"
        r = client.post("/api/auth/register", json={"email": email, "password": PW})
        assert r.status_code == 201, r.text
        assert client.put("/api/me/track", json={"track": track}).status_code == 200
        return r.json()

    # --- attempt helpers
    def create(self, level, client=None):
        return (client or self.client).post("/api/attempts", json={"level": level})

    def begin(self, level, client=None):
        client = client or self.client
        r = self.create(level, client)
        assert r.status_code in (200, 201), r.text
        aid = r.json()["attempt_id"]
        if r.json().get("consent_required"):
            c = client.post(f"/api/attempts/{aid}/consent", json={
                "version": assessment.CONSENT_VERSION, "scopes": list(assessment.REQUIRED_SCOPES)})
            assert c.status_code == 200, c.text
        s = client.post(f"/api/attempts/{aid}/start")
        assert s.status_code == 200, s.text
        return aid, s.json()

    def answer_for(self, item, correct=True):
        ref = item["item_id"]
        kind = item["kind"]
        if kind in ("single", "multi", "short"):
            bank_item = self.bank_item(ref)
            variant = self.matching_variant(bank_item, item)
            ans = variant.get("answer", bank_item.get("answer"))
            acc = variant.get("accepted", bank_item.get("accepted"))
            if kind == "short":
                return acc[0] if correct else "definitely wrong"
            return ans if correct else ["zz"]
        if kind == "decision":
            bank_item = self.bank_item(ref)
            if correct:
                return {"action": bank_item["action"], "evidence": bank_item["evidence"]}
            wrong_action = next(o["id"] for o in bank_item["action_options"] if o["id"] != bank_item["action"])
            return {"action": wrong_action, "evidence": []}
        if correct:
            ref_sol = REFS[ref]
            return ref_sol.get("code") or ref_sol["sql"]
        return item["starter_code"] if item.get("starter_code") else item["broken_code"]

    def bank_item(self, ref):
        base = ref.split(":")[0]
        for f in BANK.glob("*_l[123].json"):
            for it in json.loads(f.read_text(encoding="utf-8"))["items"]:
                if it["id"] == base:
                    return it
        raise KeyError(ref)

    @staticmethod
    def matching_variant(bank_item, shown):
        for v in [{}] + bank_item.get("variants", []):
            if (v.get("prompt", bank_item["prompt"]), v.get("code", bank_item.get("code"))) == (shown["prompt"], shown.get("code")):
                return v
        raise AssertionError("no matching variant")

    def play(self, level, correct=None, client=None, finish=True, explanation=""):
        """Play a level. `correct` is a set of item indexes answered correctly (None = all)."""
        client = client or self.client
        aid, started = self.begin(level, client)
        items = started["items"]
        for idx, item in enumerate(items):
            if item.get("locked"):
                continue
            self._submit(client, aid, item, correct is None or idx in correct, explanation)
        if level == 3:
            att = client.get(f"/api/attempts/{aid}").json()
            for idx, item in enumerate(att["items"]):
                if item["stage"] == "mutated":
                    self._submit(client, aid, item, correct is None or idx in correct, explanation)
        if not finish:
            return aid, None
        r = client.post(f"/api/attempts/{aid}/finish")
        assert r.status_code == 200, r.text
        return aid, r.json()

    def _submit(self, client, aid, item, ok, explanation):
        body = {"item_id": item["item_id"], "answer": self.answer_for(item, ok)}
        if item["kind"] in ("python", "sql") and explanation:
            body["explanation"] = explanation
        r = client.post(f"/api/attempts/{aid}/submit-item", json=body)
        assert r.status_code == 200, r.text
        return r

    @staticmethod
    def l4(scores=(2, 2, 2, 2, 2), confidence=0.9):
        names = ["explain", "justify_approach", "complexity", "edge_cases", "adapt_constraint"]
        return {"criteria": [{"criterion": n, "score0to3": s, "rationale": "ok", "confidence": confidence}
                             for n, s in zip(names, scores)],
                "model_ref": "stub-v1", "ai_disclosure": True, "rubric_version": "1.0.0"}

    def progress(self, client=None):
        return (client or self.client).get("/api/me/progress").json()

    def pass_levels_1_to_3(self, client=None):
        for lvl in (1, 2, 3):
            _, res = self.play(lvl, client=client)
            assert res["outcome"] == "passed", (lvl, res)


@pytest.fixture()
def world():
    runner, integrity = FakeRunner(), FakeIntegrity()
    clock = lambda: datetime(2026, 10, 10, 9, 0, 0, tzinfo=timezone.utc)  # noqa: E731
    identity.configure(database_url="sqlite://", clock=clock)
    evidence.configure(database_url="sqlite://", clock=clock)
    scoring.configure(database_url="sqlite://", clock=clock)
    assessment.configure(database_url="sqlite://", clock=clock, runner=runner, integrity=integrity)
    assessment.register_tasks()
    app = FastAPI()
    for router in (identity.router, assessment.router, scoring.router, evidence.router):
        app.include_router(router, prefix="/api")
    yield World(app, runner, integrity)
    for mod in (assessment, scoring, evidence, identity):
        mod.reset()
