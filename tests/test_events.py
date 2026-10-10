import threading

import pytest

from backend.events import EventBus


def test_sequence_numbers_are_increasing_and_since_replays_in_order():
    bus = EventBus()
    a = bus.publish("chat", {"type": "message", "text": "hi"})
    b = bus.publish("myhands", {"type": "hand_detected"})
    c = bus.publish("chat", {"type": "message", "text": "again"})
    assert (a, b, c) == (1, 2, 3)
    assert [s for s, _ in bus.since(0)] == [1, 2, 3]
    assert [s for s, _ in bus.since(1)] == [2, 3]
    assert bus.since(3) == []


def test_source_is_stamped_and_the_caller_dict_is_not_changed():
    bus = EventBus()
    original = {"type": "cursor_moved", "x": 0.5}
    bus.publish("myhands", original)
    assert "source" not in original
    (_, stored), = bus.since(0)
    assert stored["source"] == "myhands" and stored["x"] == 0.5
    assert isinstance(stored["at"], float)


def test_returned_events_are_copies():
    bus = EventBus()
    bus.publish("chat", {"type": "message"})
    (_, first), = bus.since(0)
    first["type"] = "tampered"
    (_, again), = bus.since(0)
    assert again["type"] == "message"


def test_filter_by_source():
    bus = EventBus()
    bus.publish("chat", {"type": "message"})
    bus.publish("myhands", {"type": "hand_detected"})
    bus.publish("chat", {"type": "message"})
    assert [e["source"] for _, e in bus.since(0, source="myhands")] == ["myhands"]


def test_capacity_drops_the_oldest_and_reports_it():
    bus = EventBus(capacity=3)
    for i in range(5):
        bus.publish("x", {"type": "tick", "i": i})
    assert bus.oldest_seq == 3
    assert [e["i"] for _, e in bus.since(0)] == [2, 3, 4]
    assert bus.last_seq == 5


def test_invalid_publish_is_rejected():
    bus = EventBus()
    with pytest.raises(ValueError):
        bus.publish("", {"type": "x"})
    with pytest.raises(ValueError):
        bus.publish("x", {"no_type": True})
    with pytest.raises(ValueError):
        EventBus(capacity=0)


def test_concurrent_publishers_get_unique_contiguous_sequence_numbers():
    bus = EventBus(capacity=10_000)

    def worker(name):
        for _ in range(500):
            bus.publish(name, {"type": "tick"})

    threads = [threading.Thread(target=worker, args=(f"t{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    seqs = [s for s, _ in bus.since(0)]
    assert seqs == list(range(1, 4001))
