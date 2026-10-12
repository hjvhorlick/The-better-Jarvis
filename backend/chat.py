"""Text chat service: Gemini requests, persona, local memory, and honest provider diagnostics."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable
from urllib.parse import urlparse

from . import config
from .persona import build_system_instruction, load_prompt_text
from .workspaces import DEFAULT_WORKSPACE, workspace_block


class BackendNotConfigured(RuntimeError):
    """No Gemini API key is available."""


class UpstreamError(RuntimeError):
    """Gemini returned an error. The message never contains the API key or provider body."""

    def __init__(self, message: str, quota: bool = False) -> None:
        super().__init__(message)
        self.quota = quota


@dataclass(frozen=True)
class GroundedResult:
    text: str
    sources: list[dict]


def _is_quota_error(exc: BaseException) -> bool:
    """Inspect the error's status only. Its message is never returned or logged."""
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code == 429:
        return True
    status = str(getattr(exc, "status", "") or "").upper()
    return status == "RESOURCE_EXHAUSTED"


def _field(value: Any, name: str, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _grounding_sources(response: Any) -> list[dict]:
    """Extract only safe HTTP(S) grounding URLs exposed by the installed Gemini SDK."""
    found: list[dict] = []
    candidates = _field(response, "candidates", []) or []
    for candidate in candidates:
        metadata = _field(candidate, "grounding_metadata") or _field(candidate, "groundingMetadata")
        chunks = _field(metadata, "grounding_chunks", []) or _field(metadata, "groundingChunks", []) or []
        for chunk in chunks:
            web = _field(chunk, "web") or _field(chunk, "web_page") or _field(chunk, "webPage")
            if web is None:
                continue
            uri = str(_field(web, "uri", "") or "").strip()
            title = str(_field(web, "title", "") or "").strip()
            if len(uri) > 1800 or any(ord(ch) < 32 for ch in uri):
                continue
            try:
                parsed = urlparse(uri)
            except ValueError:
                continue
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                continue
            if uri not in {row["url"] for row in found}:
                found.append({"url": uri, "title": title[:240]})
            if len(found) >= 12:
                return found
    return found


def _memory_blocks(*, include_dialogue: bool = True,
                   topic_scoped: bool = False) -> tuple[str, str, str]:
    """Return bounded memory, optional legacy dialogue, and the configured voice style.

    In Brain-managed chats, hide records explicitly scoped to another topic from the legacy
    global-memory formatter; the selected topic's records are injected separately by BrainStore.
    """
    memory_block = dialogue_block = style_text = ""
    try:
        from memory.memory_manager import load_memory, format_memory_for_prompt
        memory = load_memory()
        if topic_scoped and isinstance(memory, dict):
            memory = dict(memory)
            for category, records in memory.items():
                if isinstance(records, dict):
                    memory[category] = {key: record for key, record in records.items()
                                        if not (isinstance(record, dict) and record.get("topic_id"))}
        memory_block = format_memory_for_prompt(memory)
    except Exception as e:  # keep chat working if memory is unreadable; Brain writes fail closed
        print(f"[backend] memory unavailable ({type(e).__name__})")
    if include_dialogue:
        try:
            from memory.memory_manager import format_dialogue_for_prompt
            dialogue_block = format_dialogue_for_prompt(limit=10)
        except Exception as e:
            print(f"[backend] dialogue unavailable ({type(e).__name__})")
    try:
        from memory.config_manager import get_voice_style_text
        style_text = get_voice_style_text() or ""
    except Exception:
        style_text = ""
    return memory_block, dialogue_block, style_text


class ChatService:
    def __init__(
        self,
        client_factory: Callable[[str], Any] | None = None,
        model: str | None = None,
        max_history_turns: int = 12,
    ) -> None:
        self._client_factory = client_factory or _default_client_factory
        self._model = model or config.get_text_model()
        self._max_turns = max(1, int(max_history_turns))
        # Kept only for legacy direct callers that do not supply a persistent conversation.
        # The FastAPI Agent always supplies a topic-scoped history and never shares this list.
        self._history: list[dict] = []
        self._lock = threading.RLock()
        self._context_provider: Callable[[], str] | None = None
        self._provider_state = {"state": "not_tested", "last_success_at": None,
                                "last_failure_at": None, "last_failure": ""}

    @property
    def model(self) -> str:
        return self._model

    def set_context_provider(self, provider: Callable[[], str] | None) -> None:
        """Attach the Brain's active-topic context for the optional Gemini Live instruction."""
        self._context_provider = provider

    def system_instruction(self, now: datetime | None = None, workspace: str = DEFAULT_WORKSPACE,
                           *, context_block: str = "", brain_managed: bool = False) -> str:
        managed_context = brain_managed or self._context_provider is not None
        memory_block, dialogue_block, style_text = _memory_blocks(
            include_dialogue=not managed_context, topic_scoped=managed_context)
        if not context_block and self._context_provider is not None:
            try:
                context_block = self._context_provider() or ""
            except Exception as exc:
                # A failed context lookup is visible in diagnostics, not disguised as remembered context.
                print(f"[backend] Brain context unavailable ({type(exc).__name__})")
        return build_system_instruction(
            prompt_text=load_prompt_text(config.PROMPT_PATH),
            assistant_name=config.get_assistant_name(),
            user_name=config.get_user_name(),
            memory_block=memory_block,
            dialogue_block=dialogue_block,
            style_text=style_text,
            now=now or datetime.now(),
            workspace_block=workspace_block(workspace),
            context_block=context_block,
        )

    def complete(self, prompt: str, system: str, grounded: bool = False) -> str:
        """Stateless request used by repair proposals and research; never joins chat history."""
        return self._generate(prompt, system, grounded=grounded).text

    def complete_grounded(self, prompt: str, system: str) -> GroundedResult:
        """Grounded response plus actual Google Search citation metadata, when supplied by Gemini."""
        return self._generate(prompt, system, grounded=True)

    def probe(self) -> dict:
        """Make a real, budget-accounted provider request; never infer connectivity from key presence."""
        answer = self.complete("Reply with exactly: SUPPER_PROVIDER_OK", ""
                               "You are testing a live provider connection. Reply with exactly "
                               "SUPPER_PROVIDER_OK and no other text.")
        if answer.strip().casefold() != "supper_provider_ok":
            raise UpstreamError("Gemini responded, but the connectivity check did not match the expected text")
        return {"connected": True, "model": self.model, "response": answer.strip()}

    def provider_status(self) -> dict:
        with self._lock:
            return {"model": self.model, **self._provider_state,
                    "key_configured": config.get_gemini_api_key() is not None}

    def reply(self, text: str, workspace: str = DEFAULT_WORKSPACE, *,
              history: list[dict] | None = None, context_block: str = "",
              brain_managed: bool = False) -> str:
        text = (text or "").strip()
        if not text:
            raise ValueError("empty message")
        fallback_history = history is None
        with self._lock:
            source_history = self._history if fallback_history else list(history or [])
            contents = self._clean_history(source_history) + [{"role": "user", "parts": [{"text": text}]}]
            system = self.system_instruction(workspace=workspace, context_block=context_block,
                                             brain_managed=brain_managed)
            response = self._request(contents, system, grounded=False)
            answer = self._answer_text(response)
            if not answer:
                self._mark_provider(False, "empty_reply")
                raise UpstreamError("Gemini returned an empty reply")
            self._mark_provider(True)
            if fallback_history:
                self._history.extend([
                    {"role": "user", "parts": [{"text": text}]},
                    {"role": "model", "parts": [{"text": answer}]},
                ])
                self._history = self._history[-2 * self._max_turns:]
            return answer

    def _generate(self, prompt: str, system: str, *, grounded: bool) -> GroundedResult:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("empty prompt")
        response = self._request([{"role": "user", "parts": [{"text": prompt}]}], system,
                                 grounded=grounded)
        answer = self._answer_text(response)
        if not answer:
            self._mark_provider(False, "empty_reply")
            raise UpstreamError("Gemini returned an empty reply")
        self._mark_provider(True)
        return GroundedResult(answer, _grounding_sources(response) if grounded else [])

    def _request(self, contents: list[dict], system: str, *, grounded: bool):
        api_key = config.get_gemini_api_key()
        if not api_key:
            self._mark_provider(False, "not_configured", state="not_configured")
            raise BackendNotConfigured(
                "No Gemini API key. Set GEMINI_API_KEY or add gemini_api_key to config/api_keys.json.")
        cfg = {"system_instruction": system or ""}
        if grounded:
            cfg["tools"] = [{"google_search": {}}]
        try:
            client = self._client_factory(api_key)
            return client.models.generate_content(model=self._model, contents=contents, config=cfg)
        except Exception as exc:
            kind = type(exc).__name__
            self._mark_provider(False, kind)
            raise UpstreamError(f"Gemini request failed ({kind})", quota=_is_quota_error(exc)) from None

    @staticmethod
    def _answer_text(response: Any) -> str:
        return str(_field(response, "text", "") or "").strip()

    @staticmethod
    def _clean_history(history: list[dict]) -> list[dict]:
        cleaned = []
        for item in history[-24:]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if role not in ("user", "model"):
                continue
            parts = item.get("parts")
            if not isinstance(parts, list):
                continue
            text = " ".join(str(p.get("text", "")) for p in parts if isinstance(p, dict)).strip()
            if text:
                cleaned.append({"role": role, "parts": [{"text": text[:4000]}]})
        return cleaned

    def _mark_provider(self, success: bool, failure: str = "", *, state: str = "") -> None:
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with self._lock:
            if success:
                self._provider_state.update({"state": "connected", "last_success_at": now,
                                             "last_failure": ""})
            else:
                self._provider_state.update({"state": state or "failed", "last_failure_at": now,
                                             "last_failure": failure[:80]})


def _default_client_factory(api_key: str):
    from google import genai  # imported lazily so tests do not need the network
    return genai.Client(api_key=api_key)
