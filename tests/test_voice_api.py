"""Voice over HTTP, chat commands, policy tiers and diagnostics. Real controller on fake audio."""
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.chat import ChatService
from backend.permissions import Tier, default_policy
from backend import router
from tests.test_agent import ROOTS, FakeSession
from tests.test_chat import FakeClient, FakeModels
from tests.test_voice_controller import FakeRelay, Rig, wait_until

LOCAL = "http://127.0.0.1:8765"


def _client(tmp_path, *, key=True, budget_limit=20, wake=(True, "ready"), mic_fail=None):
    rig = Rig(tmp_path, key="k" if key else None, budget_limit=budget_limit, wake=wake,
              mic_fail=mic_fail, fire_on=None)
    chat = ChatService(client_factory=lambda k: FakeClient(FakeModels(reply="pong")), model="t")
    app = create_app(chat, serve_ui=False, myhands_session=FakeSession(), bus=rig.bus,
                     devices=rig.devices, budget=rig.budget, voice=rig.ctrl, roots=lambda: ROOTS)
    client = TestClient(app, base_url=LOCAL)
    client.rig = rig
    return client


def approve(client, cid):
    return client.post(f"/api/confirmations/{cid}", json={"approve": True}).json()


# ----- HTTP routes -----

def test_status_shows_the_voice_state_and_wake_readiness(tmp_path):
    body = _client(tmp_path).get("/api/voice/status").json()
    assert body["live"] is False and body["muted"] is False
    assert body["wake"] == {"enabled": False, "available": True, "reason": "ready"}


def test_start_and_stop_by_button(tmp_path):
    c = _client(tmp_path)
    started = c.post("/api/voice/start").json()
    assert started["live"] is True and started["origin"] == "button"
    assert wait_until(lambda: FakeRelay.instances and FakeRelay.instances[-1].ran)
    stopped = c.post("/api/voice/stop").json()
    assert stopped["live"] is False


def test_start_without_a_key_is_503(tmp_path):
    r = _client(tmp_path, key=False).post("/api/voice/start")
    assert r.status_code == 503 and "API key" in r.json()["detail"]


def test_start_while_offline_is_503_and_points_at_the_local_voice(tmp_path):
    # The app's own count never blocks; Google's 429 makes the server voice
    # unavailable — and the LOCAL voice is the honest alternative to name.
    client = _client(tmp_path)
    client.rig.budget.mark_exhausted()
    r = client.post("/api/voice/start")
    assert r.status_code == 503
    assert "offline" in r.json()["detail"] and "LOCAL voice" in r.json()["detail"]


def test_start_with_no_audio_device_is_503_and_says_why(tmp_path):
    from backend.voice.audio import AudioUnavailable
    r = _client(tmp_path, mic_fail=AudioUnavailable("PortAudio library not found")).post("/api/voice/start")
    assert r.status_code == 503 and "PortAudio" in r.json()["detail"]


def test_mute_and_unmute(tmp_path):
    c = _client(tmp_path)
    assert c.post("/api/voice/mute", json={"muted": True}).json()["muted"] is True
    assert c.post("/api/voice/mute", json={"muted": False}).json()["muted"] is False


def test_mute_needs_a_boolean(tmp_path):
    assert _client(tmp_path).post("/api/voice/mute", json={}).status_code == 422


def test_turning_wake_off_is_immediate(tmp_path):
    c = _client(tmp_path)
    c.rig.ctrl.set_wake(True)
    body = c.post("/api/voice/wake", json={"enabled": False}).json()
    assert body["wake"]["enabled"] is False and "confirmation" not in body


def test_turning_wake_on_waits_for_the_owner(tmp_path):
    c = _client(tmp_path)
    body = c.post("/api/voice/wake", json={"enabled": True}).json()
    assert body["confirmation"]["action"] == "voice.wake"
    assert c.rig.ctrl.status()["wake"]["enabled"] is False          # not yet
    assert c.rig.detectors == []                                    # not even loaded
    answer = approve(c, body["confirmation"]["id"])
    assert answer["status"] == "approved"
    assert c.rig.ctrl.status()["wake"]["enabled"] is True
    c.rig.ctrl.close()


def test_denying_wake_leaves_it_off(tmp_path):
    c = _client(tmp_path)
    cid = c.post("/api/voice/wake", json={"enabled": True}).json()["confirmation"]["id"]
    c.post(f"/api/confirmations/{cid}", json={"approve": False})
    assert c.rig.ctrl.status()["wake"]["enabled"] is False


def test_wake_on_when_the_model_is_missing_is_409_and_asks_nothing(tmp_path):
    c = _client(tmp_path, wake=(False, "wake word model not downloaded yet"))
    r = c.post("/api/voice/wake", json={"enabled": True})
    assert r.status_code == 409 and "not downloaded" in r.json()["detail"]
    assert c.get("/api/confirmations").json()["pending"] == []


def test_voice_routes_refuse_a_foreign_host(tmp_path):
    rig = _client(tmp_path).rig
    chat = ChatService(client_factory=lambda k: FakeClient(FakeModels(reply="pong")), model="t")
    app = create_app(chat, serve_ui=False, myhands_session=FakeSession(), bus=rig.bus,
                     devices=rig.devices, budget=rig.budget, voice=rig.ctrl, roots=lambda: ROOTS)
    foreign = TestClient(app, base_url="http://evil.example")
    assert foreign.get("/api/voice/status").status_code != 200
    assert foreign.post("/api/voice/start").status_code != 200
    assert rig.ctrl.live is False


# ----- chat commands and their tiers -----

def test_say_start_voice_asks_first_then_starts(tmp_path):
    c = _client(tmp_path)
    body = c.post("/api/chat", json={"text": "start voice"}).json()
    assert body["source"] == "confirmation" and body["intent"] == "voice.start"
    assert c.rig.ctrl.live is False
    assert approve(c, body["confirmation"]["id"])["status"] == "approved"
    assert c.rig.ctrl.live is True
    c.rig.ctrl.close()


def test_say_mute_the_mic_is_immediate(tmp_path):
    c = _client(tmp_path)
    body = c.post("/api/chat", json={"text": "mute the mic"}).json()
    assert body["source"] == "local" and body["intent"] == "voice.mute"
    assert c.rig.ctrl.status()["muted"] is True
    body = c.post("/api/chat", json={"text": "unmute my microphone"}).json()
    assert body["intent"] == "voice.unmute" and c.rig.ctrl.status()["muted"] is False


def test_say_stop_voice_is_immediate(tmp_path):
    c = _client(tmp_path)
    c.post("/api/voice/start")
    body = c.post("/api/chat", json={"text": "stop voice"}).json()
    assert body["source"] == "local" and body["intent"] == "voice.stop"
    assert c.rig.ctrl.live is False


def test_say_turn_on_wake_word_asks_first(tmp_path):
    c = _client(tmp_path)
    body = c.post("/api/chat", json={"text": "turn on the wake word"}).json()
    assert body["source"] == "confirmation" and body["intent"] == "voice.wake"
    approve(c, body["confirmation"]["id"])
    assert c.rig.ctrl.status()["wake"]["enabled"] is True
    c.rig.ctrl.close()


def test_say_turn_off_wake_word_is_immediate(tmp_path):
    c = _client(tmp_path)
    c.rig.ctrl.set_wake(True)
    body = c.post("/api/chat", json={"text": "stop the wake word"}).json()
    assert body["source"] == "local" and body["intent"] == "voice.wake_off"
    assert c.rig.ctrl.status()["wake"]["enabled"] is False


def test_voice_tiers_match_the_owner_rule():
    p = default_policy()
    assert p.tier_of("voice.start") is Tier.CONFIRM
    assert p.tier_of("voice.wake") is Tier.CONFIRM
    assert p.tier_of("voice.stop") is Tier.SAFE
    assert p.tier_of("voice.mute") is Tier.SAFE
    assert p.tier_of("voice.unmute") is Tier.SAFE
    assert p.tier_of("voice.wake_off") is Tier.SAFE


def test_every_voice_rule_names_a_registered_action():
    actions = router.all_actions()
    voice_actions = {a for a in actions if a.startswith("voice.")}
    assert voice_actions == {"voice.start", "voice.stop", "voice.mute", "voice.unmute",
                             "voice.wake", "voice.wake_off", "voice.test"}
    p = default_policy()
    assert all(p.tier_of(a) is not Tier.BLOCKED for a in voice_actions)


@pytest.mark.parametrize("text, action", [
    ("start voice", "voice.start"),
    ("turn on the voice chat please", "voice.start"),
    ("stop voice mode", "voice.stop"),
    ("mute my microphone", "voice.mute"),
    ("unmute the mic", "voice.unmute"),
    ("turn on wake word listening", "voice.wake"),
    ("disable the wake word", "voice.wake_off"),
])
def test_voice_phrases_route_locally(text, action):
    m = router.match(text)
    assert m is not None and m.action == action


@pytest.mark.parametrize("text", ["what is the voice of reason", "start my hands", "mute"])
def test_ordinary_sentences_are_not_taken_as_voice_commands(text):
    m = router.match(text)
    assert m is None or not m.action.startswith("voice.")


# ----- diagnostics -----

def test_diagnostics_includes_voice_and_voice_faults_show_as_problems(tmp_path):
    c = _client(tmp_path, key=False)
    c.post("/api/voice/start")                       # refused: no key on this server
    c.rig.bus.publish("voice", {"type": "voice_error", "reason": "connection", "message": "ConnectionError"})
    body = c.get("/api/diagnostics").json()
    assert body["voice"]["live"] is False and "wake" in body["voice"]
    assert any(p["type"] == "voice_error" for p in body["recent_problems"])


def test_diagnostics_never_shows_the_gemini_key(tmp_path):
    c = _client(tmp_path)
    assert "k" == c.rig.key                          # the fixture key is the short test value
    secret = "voice-secret-key-do-not-show-42"
    c.rig.key = secret
    assert secret not in c.get("/api/diagnostics").text
    assert secret not in c.get("/api/voice/status").text
