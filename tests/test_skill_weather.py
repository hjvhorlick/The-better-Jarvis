"""V2-5 slice 1: the skill pattern and the weather skill (ported from legacy weather_report).

No browser is opened in these tests. The agent gets a fake opener that records the URL.
"""
from datetime import datetime
from urllib.parse import parse_qs, urlparse

import pytest

from backend import router
from backend.agent import Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, Tier, default_policy
from backend.quota import DailyBudget
from backend.skills import ALL_SKILLS
from backend.skills import weather
from tests.test_chat import FakeClient, FakeModels

NOW = datetime(2026, 10, 9, 14, 5)


class Recorder:
    def __init__(self, result=True, error=None):
        self.urls, self.result, self.error = [], result, error

    def __call__(self, url):
        self.urls.append(url)
        if self.error:
            raise self.error
        return self.result


def _agent(tmp_path, opener):
    bus = EventBus()
    models = FakeModels(reply="Gemini says hello.")
    chat = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    budget = DailyBudget(20, path=tmp_path / "q.json", clock=lambda: NOW)
    confirmations = ConfirmationStore(bus=bus)
    agent = Agent(chat, budget, default_policy(), confirmations, bus=bus,
                  roots=lambda: [], clock=lambda: NOW, opener=opener)
    return agent, confirmations, models


# ----- router -----

@pytest.mark.parametrize("text, city", [
    ("weather in Johannesburg", "johannesburg"),
    ("what's the weather in New York today", "new york"),
    ("how's the weather for Benoni please", "benoni"),
])
def test_weather_question_carries_the_city(text, city):
    m = router.match(text)
    assert m is not None and m.action == "skill.weather"
    assert m.args == {"city": city}


@pytest.mark.parametrize("text", ["weather", "what's the weather", "weather in"])
def test_weather_without_a_city_is_not_a_local_skill(text):
    m = router.match(text)
    assert m is None or m.action != "skill.weather"


def test_existing_open_folder_still_gets_its_name_argument():
    assert router.match("Open the folder Demo").args == {"name": "demo"}


# ----- city validation and the search address -----

@pytest.mark.parametrize("raw", [None, "", "   ", 42])
def test_missing_or_non_text_city_is_refused(raw):
    with pytest.raises(weather.BadCity):
        weather.clean_city(raw)


def test_long_city_and_control_characters_are_refused():
    with pytest.raises(weather.BadCity):
        weather.clean_city("x" * 65)
    with pytest.raises(weather.BadCity):
        weather.clean_city("Benoni\x00")


def test_accented_city_is_kept():
    assert weather.clean_city("  São Paulo ") == "São Paulo"


def test_search_url_encodes_the_query_and_uses_the_search_page():
    url = weather.search_url("São Paulo")
    parsed = urlparse(url)
    assert parsed.netloc == "duckduckgo.com"
    assert parse_qs(parsed.query)["q"] == ["São Paulo weather today"]


# ----- policy -----

def test_weather_skill_is_confirm_and_registered():
    assert weather.SKILL in ALL_SKILLS
    assert default_policy().decide("skill.weather").needs_confirmation
    assert weather.SKILL.tier is Tier.CONFIRM


# ----- the agent end to end (fake browser) -----

def test_weather_waits_for_the_owner_then_opens_one_search(isolated):
    opener = Recorder()
    agent, confirmations, _ = _agent(isolated, opener)
    out = agent.handle("weather in Benoni")
    assert out["source"] == "confirmation" and out["intent"] == "skill.weather"
    assert opener.urls == []                                  # nothing opened yet
    done = confirmations.resolve(out["confirmation"]["id"], approve=True)
    assert done["status"] == "approved"
    assert len(opener.urls) == 1
    # The router lower-cases the text, as it does for every command. Search engines ignore case.
    assert parse_qs(urlparse(opener.urls[0]).query)["q"] == ["benoni weather today"]
    assert "benoni" in done["result"]


def test_weather_denied_opens_nothing(isolated):
    opener = Recorder()
    agent, confirmations, _ = _agent(isolated, opener)
    out = agent.handle("weather in Benoni")
    done = confirmations.resolve(out["confirmation"]["id"], approve=False)
    assert done["status"] == "denied" and opener.urls == []


def test_browser_refusal_is_reported_not_raised(isolated):
    opener = Recorder(result=False)
    agent, confirmations, _ = _agent(isolated, opener)
    out = agent.handle("weather in Benoni")
    done = confirmations.resolve(out["confirmation"]["id"], approve=True)
    assert done["status"] == "approved" and "did not accept" in done["result"]


def test_browser_exception_is_reported_not_raised(isolated):
    opener = Recorder(error=OSError("no display"))
    result = weather.run({"city": "Benoni"}, opener)
    assert "unable to open" in result["reply"] and "OSError" in result["reply"]


def test_bad_city_never_reaches_the_browser(isolated):
    opener = Recorder()
    result = weather.run({"city": "   "}, opener)
    assert opener.urls == [] and "which city" in result["reply"]
