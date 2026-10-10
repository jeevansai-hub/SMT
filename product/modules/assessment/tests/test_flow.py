"""Assessment flow: levels, qualify, progression, resume, retry, gating (build-brief sections 2, 8)."""
import json

import pytest

import assessment.api as assessment
import evidence.api as evidence
import scoring.api as scoring

NOT_FOUND = {"error": {"code": "not_found", "message": "Not found"}}


# ----------------------------------------------------------------- creation, consent, locks
def test_should_lock_levels_until_previous_level_passed(world):
    world.register()
    r = world.create(2)
    assert r.status_code == 409 and r.json()["error"]["code"] == "level_locked"


def test_should_require_a_track_before_creating_an_attempt(world):
    r = world.client.post("/api/auth/register", json={"email": "t@example.test", "password": "correct-horse-battery"})
    assert r.status_code == 201
    assert world.create(1).status_code == 409


def test_should_require_consent_before_start(world):
    world.register()
    aid = world.create(1).json()["attempt_id"]
    r = world.client.post(f"/api/attempts/{aid}/start")
    assert r.status_code == 409 and r.json()["error"]["code"] == "consent_required"


def test_should_reject_incomplete_consent_without_accusatory_wording(world):
    world.register()
    aid = world.create(1).json()["attempt_id"]
    r = world.client.post(f"/api/attempts/{aid}/consent", json={"version": assessment.CONSENT_VERSION, "scopes": ["camera"]})
    assert r.status_code == 422
    assert not world.integrity.consents


def test_should_forward_consent_to_integrity_and_allow_start(world):
    me = world.register()
    aid, started = world.begin(1)
    assert world.integrity.consents[0][:2] == (aid, me["id"])
    assert started["status"] == "in_progress" and len(started["items"]) == 5


# ----------------------------------------------------------------- L1
def test_should_pass_l1_with_four_of_five_correct(world):
    world.register()
    _, res = world.play(1, correct={0, 1, 2, 3})
    assert res["outcome"] == "passed"


def test_should_fail_l1_with_three_of_five_correct(world):
    world.register()
    _, res = world.play(1, correct={0, 1, 2})
    assert res["outcome"] == "failed"


def test_should_not_expose_answers_or_keys_in_item_views(world):
    world.register()
    _, started = world.begin(1)
    text = json.dumps(started)
    for banned in ('"answer"', '"accepted"', '"expected"', "expected_query", "time_taken", "duration"):
        assert banned not in text
    for item in started["items"]:
        assert set(item) <= {"item_id", "kind", "prompt", "code", "options", "title", "stage", "locked",
                             "broken_code", "starter_code", "schema", "answered",
                             "scenario", "action_options", "evidence_options"}


def test_should_keep_answers_and_resume_the_open_attempt(world):
    world.register()
    aid, started = world.begin(1)
    item = started["items"][0]
    world.client.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item["item_id"], "answer": world.answer_for(item)})
    again = world.create(1)
    assert again.json()["attempt_id"] == aid
    view = world.client.get(f"/api/attempts/{aid}").json()
    assert view["items"][0]["answered"] is True


def test_should_give_a_fresh_variant_on_retry_and_keep_history(world):
    world.register()
    first, _ = world.play(1, correct=set())
    _, started = world.begin(1)
    l1 = world.progress()["levels"][0]
    assert l1["attempts"] == 2 and l1["status"] == "in_progress"
    assert [h["attempt_no"] for h in l1["history"]] == [1, 2]
    assert l1["history"][0]["status"] == "failed" and l1["open_attempt_id"] != first


def test_should_draw_a_different_item_set_after_a_failed_attempt(world):
    world.register()
    _, first = world.begin(1)
    first_ids = [i["item_id"] for i in first["items"]]
    aid = world.client.get("/api/me/progress").json()["levels"][0]["open_attempt_id"]
    world.client.post(f"/api/attempts/{aid}/finish")  # all unanswered -> failed
    _, second = world.begin(1)
    assert set(first_ids).isdisjoint(i["item_id"] for i in second["items"])


def test_should_not_allow_repeating_a_passed_level(world):
    world.register()
    world.play(1)
    r = world.create(1)
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_passed"
    assert world.progress()["levels"][1]["status"] == "available"


def test_should_finish_idempotently(world):
    world.register()
    aid, first = world.play(1)
    again = world.client.post(f"/api/attempts/{aid}/finish")
    assert again.status_code == 200 and again.json() == first


def test_should_reject_submit_after_finish(world):
    world.register()
    aid, started = world.begin(1)
    item_id = started["items"][0]["item_id"]
    world.client.post(f"/api/attempts/{aid}/finish")
    r = world.client.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item_id, "answer": ["a"]})
    assert r.status_code == 409


def test_should_reject_submit_before_start(world):
    world.register()
    world.play(1)
    created = world.create(2)
    assert created.status_code == 201
    r = world.client.post(f"/api/attempts/{created.json()['attempt_id']}/submit-item",
                          json={"item_id": "py-l2-01", "answer": "x"})
    assert r.status_code == 409


def test_should_validate_submit_input(world):
    world.register()
    aid, started = world.begin(1)
    item = started["items"][0]["item_id"]
    c = world.client
    assert c.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item}).status_code == 422
    assert c.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item, "answer": ["a"] * 50}).status_code == 422
    assert c.post(f"/api/attempts/{aid}/submit-item", json={"item_id": "py-l9-99", "answer": ["a"]}).status_code == 404
    assert c.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item, "answer": ["a"], "extra": 1}).status_code == 422


# ----------------------------------------------------------------- ownership
def test_should_return_identical_404_for_foreign_and_unknown_attempts(world):
    world.register()
    aid, _ = world.begin(1)
    other = world.new_client()
    world.register(client=other)
    foreign = other.get(f"/api/attempts/{aid}")
    unknown = other.get("/api/attempts/att_does_not_exist")
    assert foreign.status_code == unknown.status_code == 404
    assert foreign.json() == unknown.json() == NOT_FOUND
    for path, body in ((f"/api/attempts/{aid}/start", None), (f"/api/attempts/{aid}/finish", None),
                       (f"/api/attempts/{aid}/submit-item", {"item_id": "x", "answer": "y"})):
        r = other.post(path, json=body) if body else other.post(path)
        assert r.status_code == 404 and r.json() == NOT_FOUND
    assert assessment.get_attempt(aid, "lrn_ffffffffffffffff") is None


def test_should_require_login_and_learner_role(world):
    assert world.client.post("/api/attempts", json={"level": 1}).status_code == 401
    assert world.client.get("/api/me/progress").status_code == 401


# ----------------------------------------------------------------- L2
def test_should_pass_l2_with_two_of_three_and_record_explanation_without_blocking(world):
    world.register()
    world.play(1)
    _, res = world.play(2, correct={0, 1}, explanation="The denominator used len plus one which is off by one")
    assert res["outcome"] == "passed"


def test_should_pass_l2_even_when_explanations_are_empty(world):
    world.register()
    world.play(1)
    _, res = world.play(2, explanation="")
    assert res["outcome"] == "passed"


def test_should_fail_l2_with_one_of_three(world):
    world.register()
    world.play(1)
    _, res = world.play(2, correct={0})
    assert res["outcome"] == "failed"


def test_should_cap_runs_per_item(world):
    world.register()
    world.play(1)
    aid, started = world.begin(2)
    item = started["items"][0]
    body = {"task_id": item["item_id"], "code": item["broken_code"]}
    limit = assessment.RUN_LIMIT
    for _ in range(limit):
        assert world.client.post(f"/api/attempts/{aid}/run", json=body).status_code == 200
    r = world.client.post(f"/api/attempts/{aid}/run", json=body)
    assert r.status_code == 429


def test_should_run_hidden_tests_without_leaking_them(world):
    world.register()
    world.play(1)
    aid, started = world.begin(2)
    item = started["items"][0]
    r = world.client.post(f"/api/attempts/{aid}/run", json={"task_id": item["item_id"], "code": item["broken_code"]})
    body = r.json()
    assert r.status_code == 200 and body["status"] in ("failed_tests", "passed", "error")
    text = json.dumps(body)
    assert "expected" not in text and "args" not in text
    assert world.runner.calls[-1][3] == "py_check"


def test_should_return_503_without_recording_when_runner_unavailable(world):
    world.register()
    world.play(1)
    aid, started = world.begin(2)
    item = started["items"][0]
    world.runner.unavailable = True
    r = world.client.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item["item_id"], "answer": item["broken_code"]})
    assert r.status_code == 503
    world.runner.unavailable = False
    assert world.client.get(f"/api/attempts/{aid}").json()["items"][0]["answered"] is False


def test_should_register_every_hidden_task_with_the_runner(world):
    # 2 tracks x (7 debugging tasks + 4 applied tasks x 2 stages)
    assert len(world.runner.specs) == 2 * (7 + 4 * 2)
    for task_id, (kind, spec) in world.runner.specs.items():
        assert len(task_id) == 36 and kind in ("python", "sql") and spec["datasets"]


# ----------------------------------------------------------------- L3
def test_should_pass_l3_when_all_tasks_pass(world):
    world.register()
    world.pass_levels_1_to_3()


def test_should_unlock_mutated_variant_only_after_base_submitted(world):
    world.register()
    world.play(1)
    world.play(2)
    aid, started = world.begin(3)
    mutated = [i for i in started["items"] if i["stage"] == "mutated"]
    assert mutated and all(i["locked"] for i in mutated)
    r = world.client.post(f"/api/attempts/{aid}/submit-item", json={"item_id": mutated[0]["item_id"], "answer": "def f():\n    pass\n"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "variant_locked"


def test_should_fail_l3_when_no_task_passes_both_variants(world):
    world.register()
    world.play(1)
    world.play(2)
    # indexes: [t1 base, t1 mutated, t2 base, t2 mutated]; pass base of both, fail mutated of both
    _, res = world.play(3, correct={0, 2})
    assert res["outcome"] == "failed"


def test_should_fail_l3_when_ratio_is_below_seventy_percent(world):
    world.register()
    world.play(1)
    world.play(2)
    # one task fully passes (4 of 4 items positions 0,1) but the other task fails entirely
    _, res = world.play(3, correct={0, 1})
    assert res["outcome"] == "failed"


# ----------------------------------------------------------------- L4 and gating
def test_should_not_allow_level_4_before_level_3(world):
    world.register()
    world.play(1)
    assert world.create(4).status_code == 409


def test_should_expose_the_l3_solution_for_the_interview(world):
    me = world.register()
    assert assessment.l3_solution(me["id"]) is None
    world.pass_levels_1_to_3()
    sol = assessment.l3_solution(me["id"])
    assert sol["task_id"] and "def " in sol["code"]


def test_should_publish_no_score_until_all_four_levels_pass(world):
    me = world.register()
    world.pass_levels_1_to_3()
    assert scoring.competency_estimate(me["id"], "python") is None
    aid, _ = world.begin(4)
    assert scoring.competency_estimate(me["id"], "python") is None
    assessment.record_level4_result(aid, world.l4())
    est = scoring.competency_estimate(me["id"], "python")
    assert est is not None and est.lower <= est.estimate <= est.upper
    assert world.client.get(f"/api/attempts/{aid}").json()["status"] == "passed"


def test_should_not_change_score_after_failed_level_attempts(world):
    me = world.register()
    world.play(1, correct=set())
    assert scoring.competency_estimate(me["id"], "python") is None
    world.pass_levels_1_to_3()
    assert scoring.competency_estimate(me["id"], "python") is None


def test_should_fail_level_4_when_a_criterion_is_zero_or_total_low(world):
    me = world.register()
    world.pass_levels_1_to_3()
    aid, _ = world.begin(4)
    assessment.record_level4_result(aid, world.l4(scores=(3, 3, 3, 3, 0)))
    assert world.client.get(f"/api/attempts/{aid}").json()["status"] == "failed"
    assert scoring.competency_estimate(me["id"], "python") is None
    aid2, _ = world.begin(4)
    assert aid2 != aid
    assessment.record_level4_result(aid2, world.l4(scores=(2, 2, 2, 2, 1)))
    assert world.client.get(f"/api/attempts/{aid2}").json()["status"] == "failed"


def test_should_route_low_confidence_level_4_to_review_without_score_change(world):
    me = world.register()
    world.pass_levels_1_to_3()
    aid, _ = world.begin(4)
    assessment.record_level4_result(aid, world.l4(scores=(3, 3, 3, 3, 3), confidence=0.2))
    assert world.client.get(f"/api/attempts/{aid}").json()["status"] == "awaiting_review"
    assert scoring.competency_estimate(me["id"], "python") is None
    assessment.record_review_outcome(aid, "pass")
    assert scoring.competency_estimate(me["id"], "python") is not None


def test_should_withhold_score_when_ledger_verification_fails(world):
    from sqlalchemy import text
    from evidence.api import runtime
    me = world.register()
    world.pass_levels_1_to_3()
    with runtime.get_engine().begin() as c:
        row = c.execute(text("SELECT sequence, event_json FROM ledger WHERE learner_id=:l ORDER BY sequence LIMIT 1"),
                        {"l": me["id"]}).one()
        ev = json.loads(row[1])
        ev["outcome"] = "fail"
        c.execute(text("UPDATE ledger SET event_json=:j WHERE sequence=:s"), {"j": json.dumps(ev), "s": row[0]})
    aid, _ = world.begin(4)
    assessment.record_level4_result(aid, world.l4())
    assert scoring.competency_estimate(me["id"], "python") is None
    assert world.client.get(f"/api/attempts/{aid}").json()["result"]["score_update"] == "withheld"


def test_should_record_level_outcomes_in_ledger_and_verify(world):
    me = world.register()
    world.pass_levels_1_to_3()
    entries = evidence.list_for_learner(me["id"])
    outcomes = [e for e in entries if e.event_type == "level_outcome"]
    assert [e.event["level"] for e in outcomes] == [1, 2, 3]
    assert all(e.event["competency_id"] == "cmp_python" for e in outcomes)
    assert evidence.verify(me["id"]).ok


def test_should_not_finish_level_4_via_finish_endpoint(world):
    world.register()
    world.pass_levels_1_to_3()
    aid, _ = world.begin(4)
    assert world.client.post(f"/api/attempts/{aid}/finish").status_code == 409


def test_should_support_the_data_analyst_track_end_to_end(world):
    me = world.register(track="data_analyst")
    world.pass_levels_1_to_3()
    aid, _ = world.begin(4)
    assessment.record_level4_result(aid, world.l4())
    est = scoring.competency_estimate(me["id"], "sql")
    assert est is not None
    assert scoring.competency_estimate(me["id"], "python") is None


# ----------------------------------------------------------------- integrity pass-through
def test_should_forward_events_chunks_and_finalize_for_own_in_progress_attempt(world):
    world.register()
    aid, _ = world.begin(1)
    ev = [{"type": "focus_loss", "t": 1234.5, "item_id": "py-l1-01"}]
    assert world.client.post(f"/api/attempts/{aid}/events", json=ev).status_code == 200
    assert world.integrity.events[0][0] == aid
    r = world.client.post(f"/api/attempts/{aid}/chunks/camera/0", content=b"abc", headers={"content-type": "application/octet-stream"})
    assert r.status_code == 200 and world.integrity.chunks[0][2:4] == ("camera", 0)
    f = world.client.post(f"/api/attempts/{aid}/recording/finalize")
    assert f.status_code == 200 and f.json()["manifest_hash"].startswith("sha256:")


def test_should_reject_unknown_event_types_and_streams(world):
    world.register()
    aid, _ = world.begin(1)
    assert world.client.post(f"/api/attempts/{aid}/events", json=[{"type": "cheat", "t": 1}]).status_code == 422
    assert world.client.post(f"/api/attempts/{aid}/chunks/audio/0", content=b"x").status_code == 422
    assert world.client.post(f"/api/attempts/{aid}/events", json=[{"type": "paste", "t": 1}] * 101).status_code == 422


def test_should_not_forward_for_foreign_attempt(world):
    world.register()
    aid, _ = world.begin(1)
    other = world.new_client()
    world.register(client=other)
    r = other.post(f"/api/attempts/{aid}/events", json=[{"type": "paste", "t": 1}])
    assert r.status_code == 404 and not world.integrity.events


def test_should_fingerprint_answer_values_on_submit(world):
    world.register()
    aid, started = world.begin(1)
    item = started["items"][0]
    world.client.post(f"/api/attempts/{aid}/submit-item", json={"item_id": item["item_id"], "answer": world.answer_for(item)})
    assert world.integrity.fingerprints and world.integrity.fingerprints[0][0] == aid
