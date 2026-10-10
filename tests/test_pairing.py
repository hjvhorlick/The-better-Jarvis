"""Phone pairing (V2-6): the code, the token, what a phone may call, and the chat commands.

No network is used. A phone is simulated by a TestClient whose Host header is a home-network
address (192.168.x.x). The pairing clock is a fake, so expiry is tested without waiting.
"""
import json

import pytest
from fastapi.testclient import TestClient

from backend import pairing, security
from backend.app import create_app
from backend.chat import ChatService
from backend.pairing import PairingError, PairingStore
from tests.test_chat import FakeClient, FakeModels

PHONE = "http://192.168.1.20:8765"
LOCAL = "http://127.0.0.1:8765"


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def pairing_on(monkeypatch):
    monkeypatch.setenv("SUPPER_PAIRING", "on")
    monkeypatch.delenv("SUPPER_EXTRA_HOSTS", raising=False)


@pytest.fixture
def store(tmp_path):
    return PairingStore(tmp_path / "paired_devices.json", clock=Clock())


def _client(store, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    svc = ChatService(client_factory=lambda key: FakeClient(FakeModels()), model="x")
    return TestClient(create_app(svc, serve_ui=False, pairing_store=store), base_url=LOCAL)


# ----- the code and the token (the store) -----

def test_a_code_is_six_digits_and_works_once(store):
    code = store.start_code()["code"]
    assert len(code) == 6 and code.isdigit()
    token, device = store.claim(code, "Thandi's phone")
    assert device["label"] == "Thandis phone"          # quotes removed from the name
    assert store.verify(token) is True
    with pytest.raises(PairingError):
        store.claim(code)                        # used up


def test_a_wrong_code_is_counted_and_five_cancel_it(store):
    code = store.start_code()["code"]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(4):
        with pytest.raises(PairingError, match="not right"):
            store.claim(wrong)
    with pytest.raises(PairingError, match="Too many wrong"):
        store.claim(wrong)
    with pytest.raises(PairingError, match="expired or was not started"):
        store.claim(code)                        # the right code no longer works either


def test_a_code_expires_after_five_minutes(tmp_path):
    clock = Clock()
    s = PairingStore(tmp_path / "p.json", clock=clock)
    code = s.start_code()["code"]
    clock.t += pairing.CODE_SECONDS + 1
    with pytest.raises(PairingError, match="expired"):
        s.claim(code)


def test_a_new_code_replaces_the_old_one(store):
    first = store.start_code()["code"]
    second = store.start_code()["code"]
    if first != second:
        with pytest.raises(PairingError):
            store.claim(first)
    store.claim(second)


def test_only_a_hash_of_the_token_is_stored(store, tmp_path):
    token, _ = store.claim(store.start_code()["code"])
    raw = (tmp_path / "paired_devices.json").read_text(encoding="utf-8")
    assert token not in raw and "token_hash" in raw
    assert json.loads(raw)["devices"][0]["token_hash"] != token


def test_a_token_expires_after_thirty_days(tmp_path):
    clock = Clock()
    s = PairingStore(tmp_path / "p.json", clock=clock)
    token, _ = s.claim(s.start_code()["code"])
    clock.t += pairing.TOKEN_SECONDS + 1
    assert s.verify(token) is False


def test_forgetting_a_phone_cuts_its_access(store):
    token, _ = store.claim(store.start_code()["code"])
    assert store.revoke(1) is not None
    assert store.verify(token) is False
    assert store.revoke(1) is None


def test_the_device_list_has_no_tokens(store):
    store.claim(store.start_code()["code"], "Phone A")
    listed = store.devices()
    assert listed[0]["number"] == 1 and listed[0]["label"] == "Phone A"
    assert "token_hash" not in listed[0]


def test_a_full_list_refuses_another_phone(store):
    for _ in range(pairing.MAX_DEVICES):
        store.claim(store.start_code()["code"])
    with pytest.raises(PairingError, match="most phones"):
        store.claim(store.start_code()["code"])


def test_the_setting_is_off_unless_switched_on(monkeypatch):
    monkeypatch.delenv("SUPPER_PAIRING", raising=False)
    assert pairing.enabled() is False
    monkeypatch.setenv("SUPPER_PAIRING", "on")
    assert pairing.enabled() is True


# ----- what a phone may reach (the guard) -----

def test_a_home_network_address_is_a_phone_address_but_a_name_is_not():
    assert security.private_address("192.168.1.20:8765")
    assert security.private_address("10.0.0.5")
    assert not security.private_address("evil.example:8765")
    assert not security.private_address("192.168.1.20.evil.com")
    assert not security.private_address("127.0.0.1:8765")
    assert not security.private_address("8.8.8.8")


def test_phone_refused_while_pairing_is_off(store, monkeypatch):
    monkeypatch.delenv("SUPPER_PAIRING", raising=False)
    c = _client(store, monkeypatch)
    for path in ("/pair", "/api/status", "/api/chat"):
        r = c.get(path, headers={"host": "192.168.1.20:8765"}) if path != "/api/chat" else c.post(
            path, json={"text": "what time is it"}, headers={"host": "192.168.1.20:8765"})
        assert r.status_code == 403, path


def test_the_pairing_page_and_the_claim_are_open_to_a_phone_without_a_token(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    code = store.start_code()["code"]
    page = c.get("/pair", headers={"host": "192.168.1.20:8765"})
    assert page.status_code == 200 and "Pair this phone" in page.text
    bad = c.post("/api/pairing/claim", json={"code": "000001"} if code != "000001" else {"code": "000002"},
                 headers={"host": "192.168.1.20:8765", "origin": PHONE})
    assert bad.status_code == 403
    ok = c.post("/api/pairing/claim", json={"code": code, "label": "Phone"},
                headers={"host": "192.168.1.20:8765", "origin": PHONE})
    assert ok.status_code == 200 and ok.json()["ok"] is True
    cookie = ok.headers["set-cookie"]
    assert "jarvis_device=" in cookie and "HttpOnly" in cookie and "samesite=strict" in cookie.lower()


def _paired(store, monkeypatch):
    c = _client(store, monkeypatch)
    token, _ = store.claim(store.start_code()["code"], "Phone")
    return c, token


def test_a_paired_phone_may_chat_and_read_status(pairing_on, store, monkeypatch):
    c, token = _paired(store, monkeypatch)
    h = {"host": "192.168.1.20:8765", "origin": PHONE, "cookie": f"jarvis_device={token}"}
    assert c.get("/api/status", headers=h).status_code == 200
    assert c.get("/api/confirmations", headers=h).status_code == 200
    assert c.get("/api/voice/status", headers=h).status_code == 200
    assert c.get("/api/myhands/status", headers=h).status_code == 200
    chat = c.post("/api/chat", json={"text": "what time is it"}, headers=h)
    assert chat.status_code == 200 and chat.json()["source"] == "local"
    assert c.get("/", headers=h).status_code in (200, 404)     # the page itself is allowed (404 only: no UI mounted here)


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/confirmations/abc"),        # approving needs the owner's permission (see the approval tests below)
    ("GET", "/api/files/roots"),
    ("GET", "/api/files/list?path=/"),
    ("GET", "/api/memory/summary"),
    ("POST", "/api/myhands/start"),
    ("PUT", "/api/myhands/scene"),
    ("POST", "/api/voice/start"),
    ("DELETE", "/api/chat"),
])
def test_a_paired_phone_may_not_reach_sensitive_routes(pairing_on, store, monkeypatch, method, path):
    c, token = _paired(store, monkeypatch)
    h = {"host": "192.168.1.20:8765", "origin": PHONE, "cookie": f"jarvis_device={token}"}
    r = c.request(method, path, headers=h, json={"approve": True} if method == "POST" else None)
    assert r.status_code in (403, 404, 405), (method, path, r.status_code)
    assert r.status_code != 200


def test_a_phone_with_a_forgotten_token_is_refused(pairing_on, store, monkeypatch):
    c, token = _paired(store, monkeypatch)
    store.revoke(1)
    h = {"host": "192.168.1.20:8765", "origin": PHONE, "cookie": f"jarvis_device={token}"}
    assert c.get("/api/status", headers=h).status_code == 403


def test_a_page_from_another_site_cannot_use_a_phone_token(pairing_on, store, monkeypatch):
    c, token = _paired(store, monkeypatch)
    h = {"host": "192.168.1.20:8765", "origin": "http://evil.example", "cookie": f"jarvis_device={token}"}
    assert c.post("/api/chat", json={"text": "time"}, headers=h).status_code == 403


def test_a_name_in_the_host_header_is_refused_even_with_a_token(pairing_on, store, monkeypatch):
    c, token = _paired(store, monkeypatch)
    h = {"host": "192.168.1.20.evil.com:8765", "cookie": f"jarvis_device={token}"}
    assert c.get("/api/status", headers=h).status_code == 403


def test_this_computer_keeps_full_access(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    assert c.get("/api/files/roots", headers={"host": "127.0.0.1:8765"}).status_code == 200
    assert c.get("/api/myhands/status", headers={"host": "127.0.0.1:8765"}).status_code == 200


# ----- the chat commands -----

def test_pair_my_phone_while_off_says_how_and_asks_nothing(store, monkeypatch):
    monkeypatch.delenv("SUPPER_PAIRING", raising=False)
    c = _client(store, monkeypatch)
    r = c.post("/api/chat", json={"text": "pair my phone"}).json()
    assert r["source"] == "local" and r["confirmation"] is None
    assert "SUPPER_PAIRING=on" in r["reply"]


def test_pair_my_phone_asks_first_then_shows_a_code_here(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    asked = c.post("/api/chat", json={"text": "pair my phone"}).json()
    assert asked["source"] == "confirmation" and asked["intent"] == "pairing.start"
    cid = asked["confirmation"]["id"]
    done = c.post(f"/api/confirmations/{cid}", json={"approve": True}).json()
    assert done["status"] == "approved"
    code = [w for w in done["result"].split() if w.strip(".").isdigit() and len(w.strip(".")) == 6][0].strip(".")
    assert len(code) == 6
    token, _ = store.claim(code)                         # the code shown is the one that works
    assert store.verify(token)


def test_a_denied_pairing_creates_no_code(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    cid = c.post("/api/chat", json={"text": "pair my phone"}).json()["confirmation"]["id"]
    c.post(f"/api/confirmations/{cid}", json={"approve": False})
    with pytest.raises(PairingError, match="expired or was not started"):
        store.claim("123456")


def test_list_and_forget_phones_by_chat(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    assert c.post("/api/chat", json={"text": "list phones"}).json()["reply"] == "No phones are paired."
    token, _ = store.claim(store.start_code()["code"], "Kitchen phone")
    listed = c.post("/api/chat", json={"text": "list phones"}).json()["reply"]
    assert "Kitchen phone" in listed
    gone = c.post("/api/chat", json={"text": "forget phone 1"}).json()
    assert "forgotten" in gone["reply"] and gone["source"] == "local"
    assert store.verify(token) is False


# ----- letting a phone approve (the owner's permission) -----

def _client_with_opener(store, monkeypatch, opened):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    svc = ChatService(client_factory=lambda key: FakeClient(FakeModels()), model="x")
    return TestClient(create_app(svc, serve_ui=False, pairing_store=store, opener=opened.append),
                     base_url=LOCAL)


def _phone_headers(token):
    return {"host": "192.168.1.20:8765", "origin": PHONE, "cookie": f"jarvis_device={token}"}


def test_a_new_phone_cannot_approve_until_the_owner_allows_it(store):
    token, device = store.claim(store.start_code()["code"], "Phone")
    assert device["may_approve"] is False
    assert store.device(token)["may_approve"] is False


def test_the_owner_can_allow_and_take_back_approval(store, tmp_path):
    token, _ = store.claim(store.start_code()["code"], "Phone")
    assert store.set_approve(1, True)["may_approve"] is True
    assert store.device(token)["may_approve"] is True
    again = PairingStore(tmp_path / "paired_devices.json", clock=Clock())   # survives a restart
    assert again.device(token)["may_approve"] is True
    assert store.set_approve(1, False)["may_approve"] is False
    assert store.device(token)["may_approve"] is False
    assert store.set_approve(9, True) is None                                # no such phone


def test_only_an_allowed_phone_may_call_the_confirm_route():
    assert security.phone_may_call("http", "POST", "/api/confirmations/abc123", True, may_approve=True)
    assert not security.phone_may_call("http", "POST", "/api/confirmations/abc123", True, may_approve=False)
    assert not security.phone_may_call("http", "POST", "/api/confirmations/abc123", False, may_approve=True)
    assert not security.phone_may_call("http", "POST", "/api/confirmations/a/b", True, may_approve=True)
    assert security.phone_may_call("http", "GET", "/api/confirmations", True)      # the list is always fine


def test_an_allowed_phone_approves_an_action_and_the_reply_names_it(pairing_on, store, monkeypatch):
    opened = []
    c = _client_with_opener(store, monkeypatch, opened)
    token, _ = store.claim(store.start_code()["code"], "Kitchen phone")
    store.set_approve(1, True)
    asked = c.post("/api/chat", json={"text": "weather in Johannesburg"}, headers=_phone_headers(token)).json()
    assert asked["source"] == "confirmation"
    cid = asked["confirmation"]["id"]
    done = c.post(f"/api/confirmations/{cid}", json={"approve": True}, headers=_phone_headers(token)).json()
    assert done["status"] == "approved" and done["by"] == "Kitchen phone"
    assert opened, "the approved action should have run on this computer"


def test_a_phone_without_approval_is_refused_when_it_tries(pairing_on, store, monkeypatch):
    opened = []
    c = _client_with_opener(store, monkeypatch, opened)
    token, _ = store.claim(store.start_code()["code"], "Phone")
    cid = c.post("/api/chat", json={"text": "weather in Johannesburg"}).json()["confirmation"]["id"]
    r = c.post(f"/api/confirmations/{cid}", json={"approve": True}, headers=_phone_headers(token))
    assert r.status_code == 403 and not opened


def test_taking_approval_away_stops_the_phone_at_once(pairing_on, store, monkeypatch):
    opened = []
    c = _client_with_opener(store, monkeypatch, opened)
    token, _ = store.claim(store.start_code()["code"], "Phone")
    store.set_approve(1, True)
    cid = c.post("/api/chat", json={"text": "weather in Johannesburg"}).json()["confirmation"]["id"]
    store.set_approve(1, False)
    r = c.post(f"/api/confirmations/{cid}", json={"approve": True}, headers=_phone_headers(token))
    assert r.status_code == 403 and not opened


def test_even_an_allowed_phone_cannot_approve_a_request_to_pair_a_phone(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    token, _ = store.claim(store.start_code()["code"], "Phone")
    store.set_approve(1, True)
    cid = c.post("/api/chat", json={"text": "pair my phone"}).json()["confirmation"]["id"]
    r = c.post(f"/api/confirmations/{cid}", json={"approve": True}, headers=_phone_headers(token))
    assert r.status_code == 403 and "Use this computer" in r.json()["detail"]
    still = [p["id"] for p in c.get("/api/confirmations").json()["pending"]]
    assert cid in still                                     # the refused request stays for the computer


def test_an_allowed_phone_cannot_grant_approval_to_another_phone(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    token, _ = store.claim(store.start_code()["code"], "Phone")
    store.set_approve(1, True)
    cid = c.post("/api/chat", json={"text": "let phone 1 approve"}).json()["confirmation"]["id"]
    r = c.post(f"/api/confirmations/{cid}", json={"approve": True}, headers=_phone_headers(token))
    assert r.status_code == 403
    assert store.devices()[0]["may_approve"] is True          # unchanged by the refused attempt


@pytest.mark.parametrize("text,number", [
    ("let phone 2 approve", "2"),
    ("allow phone 2 to approve", "2"),
    ("give my phone 2 permission to approve", "2"),
    ("let the phone 3 approve actions", "3"),
])
def test_the_chat_understands_letting_a_phone_approve(text, number):
    from backend import router
    m = router.match(text)
    assert m is not None and m.action == "pairing.approve" and m.args["number"] == number


@pytest.mark.parametrize("text,number", [
    ("stop phone 2 approving", "2"),
    ("take away phone 2 approval", "2"),
    ("phone 2 cannot approve", "2"),
    ("phone 2 can't approve", "2"),
])
def test_the_chat_understands_taking_approval_back(text, number):
    from backend import router
    m = router.match(text)
    assert m is not None and m.action == "pairing.unapprove" and m.args["number"] == number


def test_letting_a_phone_approve_asks_first_then_takes_effect(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    token, _ = store.claim(store.start_code()["code"], "Kitchen phone")
    asked = c.post("/api/chat", json={"text": "let phone 1 approve"}).json()
    assert asked["source"] == "confirmation" and asked["intent"] == "pairing.approve"
    assert "Kitchen phone" in asked["reply"]
    assert store.devices()[0]["may_approve"] is False                  # nothing yet
    done = c.post(f"/api/confirmations/{asked['confirmation']['id']}", json={"approve": True}).json()
    assert done["status"] == "approved" and "can now approve" in done["result"]
    assert store.devices()[0]["may_approve"] is True


def test_taking_approval_back_is_immediate_and_needs_no_confirmation(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    store.claim(store.start_code()["code"], "Phone")
    store.set_approve(1, True)
    r = c.post("/api/chat", json={"text": "stop phone 1 approving"}).json()
    assert r["source"] == "local" and r["confirmation"] is None
    assert store.devices()[0]["may_approve"] is False


def test_the_phone_list_says_which_phones_can_approve(pairing_on, store, monkeypatch):
    c = _client(store, monkeypatch)
    store.claim(store.start_code()["code"], "Kitchen phone")
    store.set_approve(1, True)
    assert "Kitchen phone (last seen" in c.post("/api/chat", json={"text": "list phones"}).json()["reply"]
    assert "can approve" in c.post("/api/chat", json={"text": "list phones"}).json()["reply"]


def test_approval_commands_while_pairing_is_off_say_how_to_turn_it_on(store, monkeypatch):
    monkeypatch.delenv("SUPPER_PAIRING", raising=False)
    c = _client(store, monkeypatch)
    r = c.post("/api/chat", json={"text": "let phone 1 approve"}).json()
    assert r["confirmation"] is None and "SUPPER_PAIRING=on" in r["reply"]
