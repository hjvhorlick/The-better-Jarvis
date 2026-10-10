"""Local intent router: answers everyday commands itself, before any call to Gemini.

A command that matches no rule is not handled here. It goes on to Gemini. Every rule
names an action in the permission policy (backend/permissions.py), so a rule can never
run something the policy does not allow. Matching is plain pattern matching, English
only for now. Other languages will go to Gemini until they get their own rules.

Provenance: the approach (local rules before the language model) follows the idea in
Home Assistant's Assist pipeline (prefer_local_intents). The rules and code here are
written for this project. No code or text taken from Home Assistant.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Optional courtesy words that may follow a command.
_TAIL = r"(?: please| now| right now| today)*"

_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(what time is it|what'?s the time|what is the time|tell me the time|current time|time)" + _TAIL),
     "time.now"),
    (re.compile(r"(what'?s today'?s date|what is today'?s date|what'?s the date|what is the date|"
                r"what day is it|today'?s date|what'?s the day)" + _TAIL),
     "time.date"),
    (re.compile(r"(system )?status( report)?" + _TAIL), "status.read"),
    (re.compile(r"(show|list)( me)?( my| the)?( allowed| shared)? folders" + _TAIL), "files.roots"),
    (re.compile(r"open( the)?( folder)?\s+(?P<name>.{1,64}?)" + _TAIL), "files.open_root"),
    (re.compile(r"(start|turn on|enable|switch on)( my)? hands( mode| tracking)?" + _TAIL), "myhands.start"),
    (re.compile(r"(stop|turn off|disable|switch off)( my)? hands( mode| tracking)?" + _TAIL), "myhands.stop"),
    (re.compile(r"(start|turn on|enable|switch on)( the| my)? voice( mode| chat)?" + _TAIL), "voice.start"),
    (re.compile(r"(stop|turn off|disable|switch off)( the| my)? voice( mode| chat)?" + _TAIL), "voice.stop"),
    (re.compile(r"mute( the| my)? (mic|microphone|voice)" + _TAIL), "voice.mute"),
    (re.compile(r"unmute( the| my)? (mic|microphone|voice)" + _TAIL), "voice.unmute"),
    (re.compile(r"(start|turn on|enable|switch on)( the| my)? wake( word)?( listening)?" + _TAIL), "voice.wake"),
    (re.compile(r"(stop|turn off|disable|switch off)( the| my)? wake( word)?( listening)?" + _TAIL), "voice.wake_off"),
    (re.compile(r"(pair|connect|add|link)( my| a| the)? phone" + _TAIL), "pairing.start"),
    (re.compile(r"(list|show)( me)?( my| the)?( paired| connected)? phones" + _TAIL), "pairing.list"),
    (re.compile(r"(forget|remove|unpair|disconnect)( my| the)? phone (?P<number>\d{1,3})" + _TAIL), "pairing.revoke"),
    (re.compile(r"(let|allow|give)( the| my)? phone (?P<number>\d{1,3})( permission)?( to)? approve"
                r"( actions| things| requests)?" + _TAIL), "pairing.approve"),
    (re.compile(r"(stop|take away|remove|block)( the| my)? phone (?P<number>\d{1,3})( from)?"
                r"( approving| approve| approvals?)" + _TAIL), "pairing.unapprove"),
    (re.compile(r"phone (?P<number>\d{1,3}) (can ?not|can't|may not|must not) approve" + _TAIL),
     "pairing.unapprove"),
    (re.compile(r"(help|commands|what can you do)" + _TAIL), "help.list"),
    (re.compile(r"(what'?s the |what is the |how'?s the )?weather (in|for|at) (?P<city>.{1,64}?)" + _TAIL),
     "skill.weather"),
    (re.compile(r"(search|look up|find)( the| my)? archive for (?P<query>.{1,64}?)" + _TAIL),
     "memory.search_archive"),
    (re.compile(r"restore(?: archived)?(?: memory| entry| archive entry)?(?: number| #)? ?(?P<id>\d{1,6})" + _TAIL),
     "memory.restore"),
    (re.compile(r"(roll ?back|undo)( the| my)?( last| latest)?( self repair| repair| change| update| fix)?" + _TAIL),
     "repair.rollback_last"),
    (re.compile(r"(list|show)( me)?( the| my)? (snapshots|backups|restore points|repairs)" + _TAIL),
     "repair.list"),
    (re.compile(r"(what (errors|problems|faults) have you (noticed|found)|"
                r"(list|show)( me)?( the| any)?( recent)? (errors|problems|faults|notices)( you noticed| you found)?)"
                + _TAIL), "repair.notices"),
    # Local knowledge: the owner teaches an answer, lists what is kept, or forgets one.
    # The teach rule is RAW, so the handler reads the question and answer with their capitals.
    (re.compile(r"(?:learn|teach me|save this answer)(?: that| this)?[:,]?\s+.{3,1000}?\s*(?:=|means|->)\s*.{1,2000}"),
     "knowledge.teach"),
    (re.compile(r"(?:what have you learned|list (?:your )?(?:learned answers|knowledge)|show (?:your )?knowledge)"
                + _TAIL), "knowledge.list"),
    (re.compile(r"forget (?:knowledge |answer |learned answer )?(?:number |#)?(?P<id>\d{1,6})" + _TAIL),
     "knowledge.forget"),
    # Questions about the owner's own stored facts. Answered from memory if it clearly holds the
    # answer; otherwise the agent passes the question on to Gemini.
    (re.compile(r"(?:what(?:'s| is| was)|tell me) my (?P<query>.{1,64}?)"), "memory.recall"),
    (re.compile(r"(?:what do you (?:remember|know)|do you (?:remember|know)|what did i (?:tell|say) you)"
                r"(?: about| of)? (?P<query>.{1,64}?)"), "memory.recall"),
    (re.compile(r"(search|look up)( the| for)?( the)? (web|internet|online)( for)? .{1,300}"), "web.search"),
    (re.compile(r"remind me (in|at|tomorrow at) .{1,400}"), "reminder.add"),
    (re.compile(r"(list|show|what are)( me)?( my| the)? reminders( i have)?|what reminders do i have" + _TAIL),
     "reminder.list"),
    (re.compile(r"(cancel|delete|remove) reminder [a-z0-9]{1,12}" + _TAIL), "reminder.cancel"),
    (re.compile(r"(propose a fix|propose a repair|self repair|fix the code|improve the code)"
                r"( for| to| on| in)? (?P<request>.{5,300})"),
     "repair.propose"),
]


RAW_ACTIONS = frozenset({"repair.propose", "reminder.add", "reminder.cancel", "web.search", "knowledge.teach"})

# The words in front of a web search query. Removed from the raw text, which keeps capitals.
WEB_PREFIX = re.compile(r"^(search|look up)( the| for)?( the)? (web|internet|online)( for)?\s*", re.IGNORECASE)


@dataclass(frozen=True)
class Match:
    action: str
    args: dict = field(default_factory=dict)


def normalise(text: str) -> str:
    text = re.sub(r"[?!.,;:]+", " ", (text or "").lower())
    return re.sub(r"\s+", " ", text).strip()


def match(text: str) -> Match | None:
    cleaned = normalise(text)
    if not cleaned:
        return None
    for pattern, action in _RULES:
        m = pattern.fullmatch(cleaned)
        if m:
            args = {k: m.group(k).strip() for k in pattern.groupindex if m.group(k) is not None}
            if action in RAW_ACTIONS:
                # File names need their dots and capitals, which normalise() removes.
                args["raw"] = (text or "").strip()
            return Match(action, args)
    return None


def all_actions() -> set[str]:
    return {action for _, action in _RULES}
