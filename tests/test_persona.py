from datetime import datetime

from backend.persona import FALLBACK_PROMPT, build_system_instruction, load_prompt_text
from backend.workspaces import WORKSPACES, workspace_block

NOW = datetime(2026, 10, 9, 9, 30)


def _build(**overrides):
    args = dict(
        prompt_text="PROMPT-BODY",
        assistant_name="JARVIS",
        user_name="",
        memory_block="MEMORY-BLOCK",
        dialogue_block="DIALOGUE-BLOCK",
        style_text="",
        now=NOW,
    )
    args.update(overrides)
    return build_system_instruction(**args)


def test_section_order_matches_desktop_app():
    text = _build(workspace_block="WORKSPACE-BLOCK")
    order = ["[CURRENT DATE & TIME]", "[IDENTITY]", "WORKSPACE-BLOCK",
             "MEMORY-BLOCK", "DIALOGUE-BLOCK", "PROMPT-BODY"]
    positions = [text.index(s) for s in order]
    assert positions == sorted(positions)


def test_identity_and_time_are_rendered():
    text = _build(assistant_name="Nova")
    assert "Your name is Nova." in text
    assert "October 09, 2026" in text
    assert "9:30 AM" in text


def test_user_name_used_when_set():
    assert "Always call the user 'Vincent'." in _build(user_name="Vincent")


def test_default_address_when_no_user_name():
    assert "sir" in _build(user_name="")


def test_style_is_prepended_to_prompt():
    text = _build(style_text="STYLE-PRESET")
    assert text.index("STYLE-PRESET") < text.index("PROMPT-BODY")


def test_empty_blocks_are_omitted():
    text = _build(memory_block="", dialogue_block="")
    assert "[IDENTITY]" in text and "PROMPT-BODY" in text


def test_missing_prompt_file_uses_fallback(tmp_path):
    assert load_prompt_text(tmp_path / "missing.txt") == FALLBACK_PROMPT


def test_real_prompt_file_loads_unchanged():
    from backend import config
    assert load_prompt_text(config.PROMPT_PATH) == config.PROMPT_PATH.read_text(encoding="utf-8")


def test_every_workspace_has_a_block():
    for name in WORKSPACES:
        assert workspace_block(name).startswith("[WORKSPACE]")
