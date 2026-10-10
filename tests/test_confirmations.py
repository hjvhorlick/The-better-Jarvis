import pytest

from backend.events import EventBus
from backend.permissions import ConfirmationError, ConfirmationStore, TooManyPending


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def _store(**kw):
    bus = EventBus()
    clock = Clock()
    return ConfirmationStore(bus=bus, clock=clock, **kw), bus, clock


def test_approved_action_runs_once_and_reports_its_result():
    store, bus, _ = _store()
    calls = []
    view = store.request("myhands.start", "Turn on My Hands.", run=lambda: calls.append(1) or "started")
    assert [p["id"] for p in store.pending()] == [view["id"]]
    out = store.resolve(view["id"], approve=True)
    assert out["status"] == "approved" and out["result"] == "started"
    assert calls == [1]
    with pytest.raises(ConfirmationError):                   # answered once, then gone
        store.resolve(view["id"], approve=True)
    assert store.pending() == []


def test_denied_action_never_runs():
    store, _, _ = _store()
    calls = []
    view = store.request("myhands.start", "Turn on My Hands.", run=lambda: calls.append(1) or "x")
    out = store.resolve(view["id"], approve=False)
    assert out["status"] == "denied" and calls == []


def test_a_failing_action_reports_the_error_type_only():
    store, _, _ = _store()

    def boom():
        raise RuntimeError("secret detail /home/owner/private")

    view = store.request("myhands.start", "Turn on My Hands.", run=boom)
    out = store.resolve(view["id"], approve=True)
    assert out["status"] == "failed"
    assert "RuntimeError" in out["result"] and "secret detail" not in out["result"]


def test_unanswered_requests_expire():
    store, bus, clock = _store(ttl_s=10)
    view = store.request("myhands.start", "Turn on My Hands.", run=lambda: "x")
    clock.now += 11
    assert store.pending() == []
    with pytest.raises(ConfirmationError):
        store.resolve(view["id"], approve=True)
    statuses = [e["status"] for _, e in bus.since(0, source="permissions") if e["type"] == "confirm_resolved"]
    assert statuses == ["expired"]


def test_unknown_id_is_refused():
    store, _, _ = _store()
    with pytest.raises(ConfirmationError):
        store.resolve("does-not-exist", approve=True)


def test_queue_is_bounded():
    store, _, _ = _store(max_pending=2)
    store.request("a", "one", run=lambda: "")
    store.request("a", "two", run=lambda: "")
    with pytest.raises(TooManyPending):
        store.request("a", "three", run=lambda: "")


def test_requests_and_answers_go_on_the_bus():
    store, bus, _ = _store()
    view = store.request("myhands.start", "Turn on My Hands.", run=lambda: "ok")
    store.resolve(view["id"], approve=True)
    kinds = [e["type"] for _, e in bus.since(0, source="permissions")]
    assert kinds == ["confirm_requested", "confirm_resolved"]


def test_request_needs_a_summary_and_a_callable():
    store, _, _ = _store()
    with pytest.raises(ValueError):
        store.request("a", "", run=lambda: "")
    with pytest.raises(ValueError):
        store.request("a", "x", run="not callable")
