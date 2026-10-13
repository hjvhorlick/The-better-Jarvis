"""The Studio's routes, run through the real app.

These use the app the owner actually runs, so they prove the routes are wired
and answer, not just that the functions underneath work. The picture service is
faked: it is the one thing that needs the internet, and this sandbox has none.
"""
import base64

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.quota import DailyBudget

from tests.test_media import TINY_JPEG

LOCAL = "http://127.0.0.1:8765"

GOOD_SCRIPT = """{
  "title": "Why the ocean is salty",
  "title_variants": ["The salt in the sea"],
  "hook": "The sea is salty. Here is why.",
  "logline": "A short explainer on ocean salinity.",
  "shots": [
    {"narration": "The ocean covers most of the planet.",
     "on_screen": "71 percent", "image_prompt": "earth from space", "seconds": 5},
    {"narration": "Rivers carry salt into it.",
     "on_screen": "Rivers bring salt", "image_prompt": "a river meeting the sea", "seconds": 5}
  ],
  "description": "A short explainer.",
  "hashtags": ["ocean", "science"]
}"""


# The real maker, captured before any test can swap it out.
from backend.media import ImageMaker as RealImageMaker


class FakeMaker:
    """Stands in for the picture service: same answers, no network."""

    def __init__(self, store, fetch=None, timeout=90.0):
        self._inner = RealImageMaker(store, fetch=lambda url: (200, TINY_JPEG, "image/jpeg"))

    def make(self, **kw):
        return self._inner.make(**kw)


@pytest.fixture()
def app(tmp_path, monkeypatch):
    """The real app, with the picture service pointed at a fake and the library
    given a folder of its own, so a test never sees another test's pictures."""
    import backend.media as media_mod

    class StoreAt(media_mod.MediaStore):
        def __init__(self, root=None):
            super().__init__(tmp_path / "media")

    monkeypatch.setattr(media_mod, "MediaStore", StoreAt)
    monkeypatch.setattr(media_mod, "ImageMaker", FakeMaker)
    return create_app(serve_ui=False)


@pytest.fixture()
def client(app):
    return TestClient(app, base_url=LOCAL)


def test_the_studio_tells_you_what_it_can_do(client):
    r = client.get("/api/media/options")
    assert r.status_code == 200
    data = r.json()
    assert "9:16" in data["aspects"] and "16:9" in data["aspects"]
    assert "flux" in data["models"]
    assert data["scenering"] == "https://scenering.com"
    assert data["script_ready"] is True


def test_a_picture_can_be_made_and_read_back(client):
    r = client.post("/api/media/image", json={"prompt": "a red bicycle", "aspect": "9:16"})
    assert r.status_code == 200, r.text
    item = r.json()
    assert item["kind"] == "images"
    assert item["size"] == [720, 1280]

    got = client.get(item["url"])
    assert got.status_code == 200
    assert got.content.startswith(b"\xff\xd8\xff")


def test_a_picture_refusal_is_reported_not_saved(tmp_path, monkeypatch):
    """The app is built here rather than reused, because the maker is bound when
    the routes are registered — patching it afterwards would change nothing."""
    import backend.media as media_mod

    class Refusing:
        def __init__(self, *a, **k):
            pass

        def make(self, **kw):
            raise media_mod.MediaError("The picture service said no (429). rate limited")

    class StoreAt(media_mod.MediaStore):
        def __init__(self, root=None):
            super().__init__(tmp_path / "media")

    monkeypatch.setattr(media_mod, "MediaStore", StoreAt)
    monkeypatch.setattr(media_mod, "ImageMaker", Refusing)
    c = TestClient(create_app(serve_ui=False), base_url=LOCAL)

    r = c.post("/api/media/image", json={"prompt": "a cat"})
    assert r.status_code == 400
    assert "429" in r.json()["detail"]
    assert c.get("/api/media/library").json()["items"] == []


def test_the_library_lists_what_was_made(client):
    client.post("/api/media/image", json={"prompt": "a cat on a wall", "name": "Cat"})
    items = client.get("/api/media/library").json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "Cat"
    assert client.get("/api/media/library?q=boat").json()["items"] == []


def test_a_library_file_can_be_renamed_and_deleted(client):
    item = client.post("/api/media/image", json={"prompt": "a dog"}).json()
    r = client.patch(f"/api/media/file/images/{item['id']}", json={"name": "Rex"})
    assert r.status_code == 200 and r.json()["name"] == "Rex"
    assert client.delete(f"/api/media/file/images/{item['id']}").json()["removed"] is True
    assert client.get("/api/media/library").json()["items"] == []


def test_a_file_outside_the_library_cannot_be_read(client, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me", encoding="utf-8")
    for name in ("../secret.txt", "..%2Fsecret.txt", "/etc/passwd"):
        assert client.get(f"/api/media/file/images/{name}").status_code == 404, name


class ScriptedChat:
    def __init__(self):
        self.calls = []

    def complete(self, prompt, system, grounded=False):
        self.calls.append(prompt)
        return GOOD_SCRIPT


def test_a_script_is_written_and_counted():
    chat = ScriptedChat()
    budget = DailyBudget(20, path=None)
    app = create_app(serve_ui=False, chat_service=chat, budget=budget)
    c = TestClient(app, base_url=LOCAL)

    r = c.post("/api/media/script", json={"brief": "the ocean is salty", "seconds": 30})
    assert r.status_code == 200, r.text
    script = r.json()
    assert script["title"] == "Why the ocean is salty"
    assert len(script["shots"]) == 2
    assert len(chat.calls) == 1
    assert budget.snapshot()["used"] >= 1


def test_a_script_is_refused_while_offline_not_by_the_count():
    # The app's own count never blocks (0 is "never warn"); Google's 429 does.
    budget = DailyBudget(0, path=None)
    budget.mark_exhausted()
    app = create_app(serve_ui=False, budget=budget)
    c = TestClient(app, base_url=LOCAL)
    r = c.post("/api/media/script", json={"brief": "the ocean", "seconds": 30})
    assert r.status_code == 400
    assert "offline" in r.json()["detail"] and "needs the internet" in r.json()["detail"]


def test_an_empty_brief_is_refused_before_jarvis_is_asked():
    chat = ScriptedChat()
    app = create_app(serve_ui=False, chat_service=chat, budget=DailyBudget(20, path=None))
    c = TestClient(app, base_url=LOCAL)
    assert c.post("/api/media/script", json={"brief": "  "}).status_code == 400
    assert chat.calls == []


def test_a_script_can_be_laid_out_for_scenering(client):
    r = client.post("/api/media/scenering", json={
        "title": "Why the sea is salty",
        "shots": [{"narration": "The sea is salty.", "on_screen": "Salty", "seconds": 4}],
    })
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "Why the sea is salty"
    assert "1. The sea is salty." in data["script"]
    assert "[on screen: Salty]" in data["script"]
    assert data["url"] == "https://scenering.com"


def test_laying_out_nothing_is_refused(client):
    assert client.post("/api/media/scenering", json={"shots": []}).status_code == 400


def test_a_recorded_video_can_be_kept_in_the_library(client):
    """The browser records a WebM; this is how it lands in the library."""
    payload = {
        "kind": "video",
        "ext": ".webm",
        "data": base64.b64encode(b"RIFF____WEBMVPVP" + b"\x00" * 64).decode(),
        "name": "my first video",
    }
    r = client.post("/api/media/save", json=payload)
    assert r.status_code == 200, r.text
    item = r.json()
    assert item["kind"] == "video"
    assert client.get(item["url"]).status_code == 200
    kept = client.get("/api/media/library?kind=video").json()["items"]
    assert kept[0]["name"] == "my first video"


def test_an_unknown_file_kind_is_refused(client):
    r = client.post("/api/media/save", json={
        "kind": "video", "ext": ".exe",
        "data": base64.b64encode(b"MZ" + b"\x00" * 64).decode(),
    })
    assert r.status_code == 400
    assert "cannot keep" in r.json()["detail"]


def test_a_huge_file_is_refused(client):
    r = client.post("/api/media/save", json={
        "kind": "video", "ext": ".webm",
        "data": base64.b64encode(b"\x00" * (70 * 1024 * 1024)).decode(),
    })
    assert r.status_code == 400
    assert "over 64 MB" in r.json()["detail"]
