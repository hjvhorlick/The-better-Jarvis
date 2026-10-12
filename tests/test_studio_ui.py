"""The Studio room is there, registered, and wired to the code that backs it.

The room's behaviour is checked by /tmp/test_studio.mjs under a DOM shim. These
tests guard the parts that would silently break the room in the browser: the
slide existing, the tools having handlers, and the routes it calls existing.
"""
import pathlib

WEB = pathlib.Path(__file__).resolve().parents[1] / "web"
BACKEND = pathlib.Path(__file__).resolve().parents[1] / "backend"

STUDIO = WEB / "environments" / "studio.js"
REGISTER = WEB / "environments" / "register.js"


def _read(path):
    return path.read_text(encoding="utf-8")


def test_the_studio_room_exists_and_is_plain_javascript():
    assert STUDIO.exists()
    text = _read(STUDIO)
    assert text.startswith("/*")
    assert "export default" in text
    # It must not need a build step or an external service at load time.
    for bad in ("import {", "require("):
        assert bad not in text, bad


def test_the_studio_is_registered_as_an_environment():
    text = _read(REGISTER)
    assert 'id: "studio"' in text
    assert "Studio" in text


def test_every_studio_tool_button_gets_a_handler():
    text = _read(STUDIO)
    # Each tool() call adds one listener, and none is left dangling.
    assert text.count("b.addEventListener(\"click\", run)") == 1
    assert text.count("tool(") >= 6


def test_the_studio_talks_to_the_routes_that_exist():
    """Every path the room fetches must be a route media.py registers."""
    room = _read(STUDIO)
    backend = _read(BACKEND / "media.py")
    for call in ("/api/media/script", "/api/media/image", "/api/media/library",
                 "/api/media/save", "/api/media/options",
                 "/api/media/file/"):
        assert call in room, call
    # The library routes take a kind and a filename.
    assert "/api/media/file/{kind}/{filename}" in backend


def test_the_studio_keeps_text_out_of_html():
    """Nothing from the server is written with innerHTML."""
    room = _read(STUDIO)
    assert "innerHTML" not in room


def test_the_studio_never_names_another_project():
    room = _read(STUDIO).lower()
    for banned in ("barehands", "sim hand"):
        assert banned not in room, banned


def test_the_studio_says_where_the_video_goes():
    """Scenering is the owner's own app, and the room must point at it."""
    room = _read(STUDIO)
    assert "https://scenering.com" in room


def test_the_compiled_video_is_a_webm_recorded_in_the_browser():
    """There is no ffmpeg here; the recording has to be MediaRecorder."""
    room = _read(STUDIO)
    assert "MediaRecorder" in room
    assert "captureStream" in room
    # It must not shell out to a program the owner does not have.
    for shelled in ("subprocess", "spawn(", "execFile", "child_process"):
        assert shelled not in room, shelled


def test_the_studio_layout_stretches_to_the_work_area():
    css = _read(WEB / "styles.css")
    assert ".studio {" in css
    assert "grid-template-areas" in css
    # It has to shrink on a small window rather than overflow.
    assert ".studio-readout" in css
    assert "@media (max-width: 900px)" in css


def test_the_studio_offers_the_requested_video_formats():
    room = _read(STUDIO)
    for shape in ("9:16", "16:9"):
        assert shape in room, shape
    assert '["1:1"' not in room
    assert '["4:5"' not in room


def test_saved_video_projects_use_primary_node_routes_and_keep_handoff_manual():
    root = pathlib.Path(__file__).resolve().parents[1]
    server = _read(root / "server.ts")
    projects = _read(root / "studio" / "projects.ts")
    room = _read(STUDIO)
    for route in ("/api/studio/projects", "/api/studio/scripts", "/api/studio/research-reports"):
        assert route in projects, route
    assert "registerStudioRoutes(app, requireAuth" in server
    assert "sceneringImportSupported: false" in projects
    assert "manual-copy" in projects
    assert "Nothing was sent" in room
    assert "sourceScript" in room
    assert "Authorization: `Bearer ${token}`" in room


def test_voice_and_chat_studio_commands_reach_the_rooms_iframe():
    root = pathlib.Path(__file__).resolve().parents[1]
    dashboard = _read(root / "dashboard" / "static" / "app.html")
    assert "m.type === 'studio_control'" in dashboard
    assert "openStudioForCommand(m.command)" in dashboard
    assert "msg.type === 'studio_ready'" in dashboard
    room = _read(STUDIO)
    assert 'message.type !== "studio_control"' in room
    assert 'command.action === "open-project"' in room


def test_the_picture_model_can_be_chosen():
    room = _read(STUDIO)
    assert "flux" in room and "turbo" in room
