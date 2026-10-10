"""End-to-end through the REAL runner (stream B) and real identity/assessment/evidence/scoring.

Learner passes L1-L3 for both tracks with reference solutions, L4 is applied via the assessment facade
(the interview module is stream A2), then the gated score is published. Skipped if the runner or its
isolation is unavailable in this environment.
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from config import Settings
from main import create_app

runner_api = pytest.importorskip("runner.api")
MODULES = Path(__file__).resolve().parents[3] / "modules"
BANK = MODULES / "assessment" / "bank"
REFS = json.loads((MODULES / "assessment" / "tests" / "reference_solutions.json").read_text(encoding="utf-8"))
PW = "correct-horse-battery"


def _bank_item(ref):
    base = ref.split(":")[0]
    for f in BANK.glob("*_l[123].json"):
        for it in json.loads(f.read_text(encoding="utf-8"))["items"]:
            if it["id"] == base:
                return it
    raise KeyError(ref)


def _l1_answer(item):
    bank = _bank_item(item["item_id"])
    for v in [{}] + bank.get("variants", []):
        if (v.get("prompt", bank["prompt"]), v.get("code", bank.get("code"))) == (item["prompt"], item.get("code")):
            if bank["kind"] == "short":
                return v.get("accepted", bank.get("accepted"))[0]
            return v.get("answer", bank["answer"])
    raise AssertionError("variant not found")


@pytest.fixture()
def journey(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("RUNNER_ALLOW_FALLBACK", "true")
    runner_api._reset_for_tests()
    app = create_app(Settings(data_dir=str(tmp_path), serve_web=False))
    yield app, TestClient(app)
    for name in ("assessment", "scoring", "evidence", "identity"):
        app.state.apis[name].reset()
    runner_api._reset_for_tests()


def _play(client, level):
    created = client.post("/api/attempts", json={"level": level})
    aid = created.json()["attempt_id"]
    api = client.app.state.apis["assessment"]
    assert client.post(f"/api/attempts/{aid}/consent", json={"version": api.CONSENT_VERSION, "scopes": list(api.REQUIRED_SCOPES)}).status_code == 200
    started = client.post(f"/api/attempts/{aid}/start").json()
    items = started["items"]
    for item in items:
        if item.get("locked"):
            continue
        _submit(client, aid, item)
    if level == 3:
        for item in client.get(f"/api/attempts/{aid}").json()["items"]:
            if item["stage"] == "mutated":
                _submit(client, aid, item)
    return aid, client.post(f"/api/attempts/{aid}/finish").json()


def _submit(client, aid, item):
    if item["kind"] in ("single", "multi", "short", "single_choice", "multi_choice", "short_answer"):
        answer = _l1_answer(item)
    else:
        ref = REFS[item["item_id"]]
        answer = ref.get("code") or ref["sql"]
    r = client.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item["item_id"], "answer": answer})
    assert r.status_code == 200, r.text
    if item["kind"] in ("python", "sql", "code"):
        assert r.json()["status"] == "passed", r.json()


@pytest.mark.parametrize("track,competency", [("python", "python"), ("data_analyst", "sql")])
def test_should_pass_all_levels_and_publish_gated_score_via_real_runner(journey, track, competency):
    app, client = journey
    me = client.post("/api/auth/register", json={"email": f"{track}@example.test", "password": PW}).json()
    client.put("/api/me/track", json={"track": track})
    if app.state.apis["runner"].isolation_status() == "unavailable":
        pytest.skip("no runner isolation available (set RUNNER_ALLOW_FALLBACK=true or install Docker)")
    for level in (1, 2, 3):
        _, res = _play(client, level)
        assert res["outcome"] == "passed", (level, res)
    scoring = app.state.apis["scoring"]
    assert scoring.competency_estimate(me["id"], competency) is None  # nothing published before L4
    created = client.post("/api/attempts", json={"level": 4}).json()["attempt_id"]
    api = app.state.apis["assessment"]
    client.post(f"/api/attempts/{created}/consent", json={"version": api.CONSENT_VERSION, "scopes": list(api.REQUIRED_SCOPES)})
    assert client.post(f"/api/attempts/{created}/start").status_code == 200
    names = ["explain", "justify_approach", "complexity", "edge_cases", "adapt_constraint"]
    api.record_level4_result(created, {"criteria": [{"criterion": n, "score0to3": 2, "rationale": "ok", "confidence": 0.9} for n in names],
                                       "model_ref": "stub-v1", "ai_disclosure": True})
    est = scoring.competency_estimate(me["id"], competency)
    assert est is not None and est.lower <= est.estimate <= est.upper
    prof = client.get("/api/me/profile").json()
    comp = next(c for c in prof["competencies"] if c["competency"] == competency)
    assert comp["estimate"]["label"] == "Experimental"
    assert comp["evidence"]["automated_test"] > 0 and comp["evidence"]["live_screening"] == 5
    verify = app.state.apis["evidence"].verify(me["id"])
    assert verify.ok
