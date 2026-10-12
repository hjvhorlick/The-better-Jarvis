/* Supper AI Agent — glass UI (M2 slice).
 * Plain JavaScript, no build step. All text from the backend or from files is
 * written with textContent, never innerHTML.
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const POS_KEY = "supper.tilePositions.v1";
  const TILE_W = 150, TILE_H = 150;

  const el = {
    status: $("#status"), ring: $("#ring"), ringLabel: $("#ring-label"),
    topicChip: $("#active-topic-chip"), send: $("#send"),
    surface: $("#surface"), hint: $("#surface-hint"), crumb: $("#crumb-path"),
    up: $("#btn-up"), log: $("#log"), composer: $("#composer"), input: $("#input"),
    preview: $("#preview"),
    sidebar: $("#sidebar"), railToggle: $("#rail-toggle"),
  };

  const CONVERSATION_KEY = "supper.brain.conversation.v1";
  const TOPIC_KEY = "supper.brain.topic.v1";
  function stored(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
  const state = { path: null, parent: null, workspace: "general",
    conversationId: stored(CONVERSATION_KEY), topicId: stored(TOPIC_KEY), topicTitle: "", chatBusy: false };

  // ---------- helpers ----------
  async function api(path, options = {}) {
    const resp = await fetch(path, options);
    let body = null;
    try { body = await resp.json(); } catch (_) { /* non-JSON error page */ }
    if (!resp.ok) {
      const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${resp.status}`;
      throw new Error(detail);
    }
    return body;
  }

  function setStatus(text, cls) {
    el.status.textContent = text;
    el.status.className = `status ${cls || ""}`.trim();
  }

  function setRing(mode, label) {
    if (!el.ring) return;                      // no visualiser: never fatal
    el.ring.className = `ring ${mode || ""}`.trim();
    if (el.ringLabel) el.ringLabel.textContent = label;
  }

  /* The rail squeezes down to just the voice visualiser, so the environment
     gets the room back. The choice is remembered. */
  const RAIL_KEY = "supper.railThin.v1";

  function setRailThin(thin) {
    if (!el.sidebar) return;
    el.sidebar.classList.toggle("is-thin", thin);
    if (el.railToggle) {
      el.railToggle.setAttribute("aria-expanded", thin ? "false" : "true");
      el.railToggle.title = thin ? "Widen the rail" : "Make the rail thinner";
    }
    try { localStorage.setItem(RAIL_KEY, thin ? "1" : "0"); } catch (_) { /* storage off */ }
  }

  // All provider and memory text uses textContent. Source links are allow-listed to HTTP(S).
  function addMsg(kind, text, tag, sources) {
    const div = document.createElement("div");
    div.className = `msg ${kind}`;
    const body = document.createElement("span");
    body.textContent = String(text || "");
    div.appendChild(body);
    if (Array.isArray(sources) && sources.length) {
      const list = document.createElement("div");
      list.className = "msg-sources";
      const heading = document.createElement("strong");
      heading.textContent = "Sources";
      list.appendChild(heading);
      sources.forEach((source, index) => {
        try {
          const url = new URL(String(source.url || ""), location.href);
          if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) return;
          const link = document.createElement("a");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = `[${index + 1}] ${String(source.title || url.hostname)}`;
          list.appendChild(link);
        } catch (_) { /* malformed citation is omitted, not rendered as a link */ }
      });
      if (list.querySelector("a")) div.appendChild(list);
    }
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      div.appendChild(t);
    }
    el.log.appendChild(div);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function loadPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || "{}") || {}; }
    catch (_) { return {}; }
  }
  function savePosition(key, left, top) {
    const all = loadPositions();
    all[key] = { left, top };
    try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch (_) { /* storage full or disabled */ }
  }

  function formatSize(n) {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---------- status ----------
  async function refreshStatus() {
    try {
      const s = await api("/api/status");
      const provider = s.provider || {};
      const providerLabel = provider.state === "connected" ? "Gemini connection verified"
        : provider.state === "failed" ? "Gemini connection failed"
        : s.api_key_configured ? "Gemini configured · not tested" : "Gemini not configured";
      const parts = [providerLabel, `${s.file_roots_available} folder${s.file_roots_available === 1 ? "" : "s"} allowed`];
      const cls = provider.state === "connected" ? "ok" : provider.state === "failed" ? "bad" : "warn";
      setStatus(`backend online · ${parts.join(" · ")}`, cls);
    } catch (_) {
      setStatus("backend offline — start it with: python -m backend", "bad");
    }
  }

  // ---------- desktop: folders and files ----------
  function gridSlot(index) {
    const cols = Math.max(1, Math.floor((el.surface.clientWidth - 16) / TILE_W));
    return { left: 16 + (index % cols) * TILE_W, top: 16 + Math.floor(index / cols) * TILE_H };
  }

  function makeTile(entry, index, keyPrefix) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    tile.dataset.key = `${keyPrefix}:${entry.path}`;

    const icon = document.createElement("div");
    icon.className = "icon";
    icon.textContent = entry.kind === "folder" ? "📁" : "📄";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = entry.kind === "folder" ? "folder" : formatSize(entry.size);
    tile.append(icon, name, meta);

    const saved = loadPositions()[tile.dataset.key];
    const pos = saved || gridSlot(index);
    tile.style.left = `${pos.left}px`;
    tile.style.top = `${pos.top}px`;

    const open = () => (entry.kind === "folder" ? openPath(entry.path) : openFile(entry.path));
    attachDrag(tile, open);
    return tile;
  }

  function attachDrag(tile, onOpen) {
    let start = null;
    tile.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, left: parseFloat(tile.style.left) || 0, top: parseFloat(tile.style.top) || 0, moved: false };
      tile.setPointerCapture(e.pointerId);
    });
    tile.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 5) return;
      if (!start.moved) { start.moved = true; tile.classList.add("grabbed"); }
      const maxL = el.surface.clientWidth - tile.offsetWidth;
      const maxT = el.surface.clientHeight - tile.offsetHeight;
      tile.style.left = `${clamp(start.left + dx, 0, maxL)}px`;
      tile.style.top = `${clamp(start.top + dy, 0, maxT)}px`;
    });
    const release = () => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      tile.classList.remove("grabbed");
      if (moved) savePosition(tile.dataset.key, parseFloat(tile.style.left) || 0, parseFloat(tile.style.top) || 0);
    };
    tile.addEventListener("pointerup", release);
    tile.addEventListener("pointercancel", release);
    tile.addEventListener("dblclick", onOpen);
    tile.addEventListener("keydown", (e) => { if (e.key === "Enter") onOpen(); });
  }

  function renderTiles(entries, keyPrefix) {
    el.surface.textContent = "";
    entries.forEach((entry, i) => el.surface.appendChild(makeTile(entry, i, keyPrefix)));
  }

  async function showRoots() {
    state.path = null; state.parent = null;
    el.up.disabled = true;
    el.crumb.textContent = "Allowed folders";
    try {
      const data = await api("/api/files/roots");
      if (!data.roots.length) {
        el.surface.textContent = "";
        el.hint.textContent = "No folders are allowed yet. Set SUPPER_FILE_ROOTS or file_roots in config/api_keys.json.";
        return;
      }
      el.hint.textContent = "Drag to move. Double-click or press Enter to open.";
      renderTiles(data.roots.map((r) => ({ name: r.name, path: r.path, kind: "folder", size: null })), "root");
    } catch (e) {
      addMsg("error", `Could not list folders: ${e.message}`);
    }
  }

  async function openPath(path) {
    try {
      const data = await api(`/api/files/list?path=${encodeURIComponent(path)}`);
      state.path = data.path;
      state.parent = data.parent;
      el.up.disabled = false;
      el.crumb.textContent = data.path;
      el.hint.textContent = data.truncated ? "Showing the first 500 items." : "Drag to move. Double-click or press Enter to open.";
      renderTiles(data.entries, "dir");
    } catch (e) {
      addMsg("error", `Could not open folder: ${e.message}`);
    }
  }

  async function openFile(path) {
    showPanel("files");
    el.preview.textContent = "Loading…";
    try {
      const data = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
      const header = `${data.name} — ${formatSize(data.size)}${data.truncated ? " (first 64 KB shown)" : ""}\n\n`;
      el.preview.textContent = header + data.text;
    } catch (e) {
      el.preview.textContent = `Cannot preview: ${e.message}`;
    }
  }

  el.up.addEventListener("click", () => {
    if (state.parent) openPath(state.parent);
    else showRoots();
  });

  // ---------- chat ----------
  const SOURCE_TAGS = {
    local: "local",
    gemini: "Gemini",
    knowledge: "saved knowledge",
    confirmation: "needs your OK",
    blocked: "blocked",
  };

  function persistConversation() {
    try {
      if (state.conversationId) localStorage.setItem(CONVERSATION_KEY, state.conversationId);
      else localStorage.removeItem(CONVERSATION_KEY);
      if (state.topicId) localStorage.setItem(TOPIC_KEY, state.topicId);
      else localStorage.removeItem(TOPIC_KEY);
    } catch (_) { /* browser storage may be disabled */ }
  }

  function updateTopicChip(title) {
    state.topicTitle = title || "";
    if (el.topicChip) el.topicChip.textContent = `Topic: ${state.topicTitle || "none"}`;
    if (el.topicChip) el.topicChip.title = state.topicTitle || "No active topic";
  }

  function setConversation(data, { clear = true, load = false } = {}) {
    state.conversationId = data && data.conversation_id ? String(data.conversation_id) : "";
    state.topicId = data && data.topic_id ? String(data.topic_id) : "";
    persistConversation();
    updateTopicChip(data && data.topic_title ? data.topic_title : "");
    if (clear) el.log.textContent = "";
    if (load) loadConversationHistory();
  }

  function applyAnswerContext(data) {
    if (!data) return;
    if (data.conversation_id) state.conversationId = String(data.conversation_id);
    if (data.topic_id !== undefined) state.topicId = data.topic_id ? String(data.topic_id) : "";
    persistConversation();
    updateTopicChip(data.topic_title || "");
  }

  async function ensureConversation() {
    if (state.conversationId) return state.conversationId;
    const data = await api("/api/brain/conversations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    setConversation(data, { clear: false, load: false });
    return state.conversationId;
  }

  async function loadConversationHistory() {
    const id = state.conversationId;
    if (!id) return;
    try {
      const data = await api(`/api/brain/conversations/${encodeURIComponent(id)}`);
      if (state.conversationId !== id) return;
      el.log.textContent = "";
      data.turns.forEach((turn) => {
        const kind = turn.status === "error" ? "error" : (turn.role === "user" ? "user" : "assistant");
        addMsg(kind, turn.text, turn.source || "", turn.sources || []);
      });
      if (data.topic_id) state.topicId = data.topic_id;
      if (data.topic_title) updateTopicChip(data.topic_title);
      persistConversation();
    } catch (e) {
      if (e.message.includes("not available")) {
        state.conversationId = "";
        state.topicId = "";
        persistConversation();
        updateTopicChip("");
      } else {
        addMsg("error", `Could not restore conversation: ${e.message}`);
      }
    }
  }

  async function startFreshConversation() {
    try {
      const data = await api("/api/brain/conversations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      setConversation(data, { clear: true, load: false });
      addMsg("system", "New conversation started. Your saved topics and history were kept.");
    } catch (e) {
      addMsg("error", `Could not start a new conversation: ${e.message}`);
    }
  }

  async function ask(text, workspace) {
    if (state.chatBusy) return;
    const previousConversationId = state.conversationId;
    state.chatBusy = true;
    if (el.send) el.send.disabled = true;
    addMsg("user", text);
    setRing("thinking", "thinking");
    try {
      await ensureConversation();
      const data = await api("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, workspace, conversation_id: state.conversationId }),
      });
      if (previousConversationId && data.conversation_id && data.conversation_id !== previousConversationId) {
        el.log.textContent = "";
        addMsg("system", `Switched to ${data.topic_title || "a new saved topic"}; the previous topic history is kept.`);
        addMsg("user", text);
      }
      applyAnswerContext(data);
      addMsg("assistant", data.reply, SOURCE_TAGS[data.source] || "", data.sources || []);
      if (data.open_path) openPath(data.open_path);
      if (window.SupperCtl) window.SupperCtl.onAnswer(data);
      setRing("", "ready");
    } catch (e) {
      addMsg("error", e.message);
      setRing("error", "error");
      if (window.SupperCtl) window.SupperCtl.refresh();
    } finally {
      state.chatBusy = false;
      if (el.send) el.send.disabled = false;
    }
  }

  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = "";
    ask(text, state.workspace);
  });

  // ---------- the environment shell ----------
  // The shell slides whole environments in and out of the window. When one is
  // on screen it tells us here, so a question asked while you are designing is
  // answered the way a designer would answer it, not the way a chat would.
  window.SupperWorkspace = (name) => {
    state.workspace = name || "general";
  };

  // ---------- panels ----------
  function showPanel(name) {
    $$(".panel").forEach((p) => {
      const isTarget = p.dataset.ws === name;
      p.hidden = !isTarget;
      p.classList.toggle("active-target", isTarget);
    });
    state.workspace = name;
    addMsg("system", `Workspace: ${name.charAt(0).toUpperCase() + name.slice(1)}`);
  }

  function closePanels() {
    $$(".panel").forEach((p) => { p.hidden = true; p.classList.remove("active-target"); });
    state.workspace = "general";
  }

  $$("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.open;
      const panel = $(`.panel[data-ws="${name}"]`);
      if (panel && !panel.hidden) closePanels();
      else showPanel(name);
    });
  });
  $$(".panel .close").forEach((btn) => btn.addEventListener("click", closePanels));
  $$(".panel-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      ask(text, form.dataset.ws);
    });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanels(); });

  if (el.railToggle) {
    el.railToggle.addEventListener("click", () => {
      setRailThin(!el.sidebar.classList.contains("is-thin"));
    });
  }

  // Small surface for the companion scripts loaded after this file.
  window.SupperUI = { addMsg, savePosition, surface: el.surface };
  window.SupperRing = setRing;
  window.SupperConversation = {
    get: () => ({ conversation_id: state.conversationId, topic_id: state.topicId, topic_title: state.topicTitle }),
    set: setConversation,
    load: loadConversationHistory,
    startFresh: startFreshConversation,
    updateTopic: (id, title) => { state.topicId = id || ""; persistConversation(); updateTopicChip(title || ""); },
  };
  const newChatButton = $("#btn-new-chat");
  if (newChatButton) newChatButton.addEventListener("click", startFreshConversation);

  // ---------- start ----------
  $$(".panel").forEach((p) => { p.hidden = true; });
  try { setRailThin(localStorage.getItem(RAIL_KEY) === "1"); } catch (_) { /* storage off */ }
  setRing("", "ready");
  refreshStatus();
  if (state.conversationId) loadConversationHistory();
  showRoots();
  setInterval(refreshStatus, 15000);
  window.addEventListener("resize", () => { if (state.path === null) showRoots(); });
})();
