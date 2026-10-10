/* Supper AI Agent — voice controls (V2-3). Plain JavaScript, no build step.
 *
 * The microphone, the speaker and the voice engine (local by default, or Gemini Live) all run on the server.
 * This script only shows the state and sends the owner's clicks to /api/voice/*.
 * It never holds the Gemini key and never touches audio. Text from the backend is
 * written with textContent only.
 */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const POLL_MS = 3000;

  const el = {
    voice: $("#btn-voice"),
    mute: $("#btn-mute"),
    wake: $("#btn-wake"),
    chip: $("#voice-chip"),
  };
  if (!el.voice || !el.mute || !el.wake || !el.chip) return;

  const state = { status: null, busy: false, wakeTitle: el.wake.title };

  async function api(path, options = {}) {
    const init = { ...options };
    if (options.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    const resp = await fetch(path, init);
    let body = null;
    try { body = await resp.json(); } catch (_) { /* not JSON */ }
    if (!resp.ok) {
      const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${resp.status}`;
      throw new Error(detail);
    }
    return body;
  }

  function say(kind, text, tag) {
    if (window.SupperUI) window.SupperUI.addMsg(kind, text, tag);
  }

  function chipFor(s) {
    if (!s) return { text: "voice: checking…", bad: false };
    if (s.live) return { text: s.muted ? "voice on · muted" : "voice on", bad: false };
    if (s.wake && s.wake.enabled) {
      return { text: s.muted ? "wake word listening · muted" : "wake word listening", bad: false };
    }
    if (s.last_error) return { text: `voice off · ${s.last_error}`, bad: true };
    return { text: "voice off", bad: false };
  }

  function render() {
    const s = state.status;
    const live = !!(s && s.live);
    const muted = !!(s && s.muted);
    const wakeOn = !!(s && s.wake && s.wake.enabled);
    const wakeReady = !!(s && s.wake && s.wake.available);

    el.voice.textContent = live ? "Stop voice" : "Voice";
    el.voice.setAttribute("aria-pressed", String(live));
    el.mute.setAttribute("aria-pressed", String(muted));
    el.mute.textContent = muted ? "Unmute" : "Mute";
    el.wake.setAttribute("aria-pressed", String(wakeOn));
    el.wake.disabled = !wakeReady && !wakeOn;
    el.wake.title = wakeReady
      ? state.wakeTitle
      : `Wake word is not ready: ${(s && s.wake && s.wake.reason) || "checking"}`;

    const chip = chipFor(s);
    el.chip.textContent = chip.text;
    el.chip.className = `voice-chip ${chip.bad ? "bad" : ""}`.trim();
  }

  async function refresh() {
    try {
      state.status = await api("/api/voice/status");
    } catch (e) {
      el.chip.textContent = `voice: status unavailable (${e.message})`;
      el.chip.className = "voice-chip bad";
      return;
    }
    render();
  }

  async function run(action) {
    if (state.busy) return;
    state.busy = true;
    try {
      return await action();
    } catch (e) {
      say("error", `Voice: ${e.message}`, "voice");
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  el.voice.addEventListener("click", () => run(async () => {
    const live = !!(state.status && state.status.live);
    await api(live ? "/api/voice/stop" : "/api/voice/start", { method: "POST", body: {} });
  }));

  el.mute.addEventListener("click", () => run(async () => {
    const muted = !!(state.status && state.status.muted);
    await api("/api/voice/mute", { method: "POST", body: { muted: !muted } });
  }));

  el.wake.addEventListener("click", () => run(async () => {
    const on = !!(state.status && state.status.wake && state.status.wake.enabled);
    const body = await api("/api/voice/wake", { method: "POST", body: { enabled: !on } });
    if (body && body.confirmation) {
      say("system", "Wake word needs your OK. Approve it in the panel above the chat.", "voice");
      if (window.SupperCtl) window.SupperCtl.refresh();
    }
  }));

  // Events from the shared stream (control.js forwards source === "voice").
  window.SupperVoice = {
    onEvent(ev) {
      if (!ev || typeof ev.type !== "string") return;
      if (ev.type === "voice_turn") {
        say(ev.role === "user" ? "user" : "assistant", ev.text, "voice");
        return;
      }
      if (ev.type === "voice_error") {
        say("error", `Voice: ${ev.message || "stopped"}`, "voice");
      } else if (ev.type === "voice_wake") {
        say("system", "Heard the wake word. Starting voice.", "voice");
      }
      if (["voice_state", "voice_error", "voice_wake", "barge_in"].includes(ev.type)) refresh();
    },
  };

  refresh();
  setInterval(refresh, POLL_MS);
})();
