import pytest

from backend import router
from backend.permissions import Tier, default_policy


@pytest.mark.parametrize("text, action", [
    ("what time is it", "time.now"),
    ("What's the time?", "time.now"),
    ("what time is it right now please", "time.now"),
    ("what's the date today", "time.date"),
    ("What day is it?", "time.date"),
    ("system status", "status.read"),
    ("status report", "status.read"),
    ("show my folders", "files.roots"),
    ("list folders", "files.roots"),
    ("help", "help.list"),
    ("what can you do?", "help.list"),
    ("turn on my hands", "myhands.start"),
    ("Start hands tracking please", "myhands.start"),
    ("stop my hands", "myhands.stop"),
    ("turn off hands mode", "myhands.stop"),
])
def test_known_commands_match_their_action(text, action):
    m = router.match(text)
    assert m is not None and m.action == action


def test_open_takes_the_folder_name_in_lower_case():
    m = router.match("Open the folder Demo")
    assert m == router.Match("files.open_root", {"name": "demo"})
    assert router.match("open desktop please").args == {"name": "desktop"}


@pytest.mark.parametrize("text", [
    "tell me a joke",
    "what time is it in Tokyo",
    "open",
    "",
    "   ",
    "run rm -rf everything",
])
def test_anything_else_goes_to_gemini(text):
    assert router.match(text) is None


def test_punctuation_and_spacing_are_ignored():
    assert router.normalise("  What  TIME is it?!  ") == "what time is it"


def test_every_router_action_is_known_to_the_policy():
    known = {row["action"] for row in default_policy().table()}
    assert router.all_actions() <= known


def test_starting_the_camera_needs_confirmation_and_stopping_does_not():
    p = default_policy()
    assert p.tier_of("myhands.start") is Tier.CONFIRM
    assert p.tier_of("myhands.stop") is Tier.SAFE
