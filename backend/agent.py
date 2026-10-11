"""Agent: one entry point for a chat message.

Order for each message:
  1. Local router (backend/router.py). If a rule matches, the action goes through the
     permission policy: SAFE runs now, CONFIRM waits for the owner, BLOCKED is refused.
     A question about the owner's own stored facts ("what is my ...") is answered from
     memory when a stored fact clearly holds the answer (backend/recall.py).
  2. If no rule matches, or a local rule declines (for example a folder name that is not
     allowed, or no stored fact matches), the message goes to Gemini, but only after the
     daily budget (backend/quota.py) takes a unit. Gemini is the last resort.
Chat turns are published to the event bus (source "chat").

Local answers are not added to the Gemini conversation history. The history is kept
by ChatService and holds only messages that went to Gemini.

Provenance: written for this project. No code taken from other projects.
"""
from __future__ import annotations

import re
import webbrowser
from datetime import datetime
from typing import Callable

from . import config, pairing, router
from .chat import BackendNotConfigured, ChatService, UpstreamError
from .pairing import PairingStore
from .permissions import ConfirmationStore, PermissionPolicy
from .quota import DailyBudget
from .knowledge import KnowledgeStore
from .recall import describe as describe_facts, find_facts
from .repair import Notices, SelfRepair, RepairRefused
from .reminders import BadReminder, Reminders, cancel_id, describe

WEB_SYSTEM = ("Answer the question using a Google search. Be brief: at most six sentences of plain text. "
              "If the search gives no clear answer, say so. Do not invent facts.")
MAX_WEB_CHARS = 1200
from .repair import proposer
from .skills import ALL_SKILLS
from .workspaces import DEFAULT_WORKSPACE


def _phone_number(text: str) -> int:
    try:
        return int(text)
    except (TypeError, ValueError):
        return 0


_PAIRING_OFF = ("Phone pairing is off. To allow it, start the app with SUPPER_PAIRING=on and SUPPER_HOST=0.0.0.0, "
                "then restart. Only do this on your home network.")


def _when(ts) -> str:
    try:
        return datetime.fromtimestamp(float(ts)).strftime("%a %d %b %H:%M")
    except (TypeError, ValueError, OSError):
        return "unknown"


class BudgetExhausted(RuntimeError):
    """The daily Gemini budget is used up (or Gemini said its limit is reached)."""


class Agent:
    def __init__(
        self,
        chat: ChatService,
        budget: DailyBudget,
        policy: PermissionPolicy,
        confirmations: ConfirmationStore,
        bus=None,
        session=None,
        roots: Callable[[], list[dict]] | None = None,
        clock: Callable[[], datetime] | None = None,
        voice=None,
        opener: Callable[[str], bool] | None = None,
        repair: SelfRepair | None = None,
        notices: Notices | None = None,
        reminders: Reminders | None = None,
        knowledge: KnowledgeStore | None = None,
        pairing=None,
    ) -> None:
        self._voice = voice
        self._pairing = pairing if pairing is not None else PairingStore(config.RUNTIME_DIR / "paired_devices.json")
        self._repair = repair or SelfRepair(config.REPO_ROOT, config.RUNTIME_DIR, confirmations)
        self._notices = notices or Notices(config.REPO_ROOT, bus=bus)
        self._reminders = reminders or Reminders(config.RUNTIME_DIR / "reminders.json", bus=bus)
        self._opener = opener or webbrowser.open
        self._knowledge = knowledge if knowledge is not None else KnowledgeStore()
        self._chat = chat
        self._budget = budget
        self._policy = policy
        self._confirmations = confirmations
        self._bus = bus
        self._session = session
        self._roots = roots or _default_roots
        self._clock = clock or datetime.now
        self._handlers: dict[str, Callable[[router.Match, bool], dict | None]] = {
            "time.now": self._time_now,
            "time.date": self._time_date,
            "status.read": self._status,
            "files.roots": self._list_roots,
            "files.open_root": self._open_root,
            "myhands.start": self._myhands_start,
            "myhands.stop": self._myhands_stop,
            "help.list": self._help,
            "voice.start": self._voice_start,
            "voice.stop": self._voice_stop,
            "voice.mute": self._voice_mute,
            "voice.unmute": self._voice_mute,
            "voice.wake": self._voice_wake,
            "voice.wake_off": self._voice_wake_off,
            "voice.test": self._voice_test,
            "memory.search_archive": self._archive_search,
            "memory.restore": self._archive_restore,
            "repair.rollback_last": self._repair_rollback_last,
            "repair.list": self._repair_list,
            "repair.notices": self._repair_notices,
            "web.search": self._web_search,
            "reminder.add": self._reminder_add,
            "reminder.list": self._reminder_list,
            "reminder.cancel": self._reminder_cancel,
            "repair.propose": self._repair_propose,
            "memory.recall": self._memory_recall,
            "knowledge.teach": self._knowledge_teach,
            "knowledge.list": self._knowledge_list,
            "knowledge.forget": self._knowledge_forget,
            "pairing.start": self._pairing_start,
            "pairing.list": self._pairing_list,
            "pairing.revoke": self._pairing_revoke,
            "pairing.approve": self._pairing_approve,
            "pairing.unapprove": self._pairing_unapprove,
        }
        for skill in ALL_SKILLS:
            self._handlers[skill.action] = self._skill_runner(skill)

    # ----- entry point -----

    def handle(self, text: str, workspace: str = DEFAULT_WORKSPACE, quiet: bool = False) -> dict:
        """Answer one message. `quiet` skips the chat events; the voice path publishes its own."""
        text = (text or "").strip()
        if not text:
            raise ValueError("empty message")
        if not quiet:
            self._publish("chat_turn", role="user", text=text, workspace=workspace)
        result = None
        m = router.match(text)
        if m is not None:
            result = self._local(m)
        if result is None:
            result = self._known(text)
        if result is None:
            result = self._gemini(text, workspace)
        if not quiet:
            # "via", not "source": the bus stamps its own "source" (the stream name) on every event.
            self._publish("chat_turn", role="assistant", text=result["reply"],
                          via=result["source"], intent=result["intent"])
        return result

    # ----- local path -----

    def _local(self, m: router.Match) -> dict | None:
        if m.action in ("pairing.start", "pairing.approve") and not pairing.enabled():
            return _answer(_PAIRING_OFF, "local", m.action)     # nothing to ask about: say how to turn it on
        decision = self._policy.decide(m.action)
        if decision.needs_confirmation:
            return self._ask(m)
        if not decision.allowed:
            return _answer(f"That is not allowed here ({decision.reason}).", "blocked", m.action)
        out = self._handlers[m.action](m, False)
        if out is None:
            return None                                  # declined: let Gemini answer instead
        if out.get("confirmation") is not None:
            return _answer(out["reply"], "confirmation", m.action, confirmation=out["confirmation"])
        return _answer(out["reply"], "local", m.action, open_path=out.get("open_path"))

    def _ask(self, m: router.Match) -> dict:
        summary = self._summary(m)
        view = self._confirmations.request(
            m.action, summary, run=lambda: self._run_confirmed(m))
        reply = f"This needs your OK: {summary} Approve or deny it in the panel above the chat."
        return _answer(reply, "confirmation", m.action, confirmation=view)

    def _run_confirmed(self, m: router.Match) -> str:
        out = self._handlers[m.action](m, True)
        return out["reply"] if out else "Nothing was done."

    def _summary(self, m: router.Match) -> str:
        if m.action == "myhands.start":
            return "Turn on My Hands. The camera switches on; you can turn it off at any time."
        if m.action == "voice.start":
            return "Start voice on this computer. The microphone opens and your speech goes to Gemini Live."
        if m.action == "voice.wake":
            return "Turn on the 'Hey Jarvis' wake word. It listens on this computer only until the word is heard."
        if m.action == "pairing.start":
            return ("Let a phone on this home network connect. The phone can see chat and status. It cannot "
                    "use the camera, microphone, files or self-repair, and it cannot approve actions unless you "
                    "later allow it. A code is shown here for 5 minutes, and it works once.")
        if m.action == "pairing.approve":
            label = self._phone_label(m.args.get("number", ""))
            return (f"Let {label} approve or deny the actions JARVIS asks about. It still cannot add or "
                    "remove phones, and it still cannot use the camera, microphone or files. You can take this "
                    "back at any time by saying 'stop phone N approving'.")
        for skill in ALL_SKILLS:
            if m.action == skill.action:
                return skill.summary(m.args)
        if m.action == "reminder.cancel":
            try:
                rid = cancel_id(m.args.get("raw") or "")
            except BadReminder:
                rid = "(not understood)"
            return f"Cancel reminder {rid}. It will not be shown again."
        if m.action == "repair.propose":
            asked = (m.args.get("raw") or m.args.get("request") or "").strip()
            return (f"Ask Gemini to draft a fix for: {asked[:160]}. The text of the project files you name "
                    "will be sent to Gemini. Nothing changes unless you then approve the draft.")
        if m.action == "repair.rollback_last":
            return f"Roll back the last self-repair change: {self._repair.describe_last()}. The state before the rollback is saved too."
        if m.action == "memory.restore":
            from memory import memory_manager as mm
            try:
                described = mm.describe_archive_entry(int(m.args.get("id", "-1")))
            except ValueError:
                described = None
            what = f"archived memory fact {m.args.get('id')}: {described}" if described \
                else f"archived memory fact {m.args.get('id')} (not found or the archive is unreadable)"
            return f"Restore {what} into your active memory. The archive keeps its copy."
        return f"Run {m.action}."

    # ----- handlers (return None to decline) -----

    def _archive_search(self, m, confirmed):
        from memory import memory_manager as mm
        query = (m.args.get("query") or "").strip()
        if not query:
            return {"reply": "Sir, what should I search the archive for?"}
        try:
            found = mm.search_archive(query)
        except mm.ArchiveUnreadable as e:
            return {"reply": f"Sir, the archive could not be read: {e}. Nothing was changed."}
        except Exception as e:
            return {"reply": f"Sir, the archive search did not complete ({type(e).__name__}). Nothing was changed."}
        if not found["matches"]:
            return {"reply": f'Nothing in the archive matches "{query}", sir.'}
        parts = []
        for hit in found["matches"]:
            label = f"#{hit['id']}" if hit["id"] is not None else hit["source"]
            text = hit["text"] if len(hit["text"]) <= 120 else hit["text"][:117] + "…"
            tag = " (active again)" if hit["active_now"] else ""
            parts.append(f"{label} {text}{tag}")
        shown = len(found["matches"])
        head = f'{found["total"]} archive match(es) for "{query}"'
        if found["total"] > shown:
            head += f", showing the last {shown}"
        return {"reply": f"{head}: " + " · ".join(parts)
                         + ". Say 'restore archive entry <number>' to bring a memory fact back."}

    def _repair_rollback_last(self, m, confirmed):
        try:
            return {"reply": self._repair.rollback_last()}
        except LookupError as e:
            return {"reply": f"Sir, nothing was rolled back. {e}"}
        except Exception as e:
            return {"reply": f"Sir, the rollback did not complete ({type(e).__name__}). Check runtime/snapshots."}

    def _repair_propose(self, m, confirmed):
        request = (m.args.get("request") or "").strip()
        if not request:
            return {"reply": "Sir, what should I fix or improve?"}
        if not self._budget.try_spend():
            return {"reply": "Today's Gemini budget is used up, so I cannot draft a fix. "
                             "Local commands still work."}
        files = proposer.context_files(self._repair.repo, m.args.get("raw") or request)
        try:
            answer = self._chat.complete(proposer.build_prompt(request, files), proposer.SYSTEM)
        except UpstreamError as e:
            if e.quota:
                self._budget.mark_exhausted()
                return {"reply": "Gemini reports its limit is reached for now, so no fix was drafted."}
            return {"reply": f"Sir, I could not draft a fix: {e}. Nothing was changed."}
        except BackendNotConfigured as e:
            return {"reply": str(e)}
        try:
            reason, changes = proposer.parse(answer)
        except proposer.ProposalError as e:
            return {"reply": f"Sir, I could not form a safe proposal: {e}. Nothing was changed."}
        if not changes:
            return {"reply": f"Sir, I do not propose a change. {reason}"}
        try:
            out = self._repair.propose(reason, changes)
        except RepairRefused as e:
            return {"reply": f"Sir, I cannot make that change: {e}. Nothing was changed."}
        if out["status"] == "rejected":
            return {"reply": f"Sir, my draft failed the tests on a copy, so nothing was changed. "
                             f"{out['why']}. Last lines: {out['test_output'][-300:]}"}
        warn = (" " + " ".join(out["warnings"])) if out["warnings"] else ""
        return {"reply": (f"Here is my proposed change, sir: {reason} Files: {', '.join(out['files'])}. "
                          f"Risk: {out['risk']}.{warn} The tests passed on a copy. Approve it in the panel "
                          f"to apply it."),
                "confirmation": out["confirmation"]}

    def _web_search(self, m, confirmed):
        query = router.WEB_PREFIX.sub("", m.args.get("raw") or "", count=1).strip()
        if not query or len(query) > 300 or any(ord(ch) < 32 for ch in query):
            return {"reply": "Sir, what should I search the web for? Keep it under 300 characters."}
        if not self._budget.try_spend():
            return {"reply": "Today's Gemini budget is used up, so I cannot search the web. Local commands still work."}
        try:
            answer = self._chat.complete(query, WEB_SYSTEM, grounded=True)
        except UpstreamError as e:
            if e.quota:
                self._budget.mark_exhausted()
                return {"reply": "Gemini reports its limit is reached for now, so the web search did not run."}
            return {"reply": f"Sir, the web search did not complete: {e}."}
        except BackendNotConfigured as e:
            return {"reply": str(e)}
        text = answer if len(answer) <= MAX_WEB_CHARS else answer[:MAX_WEB_CHARS - 1].rstrip() + "…"
        return {"reply": f"Web search, sir: {text}"}

    def _reminder_add(self, m, confirmed):
        try:
            item = self._reminders.add(m.args.get("raw") or "")
        except BadReminder as e:
            return {"reply": str(e)}
        when = datetime.fromisoformat(item["due"]).strftime("%a %d %b at %H:%M")
        return {"reply": f"Reminder #{item['id']} set for {when}: {item['text']}."}

    def _reminder_list(self, m, confirmed):
        return {"reply": describe(self._reminders.pending())}

    def _reminder_cancel(self, m, confirmed):
        try:
            item = self._reminders.cancel(cancel_id(m.args.get("raw") or ""))
        except BadReminder as e:
            return {"reply": str(e)}
        return {"reply": f"Reminder #{item['id']} cancelled: {item['text']}."}

    def _repair_notices(self, m, confirmed):
        items = self._notices.recent()
        if not items:
            return {"reply": "Sir, I have not noticed any errors in my own code since this app started."}
        lines = [f"#{i['id']} {i['file']} line {i['line']} ({i['error']}) at {i['time']}" for i in items[-10:]]
        return {"reply": "Errors I noticed, newest last: " + " | ".join(lines)
                         + ". Nothing has been changed. Say 'propose a fix for <file>: <what to change>' to ask for a fix."}

    def _repair_list(self, m, confirmed):
        items = self._repair.list_snapshots(limit=10)
        if not items:
            return {"reply": "There are no snapshots yet, sir."}
        lines = [f"{i['id']} · {i['reason']} · {i['files']} file(s)" + (" · rolled back" if i["rolled_back"] else "")
                 for i in items]
        return {"reply": "Latest snapshots: " + " | ".join(lines)}

    def _archive_restore(self, m, confirmed):
        from memory import memory_manager as mm
        try:
            aid = int(m.args.get("id", "-1"))
        except ValueError:
            return {"reply": "Sir, which archive number should I restore?"}
        try:
            return {"reply": mm.restore_archive_entry(aid)}
        except mm.ArchiveUnreadable as e:
            return {"reply": f"Sir, nothing was restored. The archive could not be read: {e}."}
        except (LookupError, FileExistsError, ValueError) as e:
            return {"reply": f"Sir, nothing was restored. {e}"}
        except Exception as e:
            return {"reply": f"Sir, the restore did not complete ({type(e).__name__}). Check the archive files."}

    def _skill_runner(self, skill):
        def run(m, confirmed):
            return skill.handler(m.args, self._opener)
        return run

    def _time_now(self, m, confirmed):
        return {"reply": f"It is {self._clock():%H:%M}."}

    def _time_date(self, m, confirmed):
        now = self._clock()
        return {"reply": f"Today is {now:%A}, {now.day} {now:%B %Y}."}

    def _status(self, m, confirmed):
        key = "set" if config.get_gemini_api_key() else "not set"
        b = self._budget.snapshot()
        my_hands = "on" if (self._session and self._session.status().get("running")) else "off"
        folders = len(self._roots())
        return {"reply": (f"Gemini key: {key}. Gemini budget today: {b['used']} of {b['limit']} used. "
                          f"My Hands: {my_hands}. Allowed folders: {folders}.")}

    def _list_roots(self, m, confirmed):
        names = [r["name"] for r in self._roots()]
        if not names:
            return {"reply": "No folders are allowed yet."}
        return {"reply": "Allowed folders: " + ", ".join(names) + "."}

    def _open_root(self, m, confirmed):
        wanted = m.args.get("name", "").lower()
        for r in self._roots():
            if r["name"].lower() == wanted:
                return {"reply": f"Opening {r['name']}.", "open_path": r["path"]}
        return None                                      # not an allowed folder: ask Gemini

    def _myhands_start(self, m, confirmed):
        if self._session is None:
            return {"reply": "My Hands is not available on this server."}
        self._session.start("my_hands")
        return {"reply": "My Hands is starting. If the camera does not come on, Diagnostics shows why."}

    def _myhands_stop(self, m, confirmed):
        if self._session is not None:
            self._session.stop("user")
        return {"reply": "My Hands is off."}

    def _voice_start(self, m, confirmed):
        if self._voice is None:
            return {"reply": "Voice is not available on this server."}
        try:
            self._voice.start_live(source="chat")
        except Exception as e:                       # VoiceError: budget, key, or audio device
            return {"reply": f"Voice did not start: {e}"}
        return {"reply": "Voice is on. Go ahead and speak."}

    def _voice_stop(self, m, confirmed):
        if self._voice is not None:
            self._voice.stop_live(reason="chat")
        return {"reply": "Voice is off."}

    def _voice_mute(self, m, confirmed):
        if self._voice is None:
            return {"reply": "Voice is not available on this server."}
        muted = m.action == "voice.mute"
        self._voice.set_muted(muted)
        return {"reply": "Microphone muted." if muted else "Microphone unmuted."}

    def _voice_wake(self, m, confirmed):
        if self._voice is None:
            return {"reply": "Voice is not available on this server."}
        try:
            self._voice.set_wake(True)
        except Exception as e:
            return {"reply": f"Wake word did not start: {e}"}
        return {"reply": "Wake word listening is on."}

    def _voice_wake_off(self, m, confirmed):
        if self._voice is not None:
            self._voice.set_wake(False)
        return {"reply": "Wake word listening is off."}

    def _voice_test(self, m, confirmed):
        """The audio self-test: a beep, a few seconds of listening, and a plain report."""
        if self._voice is None or not hasattr(self._voice, "audio_test"):
            return {"reply": "Voice is not available on this server."}
        try:
            result = self._voice.audio_test()
        except Exception as e:                       # VoiceError: a Live session is running
            return {"reply": f"The audio test did not run: {e}"}
        lines = [f"{'✓' if c['ok'] else '✗'} {c['name']} — {c['detail']}" for c in result["checks"]]
        head = ("Audio test passed." if result["ok"]
                else "Audio test found problems. Fix the lines marked ✗ and run it again.")
        return {"reply": head + "\n" + "\n".join(lines)}

    def _memory_recall(self, m, confirmed):
        """Answer from stored facts when they clearly hold the answer. Otherwise decline, so the
        question goes on to Gemini. Nothing is written."""
        facts = find_facts(m.args.get("query") or "")
        if not facts:
            return None                                  # nothing stored says so: let Gemini answer
        return {"reply": "From what you have told me: " + describe_facts(facts) + "."}

    # ----- phone pairing (V2-6) -----

    def _pairing_start(self, m, confirmed):
        if not pairing.enabled():
            return {"reply": _PAIRING_OFF}
        issued = self._pairing.start_code()
        ip = pairing.lan_address()
        if config.HOST in ("127.0.0.1", "localhost", "::1"):
            where = ("This app listens only on this computer, so a phone cannot reach it yet. Start the app "
                     "with SUPPER_HOST=0.0.0.0 and restart it.")
        elif ip:
            where = f"On the phone, open http://{ip}:{config.PORT}/pair in its browser."
        else:
            where = (f"On the phone, open http://<this computer's address>:{config.PORT}/pair. Find the address "
                     "in the computer's network settings.")
        return {"reply": (f"Phone pairing code: {issued['code']}. {where} Type the code there. It works once and "
                          "expires in 5 minutes. Only share it with your own phone on this home network.")}

    def _pairing_list(self, m, confirmed):
        devices = self._pairing.devices()
        if not devices:
            return {"reply": "No phones are paired."}
        lines = [f"{d['number']}. {d['label']} (last seen {_when(d['last_seen'])}"
                 + (", can approve" if d.get("may_approve") else "") + ")" for d in devices]
        return {"reply": "Paired phones: " + " · ".join(lines) + ". Forget one with 'forget phone <number>'."}

    def _pairing_approve(self, m, confirmed):
        if not pairing.enabled():
            return {"reply": _PAIRING_OFF}
        number = _phone_number(m.args.get("number", ""))
        gone = self._pairing.set_approve(number, True) if number else None
        if gone is None:
            return {"reply": "There is no paired phone with that number. Say 'list phones' to see them."}
        return {"reply": (f"{gone['label']} can now approve or deny actions. It still cannot add or remove "
                          "phones. Say 'stop phone " + str(number) + " approving' to take this back.")}

    def _pairing_unapprove(self, m, confirmed):
        number = _phone_number(m.args.get("number", ""))
        gone = self._pairing.set_approve(number, False) if number else None
        if gone is None:
            return {"reply": "There is no paired phone with that number. Say 'list phones' to see them."}
        return {"reply": f"{gone['label']} can no longer approve actions. It can still chat and read status."}

    def _phone_label(self, number: str) -> str:
        n = _phone_number(number)
        for d in self._pairing.devices():
            if d["number"] == n:
                return d["label"]
        return f"phone {number}"

    def _pairing_revoke(self, m, confirmed):
        try:
            number = int(m.args.get("number", "0"))
        except ValueError:
            number = 0
        gone = self._pairing.revoke(number)
        if gone is None:
            return {"reply": "There is no paired phone with that number. Say 'list phones' to see them."}
        return {"reply": f"{gone['label']} is forgotten. It can no longer use the app until it pairs again."}

    def _help(self, m, confirmed):
        return {"reply": ("Local commands: what time is it · what's the date · system status · "
                          "show folders · open <folder name> · turn on My Hands (asks first) · "
                          "turn off My Hands · test the sound (beeps and checks the microphone) · "
                          "what is my <thing> (answers from what you told me, if stored) · "
                          "learn: <question> = <answer> · what have you learned · forget <number> · "
                          "propose a fix for <request> (asks before any change) · roll back the last change (asks first) · list snapshots · search archive for <text> · restore archive entry <number> (asks first) · pair my phone (asks first) · list phones · forget phone <number> · help. Anything else goes to Gemini, "
                          "within today's budget.")}

    # ----- local knowledge -----

    def _known(self, text: str) -> dict | None:
        """A stored answer for this question (starter, taught or kept from Gemini), or None."""
        try:
            entry = self._knowledge.lookup(text)
        except OSError:
            return None                                  # an unreadable file must not stop chat
        if entry is None:
            return None
        return _answer(self._knowledge.describe(entry), "knowledge", "knowledge.lookup")

    def _knowledge_teach(self, m, confirmed):
        raw = (m.args.get("raw") or "").strip()
        parts = re.match(r"^(?:learn|teach me|save this answer)(?:\s+that| this)?[:,]?\s+(.+?)\s*"
                         r"(?:=|\bmeans\b|->)\s*(.+)$", raw, re.IGNORECASE | re.DOTALL)
        if parts is None:
            return {"reply": "Write it as: learn: <question> = <answer>."}
        try:
            entry = self._knowledge.teach(parts.group(1), parts.group(2))
        except ValueError as e:
            return {"reply": f"I did not save that: {e}."}
        return {"reply": f"Saved as answer #{entry['id']}. I will use it for questions like that."}

    def _knowledge_list(self, m, confirmed):
        entries = self._knowledge.list_entries()
        if not entries:
            return {"reply": "I have no local answers stored yet."}
        counts: dict[str, int] = {}
        for e in entries:
            counts[e["kind"]] = counts.get(e["kind"], 0) + 1
        summary = ", ".join(f"{n} {kind}" for kind, n in sorted(counts.items()))
        lines = [f"#{e['id']} ({e['kind']}): {e['question']}" for e in entries[:10]]
        more = f" and {len(entries) - 10} more" if len(entries) > 10 else ""
        return {"reply": f"Local answers: {summary}. " + "; ".join(lines) + more + ". Say forget <number> to remove one."}

    def _knowledge_forget(self, m, confirmed):
        try:
            entry_id = int(m.args.get("id") or 0)
        except ValueError:
            entry_id = 0
        entry = self._knowledge.forget(entry_id) if entry_id else None
        if entry is None:
            return {"reply": "I have no local answer with that number."}
        return {"reply": f"Answer #{entry_id} moved to the archive. Nothing was deleted."}

    # ----- Gemini path -----

    def _gemini(self, text: str, workspace: str) -> dict:
        if not config.get_gemini_api_key():
            raise BackendNotConfigured(
                "No Gemini API key. Set GEMINI_API_KEY or add gemini_api_key to config/api_keys.json.")
        if not self._budget.try_spend():
            raise BudgetExhausted(
                "Today's Gemini budget is used up. Local commands still work; "
                "the budget resets at local midnight.")
        try:
            reply = self._chat.reply(text, workspace=workspace)
        except UpstreamError as e:
            if e.quota:
                self._budget.mark_exhausted()
                raise BudgetExhausted(
                    "Gemini reports its limit is reached for now. Local commands still work.") from None
            raise
        try:
            self._knowledge.learn(text, reply)           # keep it, so the same question is free next time
        except OSError:
            pass                                         # saving is a bonus; the answer still goes out
        return _answer(reply, "gemini", None)

    # ----- helpers -----

    def _publish(self, kind: str, **data) -> None:
        if self._bus is not None:
            self._bus.publish("chat", {"type": kind, **data})


def _answer(reply: str, source: str, intent: str | None, *, confirmation=None, open_path=None) -> dict:
    return {"reply": reply, "source": source, "intent": intent,
            "confirmation": confirmation, "open_path": open_path}


def _default_roots() -> list[dict]:
    from . import files
    return files.list_roots()
