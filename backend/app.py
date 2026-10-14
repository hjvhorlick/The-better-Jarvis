"""FastAPI application for the Supper AI Agent backend.

Endpoints (JSON unless noted):
  GET  /                      the glass UI (static files from web/)
  GET  /api/health            liveness
  GET  /api/status            configuration state; never returns secret values
  GET  /api/workspaces        workspace names for the side panels
  GET  /api/memory/summary    read-only counts per memory category
  POST /api/chat              {"text": "...", "workspace": "coding"}
                              -> {"reply", "source": local|gemini|confirmation|blocked, "intent", "confirmation", "open_path"}
  GET  /api/confirmations     pending CONFIRM actions waiting for the owner
  POST /api/confirmations/{id} {"approve": true|false} -> {"status", "result"}
  GET  /api/files/roots       folders the owner allows
  GET  /api/files/list?path=  entries in an allowed folder
  GET  /api/files/read?path=  text preview of an allowed file
  POST /api/myhands/start, /stop;  GET /api/myhands/status;  PUT /api/myhands/scene
  WS   /ws/myhands            My Hands gesture events (see myhands_api.py)
  WS   /ws/events?since=N     the shared event stream (every module; see stream.py)
  GET  /api/diagnostics       devices, leases, bus state, recent problems; no secrets
  GET  /pair                  the phone pairing page (only when SUPPER_PAIRING=on; see pairing.py)
  POST /api/pairing/claim     {"code": "123456"} from a phone -> sets its device cookie

Every request passes through LocalOnlyGuard (see security.py).
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, config, files, pairing
from .agent import Agent, BudgetExhausted
from .brain import BrainStorageError, BrainStore
from .chat import BackendNotConfigured, ChatService, UpstreamError
from .permissions import ConfirmationError, ConfirmationStore, TooManyPending, default_policy
from .quota import DailyBudget
from .memory_view import memory_summary
from . import diagnostics, media, myhands_api, stream
from .voice import api as voice_api, factory as voice_factory
from .devices import DeviceRegistry
from .events import EventBus
from .repair import Notices
from .reminders import Reminders
from .security import LocalOnlyGuard
from .workspaces import DEFAULT_WORKSPACE, WORKSPACES, is_known


class ChatIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    workspace: str = Field(default=DEFAULT_WORKSPACE, max_length=32)
    conversation_id: str | None = Field(default=None, max_length=64)
    topic_id: str | None = Field(default=None, max_length=64)


class BrainMemoryIn(BaseModel):
    category: str = Field(..., min_length=2, max_length=40)
    key: str = Field(..., min_length=1, max_length=160)
    value: str = Field(..., min_length=1, max_length=1200)
    topic_id: str | None = Field(default=None, max_length=64)
    provenance: str = Field(default="", max_length=400)


class BrainMemoryCorrectionIn(BaseModel):
    category: str = Field(..., min_length=2, max_length=40)
    key: str = Field(..., min_length=1, max_length=160)
    value: str = Field(..., min_length=1, max_length=1200)
    topic_id: str | None = Field(default=None, max_length=64)
    reason: str = Field(default="", max_length=300)


class BrainTopicIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=160)
    goal: str = Field(default="", max_length=800)


class BrainTopicUpdateIn(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    summary: str | None = Field(default=None, max_length=1600)
    goal: str | None = Field(default=None, max_length=800)
    status: str | None = Field(default=None, max_length=16)
    next_step: str | None = Field(default=None, max_length=800)
    open_questions: list[str] | None = Field(default=None, max_length=20)


class BrainConversationIn(BaseModel):
    topic_id: str | None = Field(default=None, max_length=64)


class BrainTaskIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=800)
    topic_id: str | None = Field(default=None, max_length=64)
    due_at: str = Field(default="", max_length=80)


class BrainTaskUpdateIn(BaseModel):
    status: str = Field(..., min_length=1, max_length=16)


class BrainForgetIn(BaseModel):
    category: str = Field(..., min_length=2, max_length=40)
    key: str = Field(..., min_length=1, max_length=160)
    topic_id: str | None = Field(default=None, max_length=64)


class ConfirmIn(BaseModel):
    approve: bool


class ClaimIn(BaseModel):
    code: str = Field(..., max_length=16)
    label: str | None = Field(default=None, max_length=60)


_PAIR_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair this phone</title>
<style>
 body{font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf7;margin:0;padding:24px;min-height:100vh;box-sizing:border-box}
 h1{font-size:22px;margin:0 0 12px} p{line-height:1.45;color:#b9c6da}
 input{font-size:28px;letter-spacing:6px;text-align:center;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #32435e;background:#121c2e;color:#fff;margin:12px 0}
 button{font-size:18px;width:100%;padding:14px;border:0;border-radius:10px;background:#3b82f6;color:#fff}
 #msg{min-height:48px;margin-top:12px;color:#fca5a5}
</style></head><body>
<h1>Pair this phone</h1>
<p>Type the 6-digit code shown on your computer. The code works once and expires after five minutes.</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
<button id="go">Pair</button>
<div id="msg" role="status"></div>
<script>
const msg = document.getElementById('msg');
document.getElementById('go').addEventListener('click', async () => {
  msg.textContent = '';
  const code = document.getElementById('code').value.replace(/[^0-9]/g, '');
  try {
    const r = await fetch('/api/pairing/claim', {method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: code})});
    const data = await r.json().catch(() => ({}));
    if (r.ok) { location.href = '/'; return; }
    msg.textContent = data.detail || 'Pairing did not work. Try again.';
  } catch (e) { msg.textContent = 'Cannot reach the computer. Check the address and the Wi-Fi.'; }
});
</script></body></html>"""


def _file_error(e: files.FileAccessError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=str(e))


def create_app(chat_service: ChatService | None = None, serve_ui: bool = True,
               myhands_session=None, bus: EventBus | None = None,
               devices: DeviceRegistry | None = None, budget: DailyBudget | None = None,
               policy=None, confirmations: ConfirmationStore | None = None,
               roots=None, voice=None, opener=None, pairing_store=None,
               brain_store: BrainStore | None = None) -> FastAPI:
    started: dict = {}

    @asynccontextmanager
    async def _lifespan(_app):
        # The reminder timer runs while the app runs: started at start-up, stopped at shutdown.
        if "reminders" in started:
            started["reminders"].start()
        if "voice" in started and hasattr(started["voice"], "autostart_wake"):
            started["voice"].autostart_wake()                 # "Hey Jarvis" listening, if set up
        try:
            yield
        finally:
            if "reminders" in started:
                started["reminders"].stop()
            if "voice" in started and hasattr(started["voice"], "close"):
                started["voice"].close()                      # releases the microphone and speaker

    app = FastAPI(title="Supper AI Agent backend", version=__version__, lifespan=_lifespan)
    chat = chat_service or ChatService()
    bus = bus if bus is not None else EventBus()
    devices = devices if devices is not None else DeviceRegistry(bus)
    session = myhands_session if myhands_session is not None else myhands_api.default_session(bus, devices)
    budget = budget if budget is not None else DailyBudget(
        config.get_daily_budget(), path=config.RUNTIME_DIR / "quota.json")
    policy = policy if policy is not None else default_policy()
    confirmations = confirmations if confirmations is not None else ConfirmationStore(bus=bus)
    brain = brain_store if brain_store is not None else BrainStore()
    pairing_store = pairing_store if pairing_store is not None else pairing.PairingStore(
        config.RUNTIME_DIR / "paired_devices.json")
    voice = voice if voice is not None else voice_factory.build(
        bus=bus, devices=devices, budget=budget, chat=chat)
    notices = Notices(config.REPO_ROOT, bus=bus)
    reminders = Reminders(config.RUNTIME_DIR / "reminders.json", bus=bus)
    agent = Agent(chat, budget, policy, confirmations, bus=bus, session=session, roots=roots,
                  voice=voice, opener=opener, notices=notices, reminders=reminders,
                  pairing=pairing_store, brain=brain)
    started["reminders"] = reminders
    started["voice"] = voice
    if hasattr(voice, "attach_answerer"):
        # Local spoken requests go through the same Brain, tools and permission system as typed chat.
        voice.attach_answerer(lambda text: agent.handle(text, quiet=True, channel="voice")["reply"])
    if hasattr(voice, "attach_turn_recorder"):
        # Gemini Live remains a provider-native voice path, but its transcripts join the same topic history.
        voice.attach_turn_recorder(agent.record_live_turn)
    myhands_api.register(app, session, devices)
    media.register(app, chat, budget)          # Studio: pictures, scripts, the library
    voice_api.register(app, voice, confirmations)
    stream.register(app, bus)

    @app.exception_handler(Exception)
    async def _unhandled(request, exc):
        # Note the error if it is in a file self-repair may change. The caller gets a plain 500.
        try:
            notices.record(exc)
        except Exception:
            pass
        return JSONResponse({"detail": "Internal error. The assistant has noted it."}, status_code=500)

    @app.get("/api/diagnostics")
    def diagnostics_view() -> dict:
        return diagnostics.build(bus, devices, session, chat, myhands_api.tracker_available(),
                                 budget=budget, confirmations=confirmations, policy=policy,
                                 voice=voice, brain=brain)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "service": "supper-backend", "version": __version__}

    @app.get("/api/status")
    def status() -> dict:
        brain_status = brain.status()
        return {
            "version": __version__,
            "api_key_configured": config.get_gemini_api_key() is not None,
            "provider": chat.provider_status() if hasattr(chat, "provider_status") else {"state": "not_tested"},
            "text_model": chat.model,
            "prompt_file_present": config.PROMPT_PATH.exists(),
            "config_file_present": config.API_CONFIG_PATH.exists(),
            "file_roots_available": len(files.get_roots()),
            "gemini_budget": budget.snapshot(),
            "brain": {"available": brain_status["available"],
                      "topic_count": brain_status["topic_count"],
                      "open_task_count": brain_status["open_task_count"]},
        }

    @app.get("/api/workspaces")
    def workspaces() -> dict:
        return {"default": DEFAULT_WORKSPACE,
                "workspaces": [{"id": k, "label": v["label"]} for k, v in WORKSPACES.items()]}

    @app.get("/api/memory/summary")
    def memory() -> dict:
        return memory_summary()

    # Brain management routes. They operate on the existing local memory store and never accept
    # a request-supplied owner ID. Phone access is intentionally not added to LocalOnlyGuard.
    @app.get("/api/brain/status")
    def brain_status() -> dict:
        return brain.status()

    @app.post("/api/brain/backup")
    def brain_backup() -> dict:
        try:
            return brain.create_backup()
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.get("/api/brain/topics")
    def brain_topics() -> dict:
        return {"topics": brain.list_topics()}

    @app.post("/api/brain/topics")
    def brain_create_topic(body: BrainTopicIn) -> dict:
        try:
            return brain.create_topic(body.title, goal=body.goal)
        except (ValueError, BrainStorageError) as exc:
            raise HTTPException(status_code=400 if isinstance(exc, ValueError) else 503, detail=str(exc))

    @app.patch("/api/brain/topics/{topic_id}")
    def brain_update_topic(topic_id: str, body: BrainTopicUpdateIn) -> dict:
        try:
            updates = body.model_dump(exclude_unset=True) if hasattr(body, "model_dump") else body.dict(exclude_unset=True)
            return brain.update_topic(topic_id, updates)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.post("/api/brain/topics/{topic_id}/activate")
    def brain_activate_topic(topic_id: str) -> dict:
        try:
            conversation = brain.start_conversation(topic_id=topic_id)
            return {**conversation, "topics": brain.list_topics()}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.post("/api/brain/conversations")
    def brain_start_conversation(body: BrainConversationIn) -> dict:
        try:
            return brain.start_conversation(topic_id=body.topic_id or "")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.get("/api/brain/conversations/{conversation_id}")
    def brain_conversation(conversation_id: str, limit: int = Query(default=100, ge=1, le=500)) -> dict:
        try:
            return brain.conversation_history(conversation_id, limit=limit)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @app.get("/api/brain/memory")
    def brain_memories(query: str = Query(default="", max_length=400),
                       category: str = Query(default="", max_length=40),
                       topic_id: str = Query(default="", max_length=64),
                       limit: int = Query(default=100, ge=1, le=500)) -> dict:
        return {"memories": brain.list_memories(query, category=category, topic_id=topic_id, limit=limit)}

    @app.post("/api/brain/memory")
    def brain_add_memory(body: BrainMemoryIn) -> dict:
        try:
            saved = brain.add_memory(body.category, body.key, body.value, source="ui_explicit",
                                     confidence=1.0, topic_id=body.topic_id or "",
                                     provenance=body.provenance)
            return {"saved": True, "memory": saved}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.put("/api/brain/memory")
    def brain_correct_memory(body: BrainMemoryCorrectionIn) -> dict:
        try:
            corrected = brain.correct_memory(body.category, body.key, body.value,
                                             reason=body.reason, topic_id=body.topic_id or "")
            if corrected is None:
                raise HTTPException(status_code=404, detail="No saved memory matched that category and name.")
            return {"saved": True, "memory": corrected}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.post("/api/brain/memory/forget")
    def brain_forget_memory(body: BrainForgetIn) -> dict:
        try:
            if body.topic_id and not brain.get_topic(body.topic_id):
                raise HTTPException(status_code=404, detail="That saved topic is not available in this local profile.")
            entries = brain.list_memories(category=body.category, limit=500)
            wanted_topic = body.topic_id or ""
            exists = any(row["key"] == body.key and (row.get("topic_id") or "") == wanted_topic
                         for row in entries)
            if not exists:
                raise HTTPException(status_code=404, detail="No saved memory matched that category and name.")
            scope = f" in topic {brain.get_topic(body.topic_id)['title']}" if body.topic_id else ""
            confirmation = confirmations.request(
                "brain.forget", f"Forget saved memory {body.category}/{body.key}{scope}",
                run=lambda: ("Memory forgotten." if brain.forget_memory(
                    body.category, body.key, topic_id=body.topic_id or "")
                    else "The memory was not found; nothing was changed."))
            return {"confirmation": confirmation}
        except HTTPException:
            raise
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except TooManyPending as exc:
            raise HTTPException(status_code=429, detail=str(exc))

    @app.get("/api/brain/tasks")
    def brain_tasks(topic_id: str = Query(default="", max_length=64),
                    status_filter: str = Query(default="", alias="status", max_length=16)) -> dict:
        return {"tasks": brain.list_tasks(topic_id=topic_id, status=status_filter)}

    @app.post("/api/brain/tasks")
    def brain_add_task(body: BrainTaskIn) -> dict:
        try:
            return {"task": brain.add_task(body.title, topic_id=body.topic_id or "", due_at=body.due_at)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.patch("/api/brain/tasks/{task_id}")
    def brain_update_task(task_id: str, body: BrainTaskUpdateIn) -> dict:
        try:
            return {"task": brain.update_task(task_id, body.status)}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except BrainStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc))

    @app.get("/api/brain/research")
    def brain_research(topic_id: str = Query(default="", max_length=64),
                       query: str = Query(default="", max_length=400),
                       limit: int = Query(default=50, ge=1, le=200)) -> dict:
        return {"research": brain.list_research(topic_id=topic_id, query=query, limit=limit)}

    @app.post("/api/diagnostics/provider-test")
    def provider_test() -> dict:
        if not config.get_gemini_api_key():
            raise HTTPException(status_code=503, detail="No Gemini API key is configured.")
        # A probe is the one place a refusal is the honest answer: it exists to
        # test the provider, so when the app is offline there is nothing to test.
        # The app's own count never refuses it — it only warns.
        if budget.offline:
            raise HTTPException(status_code=429,
                                detail=f"The app is offline ({budget.offline_reason()}); no test request "
                                       "was sent. The chat and every local feature still work.")
        budget.try_spend()
        warning = budget.warn()
        try:
            result = chat.probe()
        except BackendNotConfigured as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except UpstreamError as exc:
            if exc.quota:
                budget.mark_exhausted()
                raise HTTPException(status_code=429,
                                    detail="Google reports its quota is reached, so the app is now "
                                           "OFFLINE (local only) until midnight Pacific — Google's own "
                                           "quota reset. This is Google stopping us, not this app's "
                                           "count. The chat keeps working.")
            raise HTTPException(status_code=502, detail=str(exc))
        if warning and isinstance(result, dict):
            result = {**result, "warning": warning}
        return result

    @app.post("/api/chat")
    def post_chat(body: ChatIn) -> dict:
        if not is_known(body.workspace):
            raise HTTPException(status_code=400, detail="unknown workspace")
        try:
            # The chat never fails because of the provider: an unavailable
            # Gemini makes the agent answer LOCALLY (offline mode) instead.
            return agent.handle(body.text, workspace=body.workspace,
                                conversation_id=body.conversation_id, topic_id=body.topic_id)
        except BrainStorageError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except BackendNotConfigured as e:
            raise HTTPException(status_code=503, detail=str(e))
        except TooManyPending as e:
            raise HTTPException(status_code=429, detail=str(e))
        except UpstreamError as e:
            raise HTTPException(status_code=502, detail=str(e))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @app.get("/api/confirmations")
    def list_confirmations() -> dict:
        return {"pending": confirmations.pending()}

    @app.post("/api/confirmations/{cid}")
    def answer_confirmation(cid: str, body: ConfirmIn, request: Request) -> dict:
        if len(cid) > 64:
            raise HTTPException(status_code=404, detail="no such pending confirmation")
        device = getattr(request.state, "device", None)     # set by LocalOnlyGuard for a paired phone
        if device is not None:
            action = next((p["action"] for p in confirmations.pending() if p["id"] == cid), None)
            if action is not None and action.startswith("pairing."):
                # A phone must not let another device in (or change the phone list). That stays here.
                raise HTTPException(status_code=403, detail="A phone cannot approve changes to phones. Use this computer.")
        try:
            out = confirmations.resolve(cid, body.approve)
        except ConfirmationError:
            raise HTTPException(status_code=404, detail="no such pending confirmation")
        if device is not None:
            out["by"] = device["label"]
        return out

    @app.get("/pair", response_class=HTMLResponse)
    def pair_page() -> str:
        return _PAIR_PAGE

    @app.post("/api/pairing/claim")
    def claim_pairing(body: ClaimIn) -> JSONResponse:
        if not pairing.enabled():
            raise HTTPException(status_code=403, detail="Phone pairing is off on this computer.")
        try:
            token, device = pairing_store.claim(body.code, body.label)
        except pairing.PairingError as e:
            raise HTTPException(status_code=403, detail=str(e))
        response = JSONResponse({"ok": True, "label": device["label"]})
        response.set_cookie(pairing.COOKIE, token, max_age=pairing.TOKEN_SECONDS, path="/",
                            httponly=True, samesite="strict")
        return response

    @app.get("/api/files/roots")
    def file_roots() -> dict:
        return {"roots": files.list_roots()}

    @app.get("/api/files/list")
    def file_list(path: str = Query(..., max_length=4096)) -> dict:
        try:
            return files.list_dir(path)
        except files.FileAccessError as e:
            raise _file_error(e)

    @app.get("/api/files/read")
    def file_read(path: str = Query(..., max_length=4096)) -> dict:
        try:
            return files.read_preview(path)
        except files.FileAccessError as e:
            raise _file_error(e)

    if serve_ui and config.WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="ui")

    app.add_middleware(LocalOnlyGuard, pairing_store=pairing_store)  # outermost: runs before every route and file
    return app
