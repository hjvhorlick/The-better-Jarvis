"""The Studio: images, scripts, a media library, and the hand-off to Scenering.

What this module is for
-----------------------
The owner makes short videos. The pieces he needs are: a script and a title, a
picture for every shot, a place to keep them, and a way to get the script into
Scenering (his own web app, which turns a script into a video). Jarvis does the
writing; this module does the fetching, the storing and the handing over.

Where the pictures come from
----------------------------
Pollinations (https://pollinations.ai). It generates images with Flux and needs
no account, no API key and no budget, which is why it is here rather than a
service that bills per picture. Its free anonymous tier is throttled to roughly
one picture every fifteen seconds and may add a watermark; a free registered
account removes both. Nothing about that is hidden from the caller: whatever the
service says about itself is passed straight back.

Nothing here phones home on its own. A picture is only made when the owner asks
for one, and the only outbound call is to Pollinations.

Where things are kept
---------------------
`runtime/media/`, which is git-ignored: generated pictures, videos and audio are
outputs, not source. An index file next to them remembers the prompt, the size
and when each one was made, so the library survives a restart and can be
searched.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
from pathlib import Path

from . import config

# Pollinations' image endpoint. No key, no account: the prompt goes in the path.
POLLINATIONS_IMAGE = "https://image.pollinations.ai/prompt/{prompt}"
POLLINATIONS_MODELS = ("flux", "turbo", "kontext")

# Sizes that suit the places short videos actually get watched.
ASPECTS = {
    "16:9": (1280, 720),     # YouTube, landscape
    "9:16": (720, 1280),     # Shorts, Reels, TikTok
    "1:1": (1024, 1024),     # feed posts
    "4:5": (864, 1080),      # Instagram portrait
}

MAX_PROMPT = 2000
INDEX_NAME = "index.json"
MAX_SAVE_BYTES = 64 * 1024 * 1024
# What the library will keep. A browser's MediaRecorder produces WebM; a phone
# or a camera produces MP4 or MOV.
KEEPABLE = (".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4", ".mov",
            ".mp3", ".wav", ".ogg", ".m4a")

# The first bytes of the picture formats Pollinations can return. Checking these
# is what tells a real picture from an error page that arrived with a 200.
IMAGE_SIGNATURES = (
    b"\xff\xd8\xff",                 # JPEG
    b"\x89PNG\r\n\x1a\n",            # PNG
    b"RIFF",                            # WebP (RIFF....WEBP)
)


class MediaError(Exception):
    status = 400


def _looks_like_an_image(body: bytes) -> bool:
    """True when the bytes start the way a JPEG, PNG or WebP does."""
    if len(body) < 64:
        return False
    if body.startswith(b"\xff\xd8\xff") or body.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    return body.startswith(b"RIFF") and body[8:12] == b"WEBP"


def _slug(text: str, limit: int = 48) -> str:
    """A filename-safe fragment from a prompt, so files are recognisable."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return (s[:limit].strip("-")) or "image"


class MediaStore:
    """The library on disk: files plus a small index beside them."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root else (config.RUNTIME_DIR / "media")
        self._lock = threading.Lock()
        for sub in ("images", "video", "audio"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)

    # ---------- the index ----------
    @property
    def _index_path(self) -> Path:
        return self.root / INDEX_NAME

    def _read_index(self) -> dict:
        try:
            return json.loads(self._index_path.read_text(encoding="utf-8"))
        except Exception:
            return {"items": []}

    def _write_index(self, data: dict) -> None:
        tmp = self._index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(self._index_path)          # atomic: a crash cannot leave half a file

    def add(self, kind: str, filename: str, meta: dict) -> dict:
        with self._lock:
            data = self._read_index()
            entry = {
                "id": filename,
                "kind": kind,
                "name": meta.get("name") or filename,
                "url": f"/api/media/file/{kind}/{filename}",
                "made": meta.get("made") or time.time(),
                "prompt": (meta.get("prompt") or "")[:MAX_PROMPT],
                "size": meta.get("size"),
                "model": meta.get("model"),
                "source": meta.get("source") or "studio",
                "tags": list(meta.get("tags") or []),
            }
            data["items"] = [i for i in data["items"] if i.get("id") != filename] + [entry]
            self._write_index(data)
            return entry

    def list(self, kind: str | None = None, search: str = "") -> list[dict]:
        with self._lock:
            items = self._read_index()["items"]
        if kind:
            items = [i for i in items if i.get("kind") == kind]
        if search:
            needle = search.lower()
            items = [i for i in items
                     if needle in (i.get("name") or "").lower()
                     or needle in (i.get("prompt") or "").lower()
                     or any(needle in t.lower() for t in i.get("tags") or [])]
        # Newest first: the thing you just made is the thing you want.
        return sorted(items, key=lambda i: i.get("made") or 0, reverse=True)

    def get(self, kind: str, filename: str) -> dict | None:
        for item in self.list(kind=kind):
            if item.get("id") == filename:
                return item
        return None

    def path_for(self, kind: str, filename: str) -> Path | None:
        """Resolve a library file, refusing anything that is not inside the
        library. Names come from the index, but a request can name anything."""
        if kind not in ("images", "video", "audio"):
            return None
        if "/" in filename or "\\" in filename or filename.startswith("."):
            return None
        candidate = (self.root / kind / filename).resolve()
        try:
            candidate.relative_to((self.root / kind).resolve())
        except ValueError:
            return None
        return candidate if candidate.is_file() else None

    def remove(self, kind: str, filename: str) -> bool:
        path = self.path_for(kind, filename)
        if path is None:
            return False
        path.unlink(missing_ok=True)
        with self._lock:
            data = self._read_index()
            data["items"] = [i for i in data["items"] if i.get("id") != filename]
            self._write_index(data)
        return True

    def rename(self, kind: str, filename: str, name: str) -> dict | None:
        with self._lock:
            data = self._read_index()
            for item in data["items"]:
                if item.get("id") == filename:
                    item["name"] = (name or "").strip()[:120] or item["name"]
                    self._write_index(data)
                    return item
        return None

    def tag(self, kind: str, filename: str, tags: list[str]) -> dict | None:
        with self._lock:
            data = self._read_index()
            for item in data["items"]:
                if item.get("id") == filename:
                    item["tags"] = [str(t).strip()[:40] for t in tags if str(t).strip()][:12]
                    self._write_index(data)
                    return item
        return None

    def counts(self) -> dict:
        items = self.list()
        return {k: sum(1 for i in items if i.get("kind") == k)
                for k in ("images", "video", "audio")}


class ImageMaker:
    """Makes a picture from a prompt, through Pollinations.

    The fetch is injectable so the whole path can be tested without the network.
    """

    def __init__(self, store: MediaStore, fetch=None, timeout: float = 90.0) -> None:
        self.store = store
        self._fetch = fetch
        self.timeout = timeout

    def _get(self, url: str) -> tuple[int, bytes, str]:
        if self._fetch is not None:
            return self._fetch(url)
        import requests                      # only imported when actually used
        r = requests.get(url, timeout=self.timeout)
        return r.status_code, r.content, (r.headers.get("content-type") or "")

    def make(self, prompt: str, aspect: str = "16:9", model: str = "flux",
             seed: int | None = None, name: str = "") -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            raise MediaError("Say what the picture should show.")
        if len(prompt) > MAX_PROMPT:
            raise MediaError(f"That prompt is too long (over {MAX_PROMPT} characters).")
        if aspect not in ASPECTS:
            raise MediaError(f"Use one of: {', '.join(ASPECTS)}")
        if model not in POLLINATIONS_MODELS:
            raise MediaError(f"Use one of: {', '.join(POLLINATIONS_MODELS)}")
        if seed is None:
            seed = int(time.time() * 1000) % 1_000_000

        w, h = ASPECTS[aspect]
        query = urllib.parse.urlencode({
            "width": w, "height": h, "model": model, "seed": seed, "nologo": "true",
        })
        url = f"{POLLINATIONS_IMAGE.format(prompt=urllib.parse.quote(prompt))}?{query}"

        try:
            status, body, ctype = self._get(url)
        except Exception as e:
            raise MediaError(f"Could not reach the picture service ({type(e).__name__}). "
                             "Check the internet connection.") from None

        # A refusal comes back as JSON or as a page of HTML, never as a picture,
        # and it can arrive with a 200. Judge the bytes, not the status code.
        if status != 200 or not _looks_like_an_image(body):
            detail = ""
            try:
                detail = str(json.loads(body.decode("utf-8", "replace")).get("error") or "")
            except Exception:
                detail = body[:160].decode("utf-8", "replace").strip()
            raise MediaError(f"The picture service said no ({status}). {detail}".strip())

        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = f"{stamp}-{_slug(prompt)}-{seed}"
        folder = self.store.root / "images"
        folder.mkdir(parents=True, exist_ok=True)
        # Two pictures made in the same second with the same prompt must not
        # overwrite each other.
        filename = f"{base}.jpg"
        n = 2
        while (folder / filename).exists():
            filename = f"{base}-{n}.jpg"
            n += 1
        (folder / filename).write_bytes(body)

        return self.store.add("images", filename, {
            "name": name or prompt[:80],
            "prompt": prompt,
            "size": [w, h],
            "model": model,
            "source": "pollinations",
            "made": time.time(),
        })


# ---------- writing the script ----------

SCRIPT_SYSTEM = """You write short-video scripts for the owner. You reply with JSON only, no
markdown, no commentary. The shape is:

{
  "title": "the video title, under 70 characters",
  "title_variants": ["three other options, each different in angle"],
  "hook": "the first line, under 12 words, written to stop the scroll",
  "logline": "one sentence on what the video is",
  "shots": [
    {"narration": "what is said over this shot, one or two sentences",
     "on_screen": "the caption burned into the picture, under 8 words",
     "image_prompt": "a vivid description of the picture for this shot, in English",
     "seconds": 4}
  ],
  "description": "a short upload description",
  "hashtags": ["five to eight tags, no # symbol"]
}

Rules: the shots must add up to the length asked for. Every shot needs a
picture prompt that stands on its own, because a picture is generated from it
with no other context. Narration must be speakable aloud: short sentences, no
brackets, no stage directions. Reply in the language of the brief."""


def _numbers(text: str) -> list[int]:
    return [int(n) for n in re.findall(r"\d+", text or "")]


def parse_script(raw: str, seconds: int) -> dict:
    """Turn the model's reply into a script, tolerating a messy one.

    A model can wrap JSON in prose, use single quotes, or leave a field out. The
    owner still gets a usable script rather than an error, so every field is
    defaulted and the shot times are corrected to add up to the length asked for.
    """
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise MediaError("Jarvis did not return a script I could read. Try again.")
    blob = text[start:end + 1]
    try:
        data = json.loads(blob)
    except Exception:
        # Single quotes and trailing commas are the usual mistakes.
        fixed = re.sub(r"(?<![\\])'", '"', blob)
        fixed = re.sub(r",\\s*([}\\])", r"\\1", fixed)
        try:
            data = json.loads(fixed)
        except Exception:
            raise MediaError("Jarvis's reply was not valid JSON. Try again.") from None

    shots = []
    for s in (data.get("shots") or []):
        if not isinstance(s, dict):
            continue
        narration = str(s.get("narration") or "").strip()
        if not narration:
            continue
        shots.append({
            "narration": narration,
            "on_screen": str(s.get("on_screen") or "").strip()[:80],
            "image_prompt": str(s.get("image_prompt") or narration).strip()[:MAX_PROMPT],
            "seconds": max(1, min(60, int(s.get("seconds") or 4))),
        })
    if not shots:
        raise MediaError("The script came back with no shots. Try a clearer brief.")

    # Make the shots add up to the length asked for, keeping their proportions.
    total = sum(s["seconds"] for s in shots)
    if total > 0 and abs(total - seconds) > 1:
        for s in shots:
            s["seconds"] = max(1, round(s["seconds"] * seconds / total))

    return {
        "title": str(data.get("title") or "Untitled").strip()[:120],
        "title_variants": [str(t).strip()[:120] for t in (data.get("title_variants") or [])][:5],
        "hook": str(data.get("hook") or "").strip()[:200],
        "logline": str(data.get("logline") or "").strip()[:400],
        "shots": shots,
        "description": str(data.get("description") or "").strip()[:2000],
        "hashtags": [str(h).lstrip("#").strip()[:40] for h in (data.get("hashtags") or [])][:10],
        "seconds": sum(s["seconds"] for s in shots),
        "words": sum(len(s["narration"].split()) for s in shots),
    }


def scenering_payload(script: dict) -> dict:
    """The script laid out the way a script-to-video site expects.

    Scenering is the owner's own web application: it takes a script and makes a
    video. This prepares what it needs — the title, and the shots in order with
    their narration — as plain text he can paste, plus a copy he can hand to a
    browser. Nothing is sent anywhere by this function.
    """
    lines = [script.get("title") or "", ""]
    for i, shot in enumerate(script.get("shots") or [], 1):
        lines.append(f"{i}. {shot['narration']}")
        if shot.get("on_screen"):
            lines.append(f"   [on screen: {shot['on_screen']}]")
        lines.append("")
    body = "\n".join(lines).strip()

    return {
        "title": script.get("title") or "",
        "script": body,
        "plain": f"{script.get('title') or ''}\n\n{body}",
        "shots": len(script.get("shots") or []),
        "seconds": script.get("seconds") or 0,
        "url": "https://scenering.com",
    }


def script_from_brief(chat, budget, brief: str, seconds: int, aspect: str) -> dict:
    """Ask Jarvis for a script, counting it against the day's Gemini count.

    The count only warns — it never refuses. The one thing that does refuse is
    the app being offline (Google's own 429, no key, or the owner's switch), and
    then the owner is told rather than a request being made that cannot succeed.
    """
    brief = (brief or "").strip()
    if not brief:
        raise MediaError("Say what the video is about.")
    if not (5 <= seconds <= 600):
        raise MediaError("Ask for a video between 5 and 600 seconds.")
    if budget.offline or not budget.try_spend():
        raise MediaError(f"Writing that script needs the internet, and the app is offline — "
                         f"{budget.offline_reason()}. Nothing was fetched and nothing was counted. "
                         "It comes back at local midnight, or as soon as a working key is set.")
    try:
        raw = chat.complete(
            prompt=(f"Write a {seconds}-second short video script, {aspect} framing, about: {brief}\n\n"
                    "Reply with the JSON only."),
            system=SCRIPT_SYSTEM,
        )
    except Exception as e:
        raise MediaError(f"Jarvis could not write it ({type(e).__name__}).") from None
    return parse_script(raw, seconds)


# ---------- routes ----------

def register(app, chat=None, budget=None) -> None:
    """Studio routes. `chat` and `budget` are the app's own, so a script costs
    the same and is counted the same as any other Gemini call."""
    from fastapi import APIRouter
    from fastapi.responses import FileResponse, JSONResponse

    router = APIRouter()
    store = MediaStore()
    maker = ImageMaker(store)

    def _err(exc: MediaError):
        return JSONResponse({"detail": str(exc)}, status_code=getattr(exc, "status", 400))

    @router.get("/api/media/options")
    def options() -> dict:
        return {
            "aspects": ASPECTS,
            "models": list(POLLINATIONS_MODELS),
            "counts": store.counts(),
            "scenering": "https://scenering.com",
            "script_ready": bool(chat and budget),
        }

    @router.get("/api/media/library")
    def library(kind: str | None = None, q: str = "") -> dict:
        return {"items": store.list(kind=kind or None, search=q),
                "counts": store.counts()}

    @router.post("/api/media/image")
    async def make_image(body: dict) -> dict:
        try:
            return maker.make(
                prompt=body.get("prompt", ""),
                aspect=body.get("aspect", "16:9"),
                model=body.get("model", "flux"),
                seed=body.get("seed"),
                name=body.get("name", ""),
            )
        except MediaError as e:
            return _err(e)

    @router.post("/api/media/script")
    async def make_script(body: dict) -> dict:
        if not (chat and budget):
            return _err(MediaError("Jarvis is not wired up on this server."))
        try:
            script = script_from_brief(chat, budget, body.get("brief", ""),
                                       int(body.get("seconds", 30) or 30),
                                       body.get("aspect", "16:9"))
        except MediaError as e:
            return _err(e)
        except Exception:
            return _err(MediaError("Could not write that script."))
        script["scenering"] = scenering_payload(script)
        return script

    @router.post("/api/media/scenering")
    async def to_scenering(body: dict) -> dict:
        """Lay a script out for pasting into Scenering. Nothing is uploaded."""
        shots = body.get("shots")
        if not isinstance(shots, list) or not shots:
            return _err(MediaError("Give me the shots to lay out."))
        script = {"title": body.get("title", ""), "shots": shots,
                  "seconds": body.get("seconds", 0)}
        return scenering_payload(script)

    @router.post("/api/media/save")
    async def save(body: dict) -> dict:
        """Keep a file the browser made — a recorded video, say — in the library.

        The bytes arrive as base64 inside JSON rather than as a multipart upload:
        it needs no extra package, and a browser already has the blob in memory
        when it records one.
        """
        import base64
        import binascii

        kind = str(body.get("kind") or "")
        if kind not in ("images", "video", "audio"):
            return _err(MediaError("Kind must be images, video or audio."))
        raw = str(body.get("data") or "")
        if not raw:
            return _err(MediaError("That file was empty."))
        try:
            data = base64.b64decode(raw.split(",", 1)[-1], validate=False)
        except (binascii.Error, ValueError):
            return _err(MediaError("That file could not be read."))
        if not data:
            return _err(MediaError("That file was empty."))
        if len(data) > MAX_SAVE_BYTES:
            return _err(MediaError(f"That file is over {MAX_SAVE_BYTES // (1024 * 1024)} MB."))
        ext = str(body.get("ext") or "").lower()
        if not ext.startswith("."):
            ext = f".{ext}" if ext else ".bin"
        if ext not in KEEPABLE:
            return _err(MediaError(f"I cannot keep a {ext} file."))
        stamp = time.strftime("%Y%m%d-%H%M%S")
        filename = f"{stamp}-{_slug(body.get('name') or body.get('prompt') or 'file')}{ext}"
        (store.root / kind).mkdir(parents=True, exist_ok=True)
        (store.root / kind / filename).write_bytes(data)
        return store.add(kind, filename, {
            "name": str(body.get("name") or filename)[:120],
            "prompt": str(body.get("prompt") or "")[:MAX_PROMPT],
            "source": "studio", "made": time.time(),
        })

    @router.get("/api/media/file/{kind}/{filename}")
    def file(kind: str, filename: str):
        path = store.path_for(kind, filename)
        if path is None:
            return JSONResponse({"detail": "No such file."}, status_code=404)
        media = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".webp": "image/webp", ".webm": "video/webm", ".mp4": "video/mp4",
                 ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
                 ".ogg": "audio/ogg", ".m4a": "audio/mp4"}.get(path.suffix.lower())
        return FileResponse(path, media_type=media, filename=path.name)

    @router.delete("/api/media/file/{kind}/{filename}")
    def delete(kind: str, filename: str) -> dict:
        return {"removed": store.remove(kind, filename)}

    @router.patch("/api/media/file/{kind}/{filename}")
    async def patch(kind: str, filename: str, body: dict) -> dict:
        if "tags" in body:
            item = store.tag(kind, filename, body.get("tags") or [])
        else:
            item = store.rename(kind, filename, body.get("name", ""))
        if item is None:
            return JSONResponse({"detail": "No such file."}, status_code=404)
        return item

    app.include_router(router)
