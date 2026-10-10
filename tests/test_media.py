"""The Studio backend: pictures from a free service, scripts from Jarvis, and a
library that keeps them.

The picture service needs no account and no key, so the tests here use a fake
fetch rather than the network: what is being checked is that a picture is asked
for correctly, stored correctly, and that a refusal is reported honestly instead
of being saved as a broken file.
"""
import json

import pytest

from backend import media
from backend.media import ImageMaker, MediaError, MediaStore, parse_script, scenering_payload


@pytest.fixture()
def store(tmp_path):
    return MediaStore(tmp_path / "media")


class FakeBudget:
    def __init__(self, allowed=True):
        self.allowed = allowed
        self.spent = 0

    def try_spend(self):
        if not self.allowed:
            return False
        self.spent += 1
        return True


class FakeChat:
    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    def complete(self, prompt, system, grounded=False):
        self.calls.append({"prompt": prompt, "system": system})
        return self.reply


# A real 1x1 JPEG, so the "is this actually a picture" check passes.
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb00430008060607060508070707"
    "0909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c28"
    "37"
) + b"\xffd9"


def make_maker(store, status=200, body=TINY_JPEG, ctype="image/jpeg"):
    seen = {}

    def fetch(url):
        seen["url"] = url
        return status, body, ctype

    return ImageMaker(store, fetch=fetch), seen


# ---------- pictures ----------

def test_a_picture_is_made_and_kept(store):
    maker, seen = make_maker(store)
    item = maker.make("a red bicycle in the rain", aspect="9:16")
    assert item["kind"] == "images"
    assert item["source"] == "pollinations"
    assert item["size"] == [720, 1280]
    assert item["url"].startswith("/api/media/file/images/")
    assert "a%20red%20bicycle" in seen["url"]
    assert "width=720" in seen["url"] and "height=1280" in seen["url"]
    # and it is really on disk
    assert store.path_for("images", item["id"]) is not None


def test_a_prompt_with_no_words_is_refused(store):
    maker, _ = make_maker(store)
    with pytest.raises(MediaError):
        maker.make("   ")


def test_an_unknown_shape_or_model_is_refused(store):
    maker, _ = make_maker(store)
    with pytest.raises(MediaError):
        maker.make("a cat", aspect="3:2")
    with pytest.raises(MediaError):
        maker.make("a cat", model="not-a-model")


def test_a_refusal_is_reported_not_saved(store):
    """A service that says no must not leave a broken file in the library."""
    maker, _ = make_maker(store, status=429, body=b'{"error":"rate limited"}',
                          ctype="application/json")
    with pytest.raises(MediaError) as e:
        maker.make("a cat")
    assert "429" in str(e.value)
    assert store.list(kind="images") == []


def test_an_unreachable_service_is_reported_plainly(store):
    def boom(url):
        raise OSError("no route to host")

    maker = ImageMaker(store, fetch=boom)
    with pytest.raises(MediaError) as e:
        maker.make("a cat")
    assert "internet" in str(e.value)


def test_the_same_seed_gives_the_same_picture(store):
    maker, seen = make_maker(store)
    a = maker.make("a cat", seed=4242)
    b = maker.make("a cat", seed=4242)
    assert a["id"] != b["id"]            # a new file each time
    assert "seed=4242" in seen["url"]    # but the same picture was asked for


# ---------- the library ----------

def test_the_library_remembers_what_it_holds(store):
    maker, _ = make_maker(store)
    maker.make("a cat on a wall", name="Cat")
    items = store.list()
    assert len(items) == 1
    assert items[0]["name"] == "Cat"
    assert items[0]["prompt"] == "a cat on a wall"


def test_the_library_can_be_searched(store):
    maker, _ = make_maker(store)
    maker.make("a cat on a wall")
    maker.make("a dog in a boat")
    assert len(store.list(search="cat")) == 1
    assert len(store.list(search="boat")) == 1
    assert len(store.list(search="zzz")) == 0


def test_a_library_file_cannot_be_reached_from_outside(store, tmp_path):
    """A name from a request must not be able to name anything else on disk."""
    outside = tmp_path / "secret.txt"
    outside.write_text("do not serve me", encoding="utf-8")
    assert store.path_for("images", "../secret.txt") is None
    assert store.path_for("images", "/etc/passwd") is None
    assert store.path_for("images", "..") is None
    assert store.path_for("nonsense", "x.png") is None


def test_a_file_can_be_renamed_tagged_and_removed(store):
    maker, _ = make_maker(store)
    item = maker.make("a cat")
    assert store.rename("images", item["id"], "Whiskers")["name"] == "Whiskers"
    assert store.tag("images", item["id"], ["pets", "cat"])["tags"] == ["pets", "cat"]
    assert store.remove("images", item["id"]) is True
    assert store.list() == []
    assert store.remove("images", item["id"]) is False


def test_counts_report_what_is_in_the_library(store):
    maker, _ = make_maker(store)
    maker.make("a cat")
    maker.make("a dog")
    assert store.counts() == {"images": 2, "video": 0, "audio": 0}


# ---------- scripts ----------

GOOD_SCRIPT = json.dumps({
    "title": "Why the ocean is salty",
    "title_variants": ["The salt in the sea", "Where ocean salt comes from"],
    "hook": "The sea is salty. Here is why.",
    "logline": "A short explainer on ocean salinity.",
    "shots": [
        {"narration": "The ocean covers most of the planet.",
         "on_screen": "71 percent", "image_prompt": "earth from space, blue ocean", "seconds": 5},
        {"narration": "Rivers carry salt into it, and the sun takes the water back.",
         "on_screen": "Rivers bring salt", "image_prompt": "a river meeting the sea", "seconds": 5},
    ],
    "description": "A short explainer.",
    "hashtags": ["ocean", "science"],
})


def test_a_good_script_comes_back_usable():
    script = parse_script(GOOD_SCRIPT, 30)
    assert script["title"] == "Why the ocean is salty"
    assert len(script["shots"]) == 2
    assert script["seconds"] > 0
    assert script["words"] > 0
    assert script["hashtags"] == ["ocean", "science"]


def test_shot_times_are_corrected_to_the_length_asked_for():
    script = parse_script(GOOD_SCRIPT, 60)
    assert script["seconds"] == 60
    assert sum(s["seconds"] for s in script["shots"]) == 60


def test_a_script_wrapped_in_chatter_is_still_read():
    wrapped = f"Sure! Here you go:\n{GOOD_SCRIPT}\nHope that helps."
    assert parse_script(wrapped, 20)["title"] == "Why the ocean is salty"


def test_a_script_with_single_quotes_is_still_read():
    sloppy = GOOD_SCRIPT.replace('"', "'")
    assert parse_script(sloppy, 20)["title"] == "Why the ocean is salty"


def test_a_script_with_no_shots_is_refused():
    with pytest.raises(MediaError):
        parse_script('{"title": "Nothing here"}', 20)


def test_a_reply_that_is_not_json_at_all_is_refused():
    with pytest.raises(MediaError):
        parse_script("I would rather not.", 20)


def test_a_shot_with_no_narration_is_dropped():
    data = json.loads(GOOD_SCRIPT)
    data["shots"].append({"narration": "", "image_prompt": "nothing"})
    assert len(parse_script(json.dumps(data), 20)["shots"]) == 2


# ---------- the Scenering hand-off ----------

def test_the_script_is_laid_out_for_scenering():
    script = parse_script(GOOD_SCRIPT, 20)
    payload = scenering_payload(script)
    assert payload["title"] == "Why the ocean is salty"
    assert payload["url"] == "https://scenering.com"
    assert payload["shots"] == 2
    assert payload["hook"] == "The sea is salty. Here is why."
    assert payload["description"] == "A short explainer."
    assert payload["hashtags"] == ["ocean", "science"]
    assert payload["title_variants"] == ["The salt in the sea", "Where ocean salt comes from"]
    assert payload["shot_details"][0] == {
        "narration": "The ocean covers most of the planet.",
        "on_screen": "71 percent",
        "image_prompt": "earth from space, blue ocean",
        "seconds": 5,
    }
    # every shot's narration is in the script, in order
    text = payload["script"]
    assert text.index("The ocean covers") < text.index("Rivers carry salt")
    assert "[on screen: 71 percent]" in text
    assert payload["plain"].startswith("Why the ocean is salty")


def test_nothing_is_uploaded_by_laying_a_script_out():
    """This only formats text. No network call is made anywhere in it."""
    script = parse_script(GOOD_SCRIPT, 20)
    assert scenering_payload(script)["script"]


def test_scenering_payload_tolerates_malformed_shot_metadata():
    payload = scenering_payload({
        "title": "Safe handoff",
        "shots": [
            {"narration": "A valid shot.", "seconds": "not-a-number"},
            None,
            {"narration": "", "seconds": 3},
        ],
    })
    assert payload["shots"] == 1
    assert payload["shot_details"][0]["seconds"] == 1
    assert payload["seconds"] == 1
    assert "A valid shot." in payload["script"]
    assert "not-a-number" not in payload["script"]


# ---------- budget ----------

def test_a_script_is_refused_once_the_day_is_spent():
    chat = FakeChat(GOOD_SCRIPT)
    budget = FakeBudget(allowed=False)
    with pytest.raises(MediaError) as e:
        media.script_from_brief(chat, budget, "the ocean", 30, "16:9")
    assert "allowance" in str(e.value)
    assert chat.calls == []            # nothing was asked


def test_a_script_costs_one_call():
    chat = FakeChat(GOOD_SCRIPT)
    budget = FakeBudget()
    media.script_from_brief(chat, budget, "the ocean", 30, "16:9")
    assert budget.spent == 1
    assert len(chat.calls) == 1


def test_an_empty_brief_is_refused_before_any_call():
    chat = FakeChat(GOOD_SCRIPT)
    budget = FakeBudget()
    with pytest.raises(MediaError):
        media.script_from_brief(chat, budget, "  ", 30, "16:9")
    assert chat.calls == []


def test_a_silly_length_is_refused():
    chat = FakeChat(GOOD_SCRIPT)
    with pytest.raises(MediaError):
        media.script_from_brief(chat, FakeBudget(), "the ocean", 2, "16:9")
