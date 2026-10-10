"""Weather (V2-5). Ported from the legacy `actions/weather_report.py` (feature: weather report).

Behaviour kept: the owner asks for the weather in a city, and the computer opens a web search
for it. The legacy code used a Google search URL. This version uses DuckDuckGo's search page.
It does not fetch a forecast itself, as before.

Tier: CONFIRM. Opening a browser tab is a side effect on the computer, so each run needs the
owner's OK. The browser never opens a tab by itself.
"""
from __future__ import annotations

from urllib.parse import quote_plus

from ..permissions import Tier
from .base import Skill

SEARCH_URL = "https://duckduckgo.com/?q={query}"
MAX_CITY_CHARS = 64
ACTION = "skill.weather"


class BadCity(ValueError):
    """The city text is empty, too long, or contains control characters."""


def clean_city(raw) -> str:
    if not isinstance(raw, str):
        raise BadCity("Sir, which city should I check the weather for?")
    city = raw.strip()
    if not city:
        raise BadCity("Sir, which city should I check the weather for?")
    if len(city) > MAX_CITY_CHARS:
        raise BadCity("Sir, that city name is too long.")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in city):
        raise BadCity("Sir, that city name contains characters I cannot use.")
    return city


def search_query(city: str, when: str = "today") -> str:
    return f"{city} weather {when}"


def search_url(city: str, when: str = "today") -> str:
    return SEARCH_URL.format(query=quote_plus(search_query(city, when)))


def summary(args: dict) -> str:
    city = args.get("city") or "that city"
    return f"Open a weather search for {city} in the browser on this computer."


def run(args: dict, opener) -> dict:
    """Open the search. `opener` is webbrowser.open or a stand-in. Returns {"reply": ...}."""
    try:
        city = clean_city(args.get("city"))
    except BadCity as e:
        return {"reply": str(e)}
    url = search_url(city)
    try:
        opened = opener(url)
    except Exception as e:
        return {"reply": f"Sir, I was unable to open a browser tab for that search ({type(e).__name__})."}
    if not opened:
        return {"reply": "Sir, the browser did not accept the weather search. Please check it on this computer."}
    return {"reply": f"Weather search for {city} is open in your browser, sir."}


SKILL = Skill(action=ACTION, tier=Tier.CONFIRM, summary=summary, handler=run)
