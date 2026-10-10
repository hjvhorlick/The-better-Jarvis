/* Supper AI Agent — My Hands (browser side).
 *
 * The browser receives small gesture events from the backend over the local
 * WebSocket (/ws/myhands) and moves the desktop tiles the same way a mouse drag
 * would. It also shows the mirrored camera preview (/api/myhands/preview) on the
 * glass, while My Hands is on. The preview comes from this computer only; the
 * browser sends nothing but button presses. Text is written with textContent only.
 *
 * Requires app.js to be loaded first (it exposes window.SupperUI).
 */
(() => {
  "use strict";

  const SCENE_LIMIT = 50;          // backend limit on scene objects
  const SCENE_DEBOUNCE_MS = 150;
  const MAX_RECONNECTS = 5;

  const $ = (sel) => document.querySelector(sel);
  const btn = $("#btn-myhands");
  const chip = $("#mh-chip");
  const chipText = $("#mh-text");
  const cursor = $("#hand-cursor");
  const surface = $("#surface");
  const ui = window.SupperUI || { addMsg: () => {}, savePosition: () => {} };

  const st = {
    on: false,
    busy: false,
    ws: null,
    seq: 0,
    reconnects: 0,
    reconnectTimer: null,
    sceneTimer: null,
    lastSceneSig: "",
    sceneTiles: new Map(),   // object id -> tile element
    grabbed: null,           // tile currently held by a pinch
  };

  // ---------- helpers ----------
  async function call(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(path, opts);
    let data = null;
    try { data = await resp.json(); } catch (_) { /* non-JSON */ }
    if (!resp.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `HTTP ${resp.status}`;
      throw new Error(detail);
    }
    return data;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function setChip(text, cls) {
    chip.hidden = false;
    chip.className = `mh-chip ${cls || ""}`.trim();
    chipText.textContent = text;
  }

  // ---------- camera preview on the glass (this computer's picture, mirrored by the server) ----------
  const view = $("#mh-view");
  const viewImg = $("#mh-preview");
  const viewBtn = $("#btn-mh-view");
  const VIEW_KEY = "supper.mhView";
  st.viewWanted = (() => {
    try { return localStorage.getItem(VIEW_KEY) !== "off"; } catch (_) { return true; }
  })();

  // The picture is on only while My Hands is on and the owner wants it. Setting the address
  // starts the stream; removing it closes the connection.
  function setPreview(on) {
    if (on && st.viewWanted) {
      viewImg.src = `/api/myhands/preview?t=${Date.now()}`;   // relative address: this computer
      view.hidden = false;
    } else {
      viewImg.removeAttribute("src");
      view.hidden = true;
    }
    viewBtn.hidden = !on;
    viewBtn.textContent = st.viewWanted ? "Hide camera" : "Show camera";
    viewBtn.setAttribute("aria-pressed", st.viewWanted ? "true" : "false");
  }

  viewImg.addEventListener("error", () => {
    if (!viewImg.getAttribute("src")) return;   // we removed it ourselves
    view.hidden = true;                          // refused (not on, or camera busy): no picture, quietly
  });

  viewBtn.addEventListener("click", () => {
    st.viewWanted = !st.viewWanted;
    try { localStorage.setItem(VIEW_KEY, st.viewWanted ? "on" : "off"); } catch (_) { /* private mode */ }
    setPreview(st.on);
  });

  function setButton(on) {
    st.on = on;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "Stop My Hands" : "My Hands";
    btn.disabled = st.busy;
    setPreview(on);
    if (!on) {
      chip.hidden = true;
      cursor.hidden = true;
      cursor.classList.remove("pinched");
    }
  }

  // ---------- scene: the tiles, in stage units (0..1 of the desktop area) ----------
  function currentScene() {
    const W = surface.clientWidth, H = surface.clientHeight;
    if (!W || !H) return { objects: [], map: new Map() };
    const tiles = Array.from(surface.querySelectorAll(".tile")).slice(0, SCENE_LIMIT);
    const map = new Map();
    const objects = [];
    tiles.forEach((tile, i) => {
      const left = parseFloat(tile.style.left) || 0;
      const top = parseFloat(tile.style.top) || 0;
      const w = clamp(tile.offsetWidth / W, 0.01, 1);
      const h = clamp(tile.offsetHeight / H, 0.01, 1);
      const x = clamp(left / W, 0, 1 - w);
      const y = clamp(top / H, 0, 1 - h);
      const id = `t${i}`;
      map.set(id, tile);
      objects.push({ id, x: round(x), y: round(y), w: round(w), h: round(h), z: i });
    });
    return { objects, map };
  }

  function round(v) { return Math.round(v * 10000) / 10000; }

  function scheduleSceneSync() {
    if (!st.on) return;
    clearTimeout(st.sceneTimer);
    st.sceneTimer = setTimeout(syncScene, SCENE_DEBOUNCE_MS);
  }

  async function syncScene() {
    if (!st.on || st.grabbed) return;      // never sync mid-grab; the release triggers a sync
    const { objects, map } = currentScene();
    st.sceneTiles = map;
    const sig = JSON.stringify(objects);
    if (sig === st.lastSceneSig) return;
    try {
      await call("PUT", "/api/myhands/scene", { objects });
      st.lastSceneSig = sig;
    } catch (err) {
      ui.addMsg("system", `My Hands could not read the desktop layout: ${err.message}`);
    }
  }

  // ---------- applying gesture events to the desktop ----------
  function moveCursor(nx, ny) {
    const r = surface.getBoundingClientRect();
    cursor.hidden = false;
    cursor.style.left = `${r.left + nx * r.width}px`;
    cursor.style.top = `${r.top + ny * r.height}px`;
  }

  function placeTile(tile, nx, ny) {
    const W = surface.clientWidth, H = surface.clientHeight;
    tile.style.left = `${nx * W}px`;
    tile.style.top = `${ny * H}px`;
  }

  function tileName(tile) {
    const n = tile && tile.querySelector(".name");
    return n ? n.textContent : "item";
  }

  const REASON_TEXT = {
    release: "dropped",
    tracking_lost: "hand lost, dropped where it was last seen",
    camera_failed: "camera failed, dropped",
    session_stopped: "My Hands stopped, dropped",
  };

  function handle(ev) {
    switch (ev.type) {
      case "session_started":
        setChip("looking for a hand", "live");
        break;
      case "hand_detected":
        setChip("hand found", "live");
        break;
      case "hand_lost":
        setChip("looking for a hand", "live");
        cursor.hidden = true;
        cursor.classList.remove("pinched");
        break;
      case "cursor_moved":
        moveCursor(ev.x, ev.y);
        break;
      case "pinch_started":
        cursor.classList.add("pinched");
        break;
      case "pinch_released":
        cursor.classList.remove("pinched");
        break;
      case "object_grabbed": {
        const tile = st.sceneTiles.get(ev.id);
        if (tile) { tile.classList.add("grabbed"); st.grabbed = tile; }
        break;
      }
      case "object_dragged": {
        const tile = st.sceneTiles.get(ev.id);
        if (tile) placeTile(tile, ev.x, ev.y);
        break;
      }
      case "object_released": {
        const tile = st.sceneTiles.get(ev.id) || st.grabbed;
        if (tile) {
          placeTile(tile, ev.x, ev.y);
          tile.classList.remove("grabbed");
          ui.savePosition(tile.dataset.key, parseFloat(tile.style.left) || 0, parseFloat(tile.style.top) || 0);
          if (ev.reason !== "release") {
            ui.addMsg("system", `${tileName(tile)}: ${REASON_TEXT[ev.reason] || ev.reason}`);
          }
        }
        st.grabbed = null;
        scheduleSceneSync();
        break;
      }
      case "tracking_unavailable":
        setChip(ev.reason || "tracking paused", "bad");
        ui.addMsg("system", `Hand tracking paused: ${ev.reason || "unknown reason"}`);
        break;
      case "auto_off":
        break;                                  // the message comes with session_stopped (reason auto_off)
      case "session_stopped":
        handleStopped(ev.reason);
        break;
      default:
        break;
    }
  }

  function handleStopped(reason) {
    if (st.grabbed) { st.grabbed.classList.remove("grabbed"); st.grabbed = null; }
    closeSocket();
    setButton(false);
    if (reason && reason !== "user") {
      const text = {
        auto_off: "My Hands turned off after a long time without a hand. Camera released.",
        camera_failed: "My Hands stopped because the camera failed. Camera released.",
        tracker_failed: "My Hands stopped because hand tracking could not start. Camera released.",
      }[reason] || `My Hands stopped (${reason}).`;
      ui.addMsg("system", text);
    }
  }

  // ---------- socket ----------
  function socketUrl() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}/ws/myhands?since=${st.seq}`;
  }

  function openSocket() {
    closeSocket();
    const ws = new WebSocket(socketUrl());
    st.ws = ws;
    ws.onopen = () => { st.reconnects = 0; };
    ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch (_) { return; }
      if (typeof data.seq === "number") st.seq = Math.max(st.seq, data.seq);
      if (data.event) handle(data.event);
    };
    ws.onclose = () => {
      if (st.ws !== ws) return;             // we closed it on purpose
      st.ws = null;
      if (!st.on) return;
      if (st.reconnects >= MAX_RECONNECTS) {
        setChip("connection lost", "bad");
        ui.addMsg("system", "My Hands lost its connection. Press My Hands to start again.");
        setButton(false);
        return;
      }
      st.reconnects += 1;
      clearTimeout(st.reconnectTimer);
      st.reconnectTimer = setTimeout(openSocket, 500 * st.reconnects);
    };
  }

  function closeSocket() {
    clearTimeout(st.reconnectTimer);
    if (st.ws) {
      const ws = st.ws;
      st.ws = null;
      try { ws.close(); } catch (_) { /* already closed */ }
    }
  }

  // ---------- user actions ----------
  async function start() {
    st.busy = true; btn.disabled = true;
    setChip("starting camera…", "live");
    try {
      const status = await call("POST", "/api/myhands/start", { mode: "my_hands" });
      st.seq = status.last_event_seq || 0;
      st.reconnects = 0;
      setButton(true);
      await syncScene();
      openSocket();
    } catch (err) {
      setButton(false);
      ui.addMsg("system", `My Hands did not start: ${err.message}`);
    } finally {
      st.busy = false; btn.disabled = false;
    }
  }

  async function stop() {
    st.busy = true; btn.disabled = true;
    try {
      await call("POST", "/api/myhands/stop");
    } catch (err) {
      ui.addMsg("system", `Could not confirm My Hands stopped: ${err.message}`);
    } finally {
      st.busy = false;
      // The session emits session_stopped; if the socket is already gone, finish locally.
      handleStopped("user");
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", () => (st.on ? stop() : start()));

  // The camera must not stay on after the page closes.
  window.addEventListener("pagehide", () => {
    if (st.on && navigator.sendBeacon) {
      navigator.sendBeacon("/api/myhands/stop", new Blob([], { type: "text/plain" }));
    }
  });

  // Keep the scene in step with the tiles (new folder, resize, mouse drag).
  const observer = new MutationObserver(() => scheduleSceneSync());
  observer.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", scheduleSceneSync);

  // On page load, pick up a session that is already running (after a reload).
  (async () => {
    try {
      const status = await call("GET", "/api/myhands/status");
      if (status.running) {
        st.seq = status.last_event_seq || 0;   // do not replay old events
        setButton(true);
        setChip(status.hand_present ? "hand found" : "looking for a hand", "live");
        await syncScene();
        openSocket();
      } else {
        setButton(false);
      }
      if (!status.tracker_available) {
        btn.title = "Hand tracking libraries are not installed on this computer.";
      }
    } catch (_) {
      setButton(false);
    }
  })();
})();
