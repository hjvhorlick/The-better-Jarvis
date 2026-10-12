/* Supper AI Agent — control surface (V2-2): permission prompts, Gemini budget chip,
 * and the diagnostics drawer. Plain JavaScript, no build step. Text from the backend
 * is written with textContent only, never innerHTML.
 *
 * Loaded after app.js. It talks to the backend through the same HTTP API and the
 * shared event stream (/ws/events). It does not hold any secret.
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const STREAM_RETRY_MS = 3000;
  const DIAG_REFRESH_MS = 3000;

  const el = {
    tray: $("#confirm-tray"),
    quota: $("#quota-chip"),
    diagBtn: $("#btn-diag"),
    diag: $("#diag-panel"),
    diagBody: $("#diag-body"),
    diagClose: $("#diag-close"),
  };

  const state = { lastSeq: 0, cards: new Map(), streamTimer: null, diagTimer: null, socket: null };

  // ---------- helpers ----------
  async function api(path, options = {}) {
    const resp = await fetch(path, options);
    let body = null;
    try { body = await resp.json(); } catch (_) { /* not JSON */ }
    if (!resp.ok) {
      const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${resp.status}`;
      throw new Error(detail);
    }
    return body;
  }

  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function say(kind, text, tag) {
    if (window.SupperUI) window.SupperUI.addMsg(kind, text, tag);
  }

  const TIER_LABEL = { safe: "runs without asking", confirm: "needs your OK", blocked: "never runs here" };

  // ---------- Gemini budget chip ----------
  function renderQuota(b) {
    if (!el.quota) return;
    if (!b) {
      el.quota.textContent = "Gemini today: unknown";
      el.quota.className = "quota-chip";
      return;
    }
    let cls = "ok";
    let text = `Gemini today: ${b.used}/${b.limit}`;
    if (!b.enabled) { cls = "bad"; text = "Gemini calls are off (budget 0)"; }
    else if (b.unreadable) { cls = "bad"; text = "Gemini paused: budget file unreadable"; }
    else if (b.remaining === 0) { cls = "bad"; text = `Gemini today: ${b.used}/${b.limit} (used up)`; }
    else if (b.remaining <= Math.max(3, Math.ceil(b.limit * 0.2))) { cls = "warn"; }
    el.quota.textContent = text;
    el.quota.className = `quota-chip ${cls}`;
    el.quota.title = `${b.note} Resets at ${b.resets}.`;
  }

  async function refreshQuota() {
    try {
      const s = await api("/api/status");
      renderQuota(s.gemini_budget);
    } catch (_) {
      renderQuota(null);
    }
  }

  // ---------- confirmations ----------
  function secondsLeft(card) {
    return Math.max(0, Math.round(card.expiresAt - Date.now() / 1000));
  }

  function makeCard(item) {
    const card = h("div", "confirm");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Action waiting for your OK");
    const tier = h("div", "confirm-tier", TIER_LABEL.confirm);
    const summary = h("p", "confirm-summary", item.summary);
    const expiry = h("p", "confirm-expiry");
    const actions = h("div", "confirm-actions");
    const approve = h("button", "approve", "Approve");
    const deny = h("button", "deny ghost", "Deny");
    actions.append(approve, deny);
    card.append(tier, summary, expiry, actions);

    const entry = { id: item.id, expiresAt: item.expires_at, node: card, expiry, buttons: [approve, deny] };
    const answer = async (approved) => {
      entry.buttons.forEach((b) => { b.disabled = true; });
      try {
        const out = await api(`/api/confirmations/${encodeURIComponent(item.id)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approve: approved }),
        });
        say("assistant", out.result, out.status === "approved" ? "done" : out.status);
        if (out.status === "approved" && out.action === "brain.forget" && window.SupperBrain) window.SupperBrain.refresh();
      } catch (e) {
        say("error", e.message);
      }
      removeCard(item.id);
      refreshConfirmations();
    };
    approve.addEventListener("click", () => answer(true));
    deny.addEventListener("click", () => answer(false));
    entry.answer = answer;
    return entry;
  }

  function removeCard(id) {
    const entry = state.cards.get(id);
    if (!entry) return;
    entry.node.remove();
    state.cards.delete(id);
    if (state.cards.size === 0) el.tray.hidden = true;
  }

  function renderTray(items) {
    const live = new Set(items.map((i) => i.id));
    for (const id of Array.from(state.cards.keys())) {
      if (!live.has(id)) {
        const gone = state.cards.get(id);
        if (gone.expiresAt <= Date.now() / 1000) say("system", "A request expired without an answer.");
        removeCard(id);
      }
    }
    items.forEach((item) => {
      if (state.cards.has(item.id)) return;
      const entry = makeCard(item);
      state.cards.set(item.id, entry);
      el.tray.appendChild(entry.node);
    });
    el.tray.hidden = state.cards.size === 0;
    updateExpiry();
  }

  function updateExpiry() {
    state.cards.forEach((entry) => {
      const s = secondsLeft(entry);
      entry.expiry.textContent = s > 0 ? `Waiting. Expires in ${s} s.` : "Expiring…";
    });
  }

  async function refreshConfirmations() {
    try {
      const data = await api("/api/confirmations");
      renderTray(Array.isArray(data.pending) ? data.pending : []);
    } catch (_) {
      /* backend offline: the status line already says so */
    }
  }

  // ---------- event stream: refresh prompts when the permission queue changes ----------
  function connectStream() {
    if (state.socket) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = new WebSocket(`${proto}//${location.host}/ws/events?since=${state.lastSeq}`);
    } catch (_) {
      scheduleStream();
      return;
    }
    state.socket = socket;
    socket.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch (_) { return; }
      if (typeof data.seq === "number") state.lastSeq = Math.max(state.lastSeq, data.seq);
      if (data.event && data.event.source === "permissions") refreshConfirmations();
      if (data.event && data.event.source === "voice" && window.SupperVoice) window.SupperVoice.onEvent(data.event);
      if (data.event && data.event.source === "assistant" && data.event.type === "notice") {
        say("assistant", data.event.text, data.event.tag || "repair");
      }
    };
    socket.onclose = () => { state.socket = null; scheduleStream(); };
    socket.onerror = () => { /* onclose follows */ };
  }

  function scheduleStream() {
    if (state.streamTimer) return;
    state.streamTimer = setTimeout(() => {
      state.streamTimer = null;
      connectStream();
    }, STREAM_RETRY_MS);
  }

  // ---------- diagnostics drawer ----------
  function section(title) {
    const wrap = h("section", "diag-section");
    wrap.appendChild(h("h3", null, title));
    const list = h("dl");
    wrap.appendChild(list);
    el.diagBody.appendChild(wrap);
    return list;
  }

  function row(list, label, value) {
    list.appendChild(h("dt", null, label));
    list.appendChild(h("dd", null, value));
  }

  function renderDiagnostics(d) {
    el.diagBody.textContent = "";
    let list = section("Backend");
    row(list, "Version", d.version);
    row(list, "Gemini key", d.api_key_configured ? "set" : "not set");
    row(list, "Text model", d.text_model);
    row(list, "Allowed folders", d.file_roots_available);

    list = section("Gemini provider (last real request)");
    const provider = d.provider || {};
    row(list, "Connection", provider.state || "not tested");
    row(list, "Last success", provider.last_success_at || "not verified yet");
    if (provider.last_failure) row(list, "Last failure", provider.last_failure);
    row(list, "Model", provider.model || d.text_model);
    row(list, "Key configured", provider.key_configured ? "yes (value hidden)" : "no");

    list = section("Persistent Brain");
    const brain = d.brain || {};
    row(list, "Memory store", brain.available ? "available" : `problem: ${brain.storage_error || "unknown"}`);
    row(list, "Topics", brain.topic_count ?? "unknown");
    row(list, "Open tasks", brain.open_task_count ?? "unknown");
    row(list, "Sourced research records", brain.research_count ?? "unknown");
    row(list, "Verified backups", brain.backup ? brain.backup.count : "unknown");

    list = section("Gemini budget");
    const b = d.gemini_budget;
    if (b) {
      row(list, "Used today", `${b.used} of ${b.limit}`);
      row(list, "Remaining", b.remaining);
      row(list, "Resets", b.resets);
      row(list, "Note", b.note);
      if (b.unreadable) row(list, "Problem", "budget file unreadable; Gemini paused until local midnight");
      if (!b.saved) row(list, "Problem", "count could not be saved; it is kept in memory only");
    }

    list = section("Devices");
    Object.keys(d.devices || {}).forEach((name) => {
      const dev = d.devices[name];
      row(list, name, `${dev.status.state}${dev.status.message ? ` — ${dev.status.message}` : ""}`);
      row(list, `${name} holders`, dev.holders.length ? dev.holders.join(", ") : "none");
      row(list, `${name} frames`, dev.status.frames_total);
    });

    list = section("My Hands");
    const m = d.myhands || {};
    row(list, "Running", m.running ? "yes" : "no");
    row(list, "Camera", m.camera ? m.camera.state : "not initialised");
    row(list, "Hand in view", m.hand_present ? "yes" : "no");
    row(list, "Tracking library", m.tracker_available ? "installed" : "missing (see backend/requirements-myhands.txt)");
    row(list, "Auto-off after idle", `${m.idle_off_s} s`);

    list = section("Event stream");
    const bus = d.bus || {};
    row(list, "Last sequence", bus.last_seq);
    row(list, "Oldest kept", bus.oldest_seq === null ? "none yet" : bus.oldest_seq);
    row(list, "Capacity", bus.capacity);

    list = section("Permissions");
    (d.permissions || []).forEach((p) => {
      const dd = h("dd", `tier tier-${p.tier}`, `${p.action}: ${TIER_LABEL[p.tier] || p.tier}`);
      list.appendChild(h("dt", null, p.tier));
      list.appendChild(dd);
    });

    list = section("Waiting for your OK");
    row(list, "Pending", d.confirmations_pending);

    list = section("Recent problems");
    const problems = d.recent_problems || [];
    if (!problems.length) {
      row(list, "None", "no faults recorded");
    } else {
      problems.forEach((p) => row(list, `#${p.seq} ${p.source}`, `${p.type}${p.message ? ` — ${p.message}` : ""}`));
    }
  }

  async function refreshDiagnostics() {
    try {
      const d = await api("/api/diagnostics");
      if (d.bus && typeof d.bus.last_seq === "number") state.lastSeq = Math.max(state.lastSeq, d.bus.last_seq);
      renderDiagnostics(d);
      renderQuota(d.gemini_budget);
    } catch (e) {
      el.diagBody.textContent = `Could not load diagnostics: ${e.message}`;
    }
  }

  function openDiagnostics() {
    el.diag.hidden = false;
    el.diagBtn.setAttribute("aria-pressed", "true");
    refreshDiagnostics();
    state.diagTimer = setInterval(refreshDiagnostics, DIAG_REFRESH_MS);
  }

  function closeDiagnostics() {
    el.diag.hidden = true;
    el.diagBtn.setAttribute("aria-pressed", "false");
    if (state.diagTimer) clearInterval(state.diagTimer);
    state.diagTimer = null;
  }

  el.diagBtn.addEventListener("click", () => (el.diag.hidden ? openDiagnostics() : closeDiagnostics()));
  el.diagClose.addEventListener("click", closeDiagnostics);
  // Opening a workspace hides the drawer (app.js hides every .panel). Keep the button in step.
  new MutationObserver(() => { if (el.diag.hidden && el.diagBtn.getAttribute("aria-pressed") === "true") closeDiagnostics(); })
    .observe(el.diag, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.diag.hidden) closeDiagnostics(); });

  // ---------- hooks used by app.js ----------
  function onAnswer(data) {
    if (data.source === "confirmation" || data.confirmation) refreshConfirmations();
    refreshQuota();
  }

  window.SupperCtl = { onAnswer, refresh: () => { refreshQuota(); refreshConfirmations(); } };

  // ---------- start ----------
  refreshQuota();
  refreshConfirmations();
  setInterval(refreshQuota, 15000);
  setInterval(refreshConfirmations, 20000);       // safety net if the stream is down
  setInterval(updateExpiry, 1000);
  connectStream();
})();
