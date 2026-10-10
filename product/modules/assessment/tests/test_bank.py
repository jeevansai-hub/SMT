"""Item bank shape, size and solvability (Founder spec: L1 >=10, L2 >=6, L3 >=4 tasks with a mutated variant)."""
import json
import random
import sqlite3
from pathlib import Path

import pytest

from assessment.application import plan as planning
from assessment.infrastructure.bank import JsonBank

REFS = json.loads((Path(__file__).resolve().parent / "reference_solutions.json").read_text(encoding="utf-8"))
BANK = JsonBank()
TRACKS = ("python", "data_analyst")


@pytest.mark.parametrize("track", TRACKS)
def test_should_have_enough_items_per_level(track):
    assert len(BANK.items(track, 1)) >= 10
    assert len(BANK.items(track, 2)) >= 6
    assert len(BANK.items(track, 3)) >= 4


@pytest.mark.parametrize("track", TRACKS)
def test_should_give_every_l3_task_a_base_and_a_mutated_variant(track):
    for it in BANK.items(track, 3):
        assert set(it["stages"]) == {"base", "mutated"}
        for st in it["stages"].values():
            assert len(st["datasets"]) >= 2 and all(len(d["tests"]) >= 3 for d in st["datasets"])


@pytest.mark.parametrize("track", TRACKS)
def test_should_have_unique_item_ids_and_valid_l1_keys(track):
    ids = [i["id"] for lvl in (1, 2, 3) for i in BANK.items(track, lvl)]
    assert len(ids) == len(set(ids))
    for it in BANK.items(track, 1):
        if it["kind"] in ("single", "multi"):
            opt_ids = {o["id"] for o in it["options"]}
            assert set(it["answer"]) <= opt_ids
        elif it["kind"] == "decision":
            action_ids = {o["id"] for o in it["action_options"]}
            evidence_ids = {o["id"] for o in it["evidence_options"]}
            assert it["action"] in action_ids
            assert set(it["evidence"]) <= evidence_ids and it["evidence"]
        else:
            assert it["accepted"]


def test_should_read_qualify_thresholds_from_bank_config():
    r = BANK.rules
    assert (r.l1_count, r.l1_min_correct, r.l2_count, r.l2_min_pass) == (5, 4, 3, 2)
    assert (r.l3_tasks, r.l3_min_full_tasks, r.l3_min_ratio) == (2, 1, 0.7)
    assert (r.l4_min_total, r.l4_min_each) == (10, 1)


def _py_passes(code, fn, tests):
    ns = {}
    exec(compile(code, "<ref>", "exec"), ns)
    for t in tests:
        got = json.loads(json.dumps(ns[fn](*json.loads(json.dumps(t["args"])))))
        if got != t["expected"]:
            return False
    return True


def _sql_rows(setup, query):
    con = sqlite3.connect(":memory:")
    con.executescript(setup)
    return [list(r) for r in con.execute(query).fetchall()]


def test_should_solve_every_python_task_with_its_reference_solution():
    for level in (2, 3):
        for it in BANK.items("python", level):
            sources = [(it["id"], it)] if level == 2 else [(f"{it['id']}:{k}", v) for k, v in it["stages"].items()]
            for ref, src in sources:
                fn = REFS[ref]["function"]
                for ds in src["datasets"]:
                    assert _py_passes(REFS[ref]["code"], fn, ds["tests"]), (ref, ds["name"])


def test_should_not_pass_a_broken_python_program():
    for it in BANK.items("python", 2):
        for ds in it["datasets"]:
            assert not _py_passes(it["broken_code"], it["function"], ds["tests"]), it["id"]


def test_should_make_every_sql_expected_query_runnable_and_broken_query_wrong():
    for level in (2, 3):
        for it in BANK.items("data_analyst", level):
            sources = [(it["id"], it)] if level == 2 else [(f"{it['id']}:{k}", v) for k, v in it["stages"].items()]
            for ref, src in sources:
                for ds in src["datasets"]:
                    for t in ds["tests"]:
                        setup = t.get("setup_sql", ds["setup_sql"])
                        _sql_rows(setup, t["expected_query"])
    for it in BANK.items("data_analyst", 2):
        differs = False
        for ds in it["datasets"]:
            for t in ds["tests"]:
                setup = t.get("setup_sql", ds["setup_sql"])
                if _sql_rows(setup, it["broken_code"]) != _sql_rows(setup, t["expected_query"]):
                    differs = True
        assert differs, it["id"]


def test_should_change_expected_results_when_the_constraint_is_mutated():
    for it in BANK.items("python", 3):
        base_fn = it["stages"]["base"]["function"]
        mut_tests = [t for d in it["stages"]["mutated"]["datasets"] for t in d["tests"]]
        base_code = REFS[f"{it['id']}:base"]["code"]
        try:
            ok = _py_passes(base_code, it["stages"]["mutated"]["function"], mut_tests)
        except Exception:
            ok = False
        assert not ok, it["id"]
        assert base_fn


def test_should_be_deterministic_for_a_seed_and_differ_between_seeds():
    items = BANK.items("python", 1)
    a = planning.build_plan("python", 1, "aabbccddeeff", items, BANK.rules)
    b = planning.build_plan("python", 1, "aabbccddeeff", items, BANK.rules)
    c = planning.build_plan("python", 1, "112233445566", items, BANK.rules)
    assert a == b and len(a) == 5
    assert [p["ref"] for p in a] != [p["ref"] for p in c] or [p["option_order"] for p in a] != [p["option_order"] for p in c]


def test_should_use_stable_valid_uuids_for_runner_tasks():
    t = planning.task_uuid("python", "py-l2-01", None)
    assert t == planning.task_uuid("python", "py-l2-01", None)
    assert planning.dataset_uuid(t, "v1") != planning.dataset_uuid(t, "v2")
    assert len(t) == 36 and t == t.lower()


def test_should_prefer_unused_items_on_retry():
    items = BANK.items("python", 1)
    first = planning.build_plan("python", 1, "000000000001", items, BANK.rules)
    used = [p["bank_id"] for p in first]
    second = planning.build_plan("python", 1, "000000000002", items, BANK.rules, used)
    assert not set(used) & {p["bank_id"] for p in second}
