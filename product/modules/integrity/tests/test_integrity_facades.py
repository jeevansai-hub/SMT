"""Contract tests for integrity.api facades (consent, events, recording, summary, similarity, retention)."""
import hashlib
import json
from pathlib import Path

import pytest

from integrity import api

A1, A2 = "attempt-0001", "attempt-0002"
L1, L2 = "learner-1", "learner-2"
ALL = ["camera", "screen", "microphone", "events"]
SHA = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731


def consent(attempt=A1, learner=L1, scopes=ALL):
    return api.record_consent(attempt, learner, "v1", scopes)


# ---------------------------------------------------------------- consent and ownership

def test_should_store_consent_record_with_version_scopes_and_time():
    rec = consent()
    assert rec.version == "v1" and rec.scopes == tuple(sorted(ALL)) and rec.recorded_at > 0
    assert api.summary(A1).consent["version"] == "v1"


def test_should_not_let_another_learner_take_over_an_attempt():
    consent()
    with pytest.raises(api.NotFound):
        consent(learner=L2)


def test_should_return_identical_error_for_unknown_and_foreign_attempts():
    consent()
    errors = []
    for attempt, learner in ((A2, L1), (A1, L2)):
        with pytest.raises(api.NotFound) as exc:
            api.ingest_events(attempt, learner, [{"type": "copy", "t_ms": 1}])
        errors.append((type(exc.value), str(exc.value), exc.value.code))
    assert errors[0] == errors[1]


def test_should_reject_events_before_consent():
    with pytest.raises(api.NotFound):
        api.ingest_events(A1, L1, [{"type": "copy", "t_ms": 1}])


# ---------------------------------------------------------------- events and summary

def test_should_summarise_event_counts_and_label_risk_low_to_high():
    consent()
    api.ingest_events(A1, L1, [{"type": "paste", "t_ms": 1}])
    s = api.summary(A1)
    assert s.counts == {"paste": 1} and s.risk_label == "low" and s.total_events == 1
    api.ingest_events(A1, L1, [{"type": "paste", "t_ms": 2}, {"type": "tab_hidden", "t_ms": 3},
                               {"type": "fullscreen_exit", "t_ms": 4}])
    assert api.summary(A1).risk_label == "medium"
    api.ingest_events(A1, L1, [{"type": "screen_share_ended", "t_ms": 5}] * 4)
    s = api.summary(A1)
    assert s.risk_label == "high" and s.counts["screen_share_ended"] == 4


def test_summary_should_be_advisory_and_use_neutral_wording():
    consent()
    api.ingest_events(A1, L1, [{"type": "paste", "t_ms": 1}])
    blob = json.dumps(api.summary(A1).to_dict()).lower()
    assert "does not change any result" in blob
    for banned in ("cheat", "misconduct", "suspicious", "ai detected", "fail"):
        assert banned not in blob


def test_summary_should_have_no_score_or_result_fields():
    consent()
    keys = set(api.summary(A1).to_dict())
    assert not keys & {"score", "result", "passed", "outcome", "estimate"}


def test_should_reject_a_batch_atomically_when_any_event_is_invalid():
    consent()
    with pytest.raises(api.InvalidInput):
        api.ingest_events(A1, L1, [{"type": "copy", "t_ms": 1}, {"type": "bogus", "t_ms": 2}])
    assert api.summary(A1).total_events == 0


def test_should_cap_stored_events_per_attempt_and_count_dropped(monkeypatch):
    monkeypatch.setenv("INTEGRITY_MAX_EVENTS", "10")
    api._reset_for_tests()
    consent()
    for i in range(3):
        api.ingest_events(A1, L1, [{"type": "copy", "t_ms": i * 10 + k} for k in range(5)])
    s = api.summary(A1)
    assert s.total_events == 10 and s.dropped_events == 5


def test_should_honour_configurable_risk_thresholds(monkeypatch):
    monkeypatch.setenv("INTEGRITY_RISK_MEDIUM", "1")
    monkeypatch.setenv("INTEGRITY_RISK_HIGH", "2")
    api._reset_for_tests()
    consent()
    api.ingest_events(A1, L1, [{"type": "paste", "t_ms": 1}])
    assert api.summary(A1).risk_label == "high"


# ---------------------------------------------------------------- recording

def test_should_store_chunks_under_recordings_dir_with_sha256_each(tmp_path):
    consent()
    r = api.store_chunk(A1, L1, "camera", 0, b"hello")
    assert r.sha256 == hashlib.sha256(b"hello").hexdigest() and r.size == 5
    assert (tmp_path / "data" / "recordings" / A1 / "camera" / "00000000.chunk").read_bytes() == b"hello"


def test_should_finalize_with_deterministic_manifest_hash_over_chunk_hashes(tmp_path):
    consent()
    api.store_chunk(A1, L1, "camera", 1, b"BBB")
    api.store_chunk(A1, L1, "camera", 0, b"AAA")
    api.store_chunk(A1, L1, "screen", 0, b"SSS")
    fin = api.finalize_recording(A1, L1)
    expected = {"version": 1, "attempt_id": A1, "streams": {
        "camera": [{"seq": 0, "sha256": hashlib.sha256(b"AAA").hexdigest(), "size": 3},
                   {"seq": 1, "sha256": hashlib.sha256(b"BBB").hexdigest(), "size": 3}],
        "screen": [{"seq": 0, "sha256": hashlib.sha256(b"SSS").hexdigest(), "size": 3}],
        "justification": []}}
    blob = json.dumps(expected, sort_keys=True, separators=(",", ":")).encode()
    assert fin == {"manifest_hash": hashlib.sha256(blob).hexdigest(), "chunks": 3}
    assert (tmp_path / "data" / "recordings" / A1 / "manifest.json").read_bytes() == blob
    assert api.finalize_recording(A1, L1) == fin  # idempotent
    assert api.summary(A1).recording == {"finalized": True, "manifest_hash": fin["manifest_hash"], "chunks": 3}


def test_should_accept_idempotent_retry_but_reject_conflicting_chunk():
    consent()
    api.store_chunk(A1, L1, "camera", 0, b"one")
    assert api.store_chunk(A1, L1, "camera", 0, b"one").size == 3
    with pytest.raises(api.Conflict):
        api.store_chunk(A1, L1, "camera", 0, b"two")


def test_should_reject_chunks_after_finalize():
    consent()
    api.finalize_recording(A1, L1)
    with pytest.raises(api.Conflict):
        api.store_chunk(A1, L1, "camera", 0, b"late")


@pytest.mark.parametrize("stream,seq,data,exc", [
    ("audio", 0, b"x", api.InvalidInput), ("camera", -1, b"x", api.InvalidInput),
    ("camera", "0", b"x", api.InvalidInput), ("camera", 0, b"", api.InvalidInput),
    ("camera", 0, "text", api.InvalidInput), ("../camera", 0, b"x", api.InvalidInput),
    ("camera", 10**9, b"x", api.InvalidInput),
])
def test_should_reject_invalid_chunk_arguments(stream, seq, data, exc):
    consent()
    with pytest.raises(exc):
        api.store_chunk(A1, L1, stream, seq, data)


def test_should_reject_oversized_chunk(monkeypatch):
    monkeypatch.setenv("INTEGRITY_CHUNK_MAX_BYTES", "2048")
    api._reset_for_tests()
    consent()
    api.store_chunk(A1, L1, "camera", 0, b"x" * 2048)
    with pytest.raises(api.TooLarge):
        api.store_chunk(A1, L1, "camera", 1, b"x" * 2049)


@pytest.mark.parametrize("bad_id", ["../../etc", "..\\..\\x", "a/b/c/d/e", "attempt\x00id1"])
def test_should_reject_path_traversal_attempt_ids(bad_id, tmp_path):
    for call in (lambda: api.record_consent(bad_id, L1, "v1", ["camera"]),
                 lambda: api.store_chunk(bad_id, L1, "camera", 0, b"x"),
                 lambda: api.finalize_recording(bad_id, L1),
                 lambda: api.playback_range(bad_id, "camera", None)):
        with pytest.raises(api.InvalidInput):
            call()
    assert not any(p.name == "etc" for p in (tmp_path / "data").rglob("*"))


def test_should_not_store_a_stream_the_learner_did_not_consent_to(tmp_path):
    consent(scopes=["camera", "events"])
    api.store_chunk(A1, L1, "camera", 0, b"x")
    with pytest.raises(api.NotFound):
        api.store_chunk(A1, L1, "screen", 0, b"x")
    assert not (tmp_path / "data" / "recordings" / A1 / "screen").exists()


def test_should_not_let_another_learner_store_or_finalize():
    consent()
    with pytest.raises(api.NotFound):
        api.store_chunk(A1, L2, "camera", 0, b"x")
    with pytest.raises(api.NotFound):
        api.finalize_recording(A1, L2)


def test_should_detect_tampering_when_verifying_recording(tmp_path):
    consent()
    api.store_chunk(A1, L1, "camera", 0, b"AAAA")
    api.finalize_recording(A1, L1)
    assert api.verify_recording(A1) is True
    (tmp_path / "data" / "recordings" / A1 / "camera" / "00000000.chunk").write_bytes(b"AAAB")
    assert api.verify_recording(A1) is False


# ---------------------------------------------------------------- playback (Range)

def _body(slice_):
    return b"".join(slice_.body)


def _recorded():
    consent()
    api.store_chunk(A1, L1, "camera", 0, b"0123456789")
    api.store_chunk(A1, L1, "camera", 1, b"abcdefghij")
    api.store_chunk(A1, L1, "camera", 2, b"KLMNOPQRST")


def test_should_serve_whole_stream_when_no_range():
    _recorded()
    s = api.playback_range(A1, "camera", None)
    assert s.status == 200 and _body(s) == b"0123456789abcdefghijKLMNOPQRST"
    assert s.headers["Accept-Ranges"] == "bytes" and s.headers["Content-Length"] == "30"


@pytest.mark.parametrize("header,expected,crange", [
    ("bytes=0-4", b"01234", "bytes 0-4/30"),
    ("bytes=8-12", b"89abc", "bytes 8-12/30"),            # spans a chunk boundary
    ("bytes=5-24", b"56789abcdefghijKLMNO", "bytes 5-24/30"),  # spans three chunks
    ("bytes=25-", b"PQRST", "bytes 25-29/30"),
    ("bytes=-3", b"RST", "bytes 27-29/30"),
])
def test_should_serve_partial_content_across_chunk_boundaries(header, expected, crange):
    _recorded()
    s = api.playback_range(A1, "camera", header)
    assert s.status == 206 and _body(s) == expected
    assert s.headers["Content-Range"] == crange and s.headers["Content-Length"] == str(len(expected))


def test_should_answer_416_for_unsatisfiable_range():
    _recorded()
    s = api.playback_range(A1, "camera", "bytes=30-")
    assert s.status == 416 and s.headers["Content-Range"] == "bytes */30"


def test_should_report_not_found_for_stream_without_chunks():
    _recorded()
    with pytest.raises(api.NotFound):
        api.playback_range(A1, "screen", None)


# ---------------------------------------------------------------- similarity

def test_should_flag_identical_answer_values_across_different_learners_and_seeds():
    consent(A1, L1)
    consent(A2, L2)
    h = SHA("42|17")
    assert api.fingerprint_submit(A1, "task-1", h, "dataset-a") == []
    flags = api.fingerprint_submit(A2, "task-1", h, "dataset-b")
    assert [f.code for f in flags] == ["similar_answer_values"] and flags[0].matched_attempts == 1
    s = api.summary(A2)
    assert [f.code for f in s.flags] == ["similar_answer_values"]
    assert s.risk_label == "low"  # advisory, one flag alone does not escalate


def test_should_not_flag_same_dataset_or_same_learner_or_different_hash():
    consent(A1, L1)
    consent(A2, L2)
    consent("attempt-0003", L1)
    h = SHA("a")
    api.fingerprint_submit(A1, "task-1", h, "dataset-a")
    assert api.fingerprint_submit(A2, "task-1", h, "dataset-a") == []                 # same seed: expected
    api.fingerprint_submit(A1, "task-3", h, "dataset-a")
    assert api.fingerprint_submit("attempt-0003", "task-3", h, "dataset-b") == []     # same learner retry
    assert api.fingerprint_submit(A2, "task-1", SHA("b"), "dataset-b") == []
    assert api.fingerprint_submit(A2, "task-2", h, "dataset-b") == []                 # different task


def test_should_reject_malformed_fingerprint_hash():
    with pytest.raises(api.InvalidInput):
        api.fingerprint_submit(A1, "task-1", "not-a-sha")


def test_flag_should_not_change_results_only_summary():
    consent(A1, L1)
    consent(A2, L2)
    h = SHA("z")
    api.fingerprint_submit(A1, "t1", h)
    api.fingerprint_submit(A2, "t1", h)
    d = api.summary(A2).to_dict()
    assert "advisory" in d and "score" not in d


# ---------------------------------------------------------------- retention

def test_should_purge_recordings_older_than_retention_days(tmp_path):
    consent()
    api.store_chunk(A1, L1, "camera", 0, b"data")
    api.finalize_recording(A1, L1)
    assert api.purge_expired() == 0
    far_future = api.get_service()._clock() + 31 * 86400
    assert api.purge_expired(far_future) == 1
    assert not (tmp_path / "data" / "recordings" / A1).exists()
    with pytest.raises(api.NotFound):
        api.playback_range(A1, "camera", None)
    assert api.summary(A1).recording["manifest_hash"]  # the ledger hash survives


def test_should_use_configurable_retention(monkeypatch):
    monkeypatch.setenv("INTEGRITY_RETENTION_DAYS", "2")
    api._reset_for_tests()
    consent()
    api.store_chunk(A1, L1, "camera", 0, b"data")
    now = api.get_service()._clock()
    assert api.purge_expired(now + 1 * 86400) == 0
    assert api.purge_expired(now + 3 * 86400) == 1


# ---------------------------------------------------------------- surface

def test_should_expose_exactly_the_agreed_facades():
    for name in ("record_consent", "ingest_events", "store_chunk", "finalize_recording", "summary",
                 "fingerprint_submit", "router"):
        assert hasattr(api, name)
