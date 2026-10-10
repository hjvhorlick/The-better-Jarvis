"""The shell's layout: the voice visualiser and the chat live in the thin rail.

The owner's rule is that the voice visualiser sits at the top left, the chat
underneath it, both as thin as possible so the working area stays large, and
that everything else has its button on the top line. It is checked here because
the visualiser went missing once already: the code that drives it survived, the
element it drives did not, and the app stopped updating its own status on start.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web" / "styles.css").read_text(encoding="utf-8")
APP = (ROOT / "web" / "app.js").read_text(encoding="utf-8")


def _ids():
    return set(re.findall(r'id="([a-z0-9-]+)"', HTML))


def test_the_voice_visualiser_is_on_the_page():
    """Without it the app's start-up code throws and the status never updates."""
    assert "ring" in _ids(), "the voice visualiser element is missing"
    assert "ring-label" in _ids(), "the voice visualiser has no label"


def test_the_visualiser_and_the_chat_sit_in_the_left_rail():
    """The rail holds the visualiser on top and the conversation below it."""
    assert "sidebar" in _ids() and "rail-body" in _ids()
    rail = HTML[HTML.index('id="sidebar"'):HTML.index("</aside>")]
    # The visualiser comes before the chat, so it is at the top.
    assert rail.index('id="ring"') < rail.index('id="log"')
    assert rail.index('id="log"') < rail.index('id="composer"')


def test_the_rail_can_be_squeezed_thin():
    """It must be possible to give almost all the room back to the work."""
    assert ".sidebar.is-thin" in CSS
    thin = CSS[CSS.index(".sidebar.is-thin"):]
    assert "width" in thin.split("}")[0]


def test_the_rail_squeeze_button_is_wired_up():
    """A control that does nothing is worse than no control."""
    assert "rail-toggle" in _ids()
    assert "setRailThin" in APP
    assert 'addEventListener("click"' in APP[APP.index("el.railToggle"):]


def test_the_top_line_holds_the_functions():
    """Every function that is not tied to one environment has its button on the
    top line, not buried in a window."""
    topbar = HTML[HTML.index('class="topbar"'):HTML.index("</header>")]
    for control in ("btn-diag", "env-switcher", "btn-myhands", "quota-chip"):
        assert f'id="{control}"' in topbar, f"{control} is not on the top line"
    assert 'class="workbench"' in HTML


def test_there_is_a_2d_room_as_well_as_the_3d_one():
    """Flat designing in images and video, next door to the 3D room."""
    register = (ROOT / "web" / "environments" / "register.js").read_text(encoding="utf-8")
    assert 'id: "flat"' in register
    assert 'id: "design"' in register
    assert (ROOT / "web" / "environments" / "flat.js").is_file()


def test_the_2d_room_declares_the_tools_its_job_needs():
    flat = (ROOT / "web" / "environments" / "flat.js").read_text(encoding="utf-8")
    for tool in ("brush", "eraser", "line", "rect", "ellipse", "fill", "text",
                 "pick", "undo", "redo", "image", "video", "layer", "save"):
        assert f'"{tool}"' in flat, f"the 2D room is missing the {tool} tool"


def test_the_2d_room_reads_the_hand_too():
    """The hand is the main peripheral, in the flat room as much as the 3D one."""
    flat = (ROOT / "web" / "environments" / "flat.js").read_text(encoding="utf-8")
    assert "/ws/myhands" in flat
    assert "pinch_started" in flat and "fist_started" in flat
