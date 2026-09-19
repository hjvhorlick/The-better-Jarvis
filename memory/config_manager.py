import json
import sys
from pathlib import Path

def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent

BASE_DIR    = get_base_dir()
CONFIG_DIR  = BASE_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "api_keys.json"

def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

def config_exists() -> bool:
    return CONFIG_FILE.exists()

def save_api_keys(gemini_api_key: str) -> None:
    ensure_config_dir()

    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}

    data["gemini_api_key"] = gemini_api_key.strip()

    CONFIG_FILE.write_text(
        json.dumps(data, indent=2),
        encoding="utf-8"
    )

def load_api_keys() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"❌ Failed to load api_keys.json: {e}")
        return {}

def get_gemini_key() -> str | None:
    return load_api_keys().get("gemini_api_key")

def is_configured() -> bool:
    key = get_gemini_key()
    return bool(key and len(key) > 15)


def get_assistant_name() -> str:
    """Return the configured assistant name, or 'JARVIS' if not set."""
    return load_api_keys().get("assistant_name", "JARVIS") or "JARVIS"


def get_user_name() -> str:
    """Return the configured user name for addressing."""
    return load_api_keys().get("user_name", "")


def save_assistant_config(assistant_name: str, user_name: str) -> None:
    """Persist assistant name and user name to config."""
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data["assistant_name"] = assistant_name.strip() or "JARVIS"
    data["user_name"] = user_name.strip()
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")


# ── Assistant voice ──────────────────────────────────────────────────────────
# Gemini Live prebuilt voices. Names are proper nouns — identical in every
# language, so this list is safe to show verbatim in any locale.
# @@VOICE_UPGRADE@@
# All 30 Gemini native-audio voices. Live API accepts every TTS voice name.
# (gender, character) — labels are Google's own.
VOICE_INFO = {
    # ── male ──
    "Charon":        ("M", "Informative, deep, measured"),
    "Orus":          ("M", "Firm, authoritative"),
    "Enceladus":     ("M", "Breathy, calm, intimate"),
    "Iapetus":       ("M", "Clear, precise"),
    "Algieba":       ("M", "Smooth, refined"),
    "Alnilam":       ("M", "Firm, steady"),
    "Schedar":       ("M", "Even, composed"),
    "Sadaltager":    ("M", "Knowledgeable, professorial"),
    "Rasalgethi":    ("M", "Informative, warm"),
    "Umbriel":       ("M", "Easy-going, relaxed"),
    "Achird":        ("M", "Friendly, approachable"),
    "Algenib":       ("M", "Gravelly, gruff"),
    "Zubenelgenubi": ("M", "Casual, conversational"),
    "Sadachbia":     ("M", "Lively, energetic"),
    "Puck":          ("M", "Upbeat, light"),
    "Fenrir":        ("M", "Excitable, forceful"),
    # ── female ──
    "Kore":          ("F", "Firm, crisp"),
    "Aoede":         ("F", "Breezy, natural"),
    "Zephyr":        ("F", "Bright, clear"),
    "Leda":          ("F", "Youthful"),
    "Autonoe":       ("F", "Bright, confident"),
    "Callirrhoe":    ("F", "Easy-going"),
    "Despina":       ("F", "Smooth, polished"),
    "Erinome":       ("F", "Clear, articulate"),
    "Laomedeia":     ("F", "Upbeat"),
    "Achernar":      ("F", "Soft, gentle"),
    "Gacrux":        ("F", "Mature, assured"),
    "Pulcherrima":   ("F", "Forward, direct"),
    "Vindemiatrix":  ("F", "Gentle, kind"),
    "Sulafat":       ("F", "Warm, rich"),
}
AVAILABLE_VOICES = list(VOICE_INFO)
DEFAULT_VOICE    = "Charon"

# Speaking-style presets — injected into the system prompt so the Live model
# delivers its speech that way. The voice sets the timbre; the style sets the
# accent, pace and attitude. Combine freely.
VOICE_STYLES = {
    "Jarvis — British butler (RP)": (
        "SPEAKING STYLE: Speak in refined British English — Received Pronunciation, "
        "the register of a classic English gentleman's valet. Calm, dry, understated, "
        "unhurried, with a light wit. British vowels and idiom throughout; never American. "
        "Never shout, never gush. Occasional 'sir', never every sentence."
    ),
    "Jarvis — Iron Man (dry, witty)": (
        "SPEAKING STYLE: British English (RP). Crisp, quick, quietly amused. Dry humour "
        "and gentle sarcasm when the moment allows, always loyal, never mocking. Short "
        "sentences. Sounds like a brilliant, slightly bored English butler who runs a lab."
    ),
    "Jarvis — Calm mission control": (
        "SPEAKING STYLE: British English. Low, even, unflappable — the voice of a "
        "flight controller. Measured pace, clear diction, no filler words, no exclamation. "
        "Reassuring under pressure."
    ),
    "British — warm mentor": (
        "SPEAKING STYLE: Warm, gentle British English. Patient and encouraging, like a "
        "kind professor. Slightly slower pace, explains things plainly."
    ),
    "British — cheeky London": (
        "SPEAKING STYLE: Modern London English, relaxed and cheeky. Friendly banter, "
        "quick, informal, but still gets straight to the point."
    ),
    "Scottish — steady & wry": (
        "SPEAKING STYLE: Soft Scottish English accent (Edinburgh). Steady, wry, "
        "grounded. Understated humour, plain words."
    ),
    "Irish — easy & warm": (
        "SPEAKING STYLE: Gentle Irish English accent (Dublin). Warm, musical, "
        "easy-going, friendly."
    ),
    "South African — clear & direct": (
        "SPEAKING STYLE: South African English accent. Clear, direct, warm, relaxed."
    ),
    "American — crisp assistant": (
        "SPEAKING STYLE: Neutral American English. Crisp, efficient, friendly, concise."
    ),
    "Neutral (voice default)": "",
}
DEFAULT_VOICE_STYLE = "Jarvis — British butler (RP)"


def get_voice_style() -> str:
    v = load_api_keys().get("voice_style", DEFAULT_VOICE_STYLE) or DEFAULT_VOICE_STYLE
    return v if v in VOICE_STYLES else DEFAULT_VOICE_STYLE


def get_voice_style_text() -> str:
    """The prompt fragment for the active style ('' for neutral)."""
    return VOICE_STYLES.get(get_voice_style(), "")


def save_voice_style(style: str) -> None:
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data["voice_style"] = style if style in VOICE_STYLES else DEFAULT_VOICE_STYLE
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")



def get_voice() -> str:
    """Return the configured Live voice, falling back to the default if unset
    or if the stored value is not a voice we recognise."""
    v = load_api_keys().get("voice_name", DEFAULT_VOICE) or DEFAULT_VOICE
    return v if v in AVAILABLE_VOICES else DEFAULT_VOICE


def save_voice(voice_name: str) -> None:
    """Persist the chosen Live voice. Unknown names collapse to the default so a
    bad value can never reach the API and break the session."""
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    v = (voice_name or "").strip()
    data["voice_name"] = v if v in AVAILABLE_VOICES else DEFAULT_VOICE
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")


def get_wake_word_enabled() -> bool:
    """Whether local wake-word gating is on (assistant sleeps until 'Hey Jarvis')."""
    return load_api_keys().get("wake_word_enabled", False)


def save_wake_word_enabled(enabled: bool) -> None:
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data["wake_word_enabled"] = bool(enabled)
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")


def get_brief_enabled() -> bool:
    return load_api_keys().get("morning_brief_enabled", True)


def save_brief_enabled(enabled: bool) -> None:
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data["morning_brief_enabled"] = enabled
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")


# ── Audio devices ────────────────────────────────────────────────────────────
# Stored as device NAMES, not sounddevice indices. Indices shift every time a
# USB device is plugged in or removed, so a saved index silently starts pointing
# at a different microphone. The empty string means "system default", which is
# both the factory setting and what an unresolvable saved device falls back to —
# so unplugging a headset degrades to the built-in speakers instead of crashing.

def _patch_config(**fields) -> None:
    """Read-modify-write one or more keys in api_keys.json.

    Every setter in this file open-coded this. Collapsing it here means a new
    setting is one line, and there is one place where a corrupt config file is
    handled instead of nine."""
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data.update(fields)
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")


def get_input_device() -> str:
    """Microphone device name, or '' for the system default."""
    return (load_api_keys().get("input_device", "") or "").strip()


def save_input_device(name: str) -> None:
    _patch_config(input_device=(name or "").strip())


def get_output_device() -> str:
    """Speaker device name, or '' for the system default."""
    return (load_api_keys().get("output_device", "") or "").strip()


def save_output_device(name: str) -> None:
    _patch_config(output_device=(name or "").strip())


def get_plugin_enabled(plugin_name: str) -> bool:
    """Plugins are enabled by default the moment they're discovered (opt-out model)."""
    return load_api_keys().get("plugins_enabled", {}).get(plugin_name, True)


# ── Per-plugin settings ("tokens" / connection details) ───────────────────────
# Generic store so a plugin can declare its own config fields (PLUGIN_SETTINGS)
# and the settings UI renders + persists them WITHOUT any core edit — keeping the
# drop-in model intact. Values live under plugin_config[<namespace>][<key>].
# A namespace defaults to the plugin name, but a suite of plugins (e.g. the
# printer control/watchdog/autoeject trio) can share ONE namespace.
def get_plugin_config(namespace: str) -> dict:
    """All stored values for a namespace (empty dict if none set yet)."""
    cfg = load_api_keys().get("plugin_config")
    val = cfg.get(namespace) if isinstance(cfg, dict) else None
    return dict(val) if isinstance(val, dict) else {}


def get_plugin_setting(namespace: str, key: str, default=None):
    """A single value from a namespace, or `default` if unset."""
    return get_plugin_config(namespace).get(key, default)


def save_plugin_config(namespace: str, values: dict) -> None:
    """Merge `values` into a namespace's stored config (read-modify-write, like
    every other helper here). Only the provided keys are touched."""
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    pc = data.get("plugin_config")
    if not isinstance(pc, dict):
        pc = {}
    cur = pc.get(namespace)
    if not isinstance(cur, dict):
        cur = {}
    cur.update(values)
    pc[namespace] = cur
    data["plugin_config"] = pc
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")


def save_plugin_enabled(plugin_name: str, enabled: bool) -> None:
    ensure_config_dir()
    data: dict = {}
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    plugins_cfg = data.get("plugins_enabled")
    if not isinstance(plugins_cfg, dict):
        plugins_cfg = {}
    plugins_cfg[plugin_name] = enabled
    data["plugins_enabled"] = plugins_cfg
    CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")