"""Text chat service: Gemini request with the persona, read-only memory.

M1 scope: text in, text out. Conversation turns are kept in process memory only
and are NOT written to the persistent store — writing memory from the browser
chat is a later milestone, after the owner backup and migration tests exist.
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Any, Callable

from . import config
from .persona import build_system_instruction, load_prompt_text
from .workspaces import DEFAULT_WORKSPACE, workspace_block


class BackendNotConfigured(RuntimeError):
    """No Gemini API key is available."""


class UpstreamError(RuntimeError):
    """Gemini returned an error. The message never contains the API key.

    `quota` is True when the provider said its limit is reached (HTTP 429).
    """

    def __init__(self, message: str, quota: bool = False) -> None:
        super().__init__(message)
        self.quota = quota


def _is_quota_error(exc: BaseException) -> bool:
    """Inspect the error's status only. Its message is never returned or logged."""
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code == 429:
        return True
    status = str(getattr(exc, "status", "") or "").upper()
    return status == "RESOURCE_EXHAUSTED"


def _memory_blocks() -> tuple[str, str, str]:
    """Return (memory_block, dialogue_block, style_text). Read-only."""
    memory_block = dialogue_block = style_text = ""
    try:
        from memory.memory_manager import load_memory, format_memory_for_prompt
        memory_block = format_memory_for_prompt(load_memory())
    except Exception as e:  # keep chat working if memory is unreadable
        print(f"[backend] memory unavailable: {type(e).__name__}")
    try:
        from memory.memory_manager import format_dialogue_for_prompt
        dialogue_block = format_dialogue_for_prompt(limit=10)
    except Exception as e:
        print(f"[backend] dialogue unavailable: {type(e).__name__}")
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
        self._max_turns = max_history_turns
        self._history: list[dict] = []
        self._lock = threading.Lock()

    @property
    def model(self) -> str:
        return self._model

    def system_instruction(self, now: datetime | None = None, workspace: str = DEFAULT_WORKSPACE) -> str:
        memory_block, dialogue_block, style_text = _memory_blocks()
        return build_system_instruction(
            prompt_text=load_prompt_text(config.PROMPT_PATH),
            assistant_name=config.get_assistant_name(),
            user_name=config.get_user_name(),
            memory_block=memory_block,
            dialogue_block=dialogue_block,
            style_text=style_text,
            now=now or datetime.now(),
            workspace_block=workspace_block(workspace),
        )

    def complete(self, prompt: str, system: str, grounded: bool = False) -> str:
        """One stateless request with its own instruction, for repair proposals and web search. It does not
        use the persona, does not join the chat history, and keeps the key on the server.
        grounded=True turns on Google Search for this request only (the same tool the legacy app used)."""
        api_key = config.get_gemini_api_key()
        if not api_key:
            raise BackendNotConfigured(
                "No Gemini API key. Set GEMINI_API_KEY or add gemini_api_key to config/api_keys.json.")
        try:
            client = self._client_factory(api_key)
            cfg = {"system_instruction": system}
            if grounded:
                cfg["tools"] = [{"google_search": {}}]
            response = client.models.generate_content(
                model=self._model,
                contents=[{"role": "user", "parts": [{"text": prompt}]}],
                config=cfg,
            )
        except Exception as e:
            raise UpstreamError(f"Gemini request failed ({type(e).__name__})",
                                quota=_is_quota_error(e)) from None
        answer = (getattr(response, "text", None) or "").strip()
        if not answer:
            raise UpstreamError("Gemini returned an empty reply")
        return answer

    def reply(self, text: str, workspace: str = DEFAULT_WORKSPACE) -> str:
        text = (text or "").strip()
        if not text:
            raise ValueError("empty message")
        api_key = config.get_gemini_api_key()
        if not api_key:
            raise BackendNotConfigured(
                "No Gemini API key. Set GEMINI_API_KEY or add gemini_api_key to config/api_keys.json."
            )
        with self._lock:
            contents = self._history + [{"role": "user", "parts": [{"text": text}]}]
            try:
                client = self._client_factory(api_key)
                response = client.models.generate_content(
                    model=self._model,
                    contents=contents,
                    config={"system_instruction": self.system_instruction(workspace=workspace)},
                )
            except BackendNotConfigured:
                raise
            except Exception as e:
                # Report the type only; provider messages may echo request details.
                raise UpstreamError(f"Gemini request failed ({type(e).__name__})",
                                    quota=_is_quota_error(e)) from None
            answer = (getattr(response, "text", None) or "").strip()
            if not answer:
                raise UpstreamError("Gemini returned an empty reply")
            self._history.append({"role": "user", "parts": [{"text": text}]})
            self._history.append({"role": "model", "parts": [{"text": answer}]})
            self._history = self._history[-2 * self._max_turns:]
            return answer


def _default_client_factory(api_key: str):
    from google import genai  # imported lazily so tests do not need the network
    return genai.Client(api_key=api_key)
