/* JARVIS — the camera, in every room.
 * ============================================================================
 * The owner's rule: what is behind the glass is his own picture whenever the
 * camera is on, in the rooms as much as in the dashboard. There is exactly one
 * camera: the dashboard captures it and hands the live stream to this page, so
 * a machine that only lets one program read the camera still works. The order
 * this page tries, and why:
 *
 *   1. the stream the dashboard sent        — the same picture, one capture;
 *   2. the camera itself, if step 1 was refused by the browser — the picture
 *      is still his, just captured twice;
 *   3. the server's mirror (/api/myhands/preview, drawn by this computer) —
 *      used when My Hands is tracking, because the server already has a frame;
 *   4. nothing: the dark grey room, which is the normal state.
 *
 * Nothing here sends anything anywhere. The picture never leaves the computer,
 * and this file only ever draws a <video> or an <img>.
 */
(() => {
  "use strict";

  const body = document.body;
  const video = document.getElementById("env-camera");
  const mirror = document.getElementById("env-camera-mirror");   // the server's frame, if any
  const GLASS_KEY = "jarvis.glass.v2";
  const GLASS_DEFAULTS = {
    win: { alpha: 18, sand: 8 },
    panel: { alpha: 34, sand: 6 },
    room: { alpha: 14, sand: 6 },
    line: 62,
    bloom: 100,
  };

  function glassNumber(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  function loadSavedGlass() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(GLASS_KEY) || "{}") || {}; } catch (_) { saved = {}; }
    const glass = JSON.parse(JSON.stringify(GLASS_DEFAULTS));
    for (const kind of ["win", "panel", "room"]) {
      const source = saved[kind] || {};
      glass[kind] = {
        alpha: glassNumber(source.alpha, GLASS_DEFAULTS[kind].alpha, 0, 90),
        sand: glassNumber(source.sand, GLASS_DEFAULTS[kind].sand, 0, 100),
      };
    }
    glass.line = glassNumber(saved.line, GLASS_DEFAULTS.line, 0, 100);
    glass.bloom = glassNumber(saved.bloom, GLASS_DEFAULTS.bloom, 0, 150);
    return glass;
  }

  const st = {
    on: false,
    stream: null,          // handed over by the dashboard
    own: null,             // our own getUserMedia stream, if we had to
    mirrorOn: false,
    wanted: false,         // the owner asked for the camera
  };

  function show(on) {
    st.on = Boolean(on);
    body.classList.toggle("env-cam-on", st.on);
  }

  function setTools(open) {
    const visible = Boolean(open);
    body.classList.toggle("show-tools", visible);
    if (toolsToggle) {
      toolsToggle.setAttribute("aria-pressed", visible ? "true" : "false");
      toolsToggle.textContent = visible ? "✕ Tools" : "🧰 Tools";
      toolsToggle.title = visible ? "Hide this room's tools" : "Show this room's tools";
    }
  }

  function stopOwn() {
    if (st.own) {
      st.own.getTracks().forEach((t) => t.stop());
      st.own = null;
    }
  }

  function stopMirror() {
    st.mirrorOn = false;
    if (mirror) {
      mirror.removeAttribute("src");
      mirror.hidden = true;
    }
  }

  /* Step 1: the picture the dashboard is already showing. */
  function useShared(stream) {
    st.stream = stream || null;
    if (!video) return false;
    if (!stream) return false;
    try {
      video.srcObject = stream;
      const played = video.play();
      if (played && typeof played.catch === "function") played.catch(() => {});
      show(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* Step 2: the camera itself. Only tried when the dashboard could not hand the
     stream over — otherwise two captures fight over one camera. */
  async function useOwnCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !video) return false;
    try {
      st.own = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      video.srcObject = st.own;
      const played = video.play();
      if (played && typeof played.catch === "function") played.catch(() => {});
      show(true);
      return true;
    } catch (_) {
      stopOwn();
      return false;
    }
  }

  /* Step 3: the server's own frame (it is this computer's camera too, mirrored
     by the backend while My Hands is tracking). */
  function useServerMirror() {
    if (!mirror) return false;
    st.mirrorOn = true;
    mirror.hidden = false;
    mirror.src = `/api/myhands/preview?t=${Date.now()}`;
    show(true);
    return true;
  }

  function turnOff() {
    st.stream = null;
    stopOwn();
    stopMirror();
    if (video) video.srcObject = null;
    show(false);
  }

  const dash = () => {
    try { return window.parent && window.parent !== window ? window.parent : null; } catch (_) { return null; }
  };

  function tell(message) {
    const target = dash();
    if (!target) return;
    try { target.postMessage(message, window.location.origin); } catch (_) {}
  }

  /* ---------- what the dashboard tells us ---------- */
  window.addEventListener("message", async (ev) => {
    if (ev.origin !== window.location.origin) return;
    const msg = ev.data || {};

    if (msg.type === "jarvis-glass" && msg.glass) {
      applyGlass(msg.glass);
      return;
    }

    if (msg.type === "jarvis-rooms-tools") {
      setTools(msg.open);
      return;
    }

    if (msg.type === "jarvis-camera") {
      if (!msg.on) { turnOff(); return; }
      if (msg.stream) {
        // The dashboard's live stream, straight in.
        stopOwn();
        stopMirror();
        if (!useShared(msg.stream) && !(await useOwnCamera()) && !useServerMirror()) turnOff();
      }
    }
  });

  /* ---------- the glass numbers, from the dashboard's sliders ---------- */
  function applyGlass(glass) {
    if (!glass || typeof glass !== "object") return;
    const root = document.documentElement.style;
    const kinds = ["win", "panel", "room"];
    for (const kind of kinds) {
      const g = glass[kind] || {};
      const alpha = glassNumber(g.alpha, GLASS_DEFAULTS[kind].alpha, 0, 90);
      const sand = glassNumber(g.sand, GLASS_DEFAULTS[kind].sand, 0, 100);
      root.setProperty(`--jg-${kind}-alpha`, (alpha / 100).toFixed(3));
      root.setProperty(`--jg-${kind}-sand`, (sand / 100).toFixed(3));
      root.setProperty(`--jg-${kind}-frost`, `${Math.round((sand / 100) * 40)}px`);
    }
    const line = glassNumber(glass.line, GLASS_DEFAULTS.line, 0, 100) / 100;
    root.setProperty("--jg-line", `rgba(255, 210, 74, ${(0.18 + line * 0.77).toFixed(3)})`);
    root.setProperty("--jg-line-soft", `rgba(255, 210, 74, ${(0.05 + line * 0.33).toFixed(3)})`);
    const bloom = glassNumber(glass.bloom, GLASS_DEFAULTS.bloom, 0, 150) / 100;
    root.setProperty("--jg-glow", `rgba(255, 208, 74, ${(0.30 * bloom).toFixed(3)})`);
    root.setProperty("--jg-glow-size", `${Math.round(22 * bloom)}px`);
  }

  // The rooms can be opened on their own too; start from the same saved glass
  // values before the parent dashboard sends its authoritative live settings.
  applyGlass(loadSavedGlass());

  /* ---------- turning the camera on from inside a room ----------
     There is no camera button in a room: the one switch is on the main screen.
     This is the path a room's own code (or a future control) uses, and it asks
     the dashboard first, because the dashboard owns the capture. */
  async function askForCamera(on) {
    tell({ type: "jarvis-camera-request", on });
    if (!on) { turnOff(); return; }
    setTimeout(async () => {
      if (st.on) return;
      if (!(await useOwnCamera()) && !useServerMirror()) turnOff();
    }, 600);
  }

  /* ---------- the tools switch: rooms stay empty until they are asked ---------- */
  const toolsToggle = document.getElementById("env-tools-toggle");
  if (toolsToggle) {
    toolsToggle.addEventListener("click", () => {
      setTools(!body.classList.contains("show-tools"));
    });
    setTools(body.classList.contains("show-tools"));
  }

  /* ---------- say hello: ask the dashboard for the glass and the picture ---- */
  tell({ type: "jarvis-rooms-hello" });
  // A second, later hello: the dashboard may have been mid-slide when the frame
  // was created, and one missed message would leave the glass on its defaults.
  setTimeout(() => tell({ type: "jarvis-rooms-hello" }), 1200);

  window.JarvisRoomsCamera = { turnOff, askForCamera, applyGlass };
})();
