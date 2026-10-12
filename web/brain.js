/* Supper Brain controls. Plain DOM/textContent only; no memory values go to third-party code. */
(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const el = {
    button: $("#btn-brain"), panel: $("#brain-panel"), close: $("#brain-close"),
    status: $("#brain-status"), feedback: $("#brain-feedback"),
    providerTest: $("#brain-provider-test"), backup: $("#brain-backup"),
    topicSelect: $("#brain-topic-select"), topicGoal: $("#brain-topic-goal"),
    topicSummary: $("#brain-topic-summary"), topicNext: $("#brain-topic-next"),
    topicSave: $("#brain-topic-save"), topicCreate: $("#brain-topic-create"),
    topicTitle: $("#brain-topic-title"), topicResume: $("#brain-topic-resume"),
    memorySearch: $("#brain-memory-search"), memorySearchGo: $("#brain-memory-search-go"),
    memoryCreate: $("#brain-memory-create"), memoryCategory: $("#brain-memory-category"),
    memoryKey: $("#brain-memory-key"), memoryValue: $("#brain-memory-value"),
    memoryList: $("#brain-memory-list"), taskCreate: $("#brain-task-create"),
    taskTitle: $("#brain-task-title"), taskList: $("#brain-task-list"),
    researchList: $("#brain-research-list"),
  };
  if (!el.panel || !el.button) return;

  let topics = [];
  let loading = false;

  async function api(path, options = {}) {
    const init = { ...options };
    if (options.body !== undefined && typeof options.body !== "string") {
      init.headers = { ...(options.headers || {}), "content-type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    let body = null;
    try { body = await response.json(); } catch (_) { /* non-JSON response */ }
    if (!response.ok) {
      const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return body;
  }

  function feedback(text, state = "") {
    el.feedback.textContent = text || "";
    el.feedback.className = state;
  }

  function node(tag, cls, text) {
    const value = document.createElement(tag);
    if (cls) value.className = cls;
    if (text !== undefined && text !== null) value.textContent = String(text);
    return value;
  }

  function currentTopicId() {
    return el.topicSelect.value || (window.SupperConversation && window.SupperConversation.get().topic_id) || "";
  }

  function renderStatus(status, provider) {
    const storage = status && status.available
      ? `Local memory available · ${status.topic_count} topic${status.topic_count === 1 ? "" : "s"} · ${status.open_task_count} open task${status.open_task_count === 1 ? "" : "s"}`
      : `Local memory problem: ${(status && status.storage_error) || "unavailable"}`;
    const providerText = !provider || provider.state === "not_tested"
      ? (provider && provider.key_configured ? "Gemini configured, not tested" : "Gemini not configured")
      : provider.state === "connected"
        ? `Gemini connection verified at ${provider.last_success_at || "unknown time"}`
        : provider.state === "not_configured" ? "Gemini not configured" : `Gemini last test failed (${provider.last_failure || "unknown error"})`;
    el.status.textContent = `${storage}. ${providerText}.`;
    el.status.className = status && status.available ? "ok" : "bad";
  }

  function renderTopics() {
    const current = (window.SupperConversation && window.SupperConversation.get()) || {};
    const selectedId = current.topic_id || el.topicSelect.value;
    el.topicSelect.textContent = "";
    const none = node("option", "", "Choose a saved topic");
    none.value = "";
    el.topicSelect.appendChild(none);
    topics.forEach((topic) => {
      const option = node("option", "", `${topic.title} · ${topic.status}`);
      option.value = topic.id;
      el.topicSelect.appendChild(option);
    });
    if (selectedId && topics.some((topic) => topic.id === selectedId)) el.topicSelect.value = selectedId;
    renderSelectedTopic();
  }

  function renderSelectedTopic() {
    const topic = topics.find((item) => item.id === el.topicSelect.value);
    el.topicGoal.value = topic ? topic.goal || "" : "";
    el.topicSummary.value = topic ? topic.summary || "" : "";
    el.topicNext.value = topic ? topic.next_step || "" : "";
  }

  function renderMemories(rows) {
    el.memoryList.textContent = "";
    if (!rows.length) {
      el.memoryList.appendChild(node("p", "brain-empty", "No matching saved memories."));
      return;
    }
    rows.forEach((memory) => {
      const card = node("article", "brain-card");
      card.appendChild(node("strong", "", `${memory.category}/${memory.key}`));
      card.appendChild(node("p", "", memory.value));
      const meta = [memory.source || "legacy", memory.updated || "",
        memory.topic_id ? `topic ${memory.topic_id.slice(0, 8)}` : "global"].filter(Boolean).join(" · ");
      card.appendChild(node("small", "", meta));
      const actions = node("div", "brain-card-actions");
      const edit = node("button", "", "Correct");
      edit.type = "button";
      edit.addEventListener("click", async () => {
        const corrected = window.prompt(`Correct ${memory.category}/${memory.key}:`, memory.value);
        if (corrected === null || !corrected.trim()) return;
        try {
          await api("/api/brain/memory", { method: "PUT", body: {
            category: memory.category, key: memory.key, value: corrected.trim(),
            topic_id: memory.topic_id || null, reason: "Corrected in the Brain panel",
          }});
          feedback("Memory corrected and saved locally.", "ok");
          await refresh();
        } catch (error) { feedback(`Could not correct memory: ${error.message}`, "bad"); }
      });
      const forget = node("button", "", "Forget");
      forget.type = "button";
      forget.addEventListener("click", async () => {
        if (!window.confirm(`Ask Supper to forget ${memory.category}/${memory.key}? You will need to approve the removal in the confirmation tray.`)) return;
        try {
          await api("/api/brain/memory/forget", { method: "POST", body: {
            category: memory.category, key: memory.key, topic_id: memory.topic_id || null,
          }});
          feedback("Removal is waiting for your approval in the confirmation tray.");
          if (window.SupperCtl) window.SupperCtl.refresh();
        } catch (error) { feedback(`Could not request memory removal: ${error.message}`, "bad"); }
      });
      actions.append(edit, forget);
      card.appendChild(actions);
      el.memoryList.appendChild(card);
    });
  }

  function renderTasks(rows) {
    el.taskList.textContent = "";
    if (!rows.length) {
      el.taskList.appendChild(node("p", "brain-empty", "No open tasks for this topic."));
      return;
    }
    rows.forEach((task) => {
      const card = node("article", "brain-card");
      card.appendChild(node("p", "", task.value));
      card.appendChild(node("small", "", `Task ${task.id.slice(0, 8)} · ${task.status}${task.due_at ? ` · due ${task.due_at}` : ""}`));
      if (task.status === "open") {
        const done = node("button", "", "Mark done");
        done.type = "button";
        done.addEventListener("click", async () => {
          try {
            await api(`/api/brain/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: { status: "done" } });
            feedback("Task marked done.", "ok");
            await refresh();
          } catch (error) { feedback(`Could not update task: ${error.message}`, "bad"); }
        });
        card.appendChild(done);
      }
      el.taskList.appendChild(card);
    });
  }

  function safeLink(url, title) {
    try {
      const parsed = new URL(String(url || ""), location.href);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      const link = node("a", "", title || parsed.hostname);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    } catch (_) { return null; }
  }

  function renderResearch(rows) {
    el.researchList.textContent = "";
    if (!rows.length) {
      el.researchList.appendChild(node("p", "brain-empty", "No saved sourced research for this topic yet."));
      return;
    }
    rows.forEach((record) => {
      const card = node("article", "brain-card");
      card.appendChild(node("strong", "", record.query || "Saved research"));
      card.appendChild(node("p", "", record.answer || ""));
      card.appendChild(node("small", "", `${record.retrieved_at || ""} · ${record.verification || "source metadata"}`));
      (record.sources || []).forEach((source, index) => {
        const link = safeLink(source.url, `[${index + 1}] ${source.title || source.url}`);
        if (link) card.appendChild(link);
      });
      el.researchList.appendChild(card);
    });
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    const query = el.memorySearch.value.trim();
    const topicId = currentTopicId();
    try {
      const [status, topicData, memories, tasks, research, appStatus] = await Promise.all([
        api("/api/brain/status"), api("/api/brain/topics"),
        api(`/api/brain/memory?query=${encodeURIComponent(query)}&topic_id=${encodeURIComponent(topicId)}`),
        api(`/api/brain/tasks?topic_id=${encodeURIComponent(topicId)}&status=open`),
        api(`/api/brain/research?topic_id=${encodeURIComponent(topicId)}&query=${encodeURIComponent(query)}`),
        api("/api/status"),
      ]);
      topics = topicData.topics || [];
      renderStatus(status, appStatus.provider);
      renderTopics();
      renderMemories(memories.memories || []);
      renderTasks(tasks.tasks || []);
      renderResearch(research.research || []);
    } catch (error) {
      el.status.textContent = `Brain could not load: ${error.message}`;
      el.status.className = "bad";
    } finally { loading = false; }
  }

  function openPanel(open) {
    el.panel.hidden = !open;
    el.button.setAttribute("aria-pressed", String(open));
    if (open) refresh();
  }

  el.button.addEventListener("click", () => openPanel(el.panel.hidden));
  el.close.addEventListener("click", () => openPanel(false));
  new MutationObserver(() => {
    if (el.panel.hidden) el.button.setAttribute("aria-pressed", "false");
  }).observe(el.panel, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.panel.hidden) openPanel(false);
  });
  el.topicSelect.addEventListener("change", renderSelectedTopic);
  el.topicResume.addEventListener("click", async () => {
    const id = el.topicSelect.value;
    if (!id) { feedback("Choose a saved topic first.", "bad"); return; }
    try {
      const data = await api(`/api/brain/topics/${encodeURIComponent(id)}/activate`, { method: "POST" });
      window.SupperConversation.set(data, { clear: true, load: false });
      window.SupperConversation.load();
      feedback(`Resumed ${data.topic_title}.`, "ok");
      await refresh();
    } catch (error) { feedback(`Could not resume topic: ${error.message}`, "bad"); }
  });
  el.topicSave.addEventListener("click", async () => {
    const id = el.topicSelect.value;
    if (!id) { feedback("Choose a saved topic first.", "bad"); return; }
    try {
      await api(`/api/brain/topics/${encodeURIComponent(id)}`, { method: "PATCH", body: {
        goal: el.topicGoal.value, summary: el.topicSummary.value, next_step: el.topicNext.value,
      }});
      feedback("Topic state saved locally.", "ok");
      await refresh();
    } catch (error) { feedback(`Could not save topic: ${error.message}`, "bad"); }
  });
  el.topicCreate.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = el.topicTitle.value.trim();
    if (!title) return;
    try {
      const data = await api("/api/brain/topics", { method: "POST", body: { title } });
      window.SupperConversation.set(data, { clear: true, load: false });
      feedback(`Created topic: ${data.topic_title}.`, "ok");
      el.topicTitle.value = "";
      await refresh();
    } catch (error) { feedback(`Could not create topic: ${error.message}`, "bad"); }
  });
  el.memorySearchGo.addEventListener("click", refresh);
  el.memorySearch.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); refresh(); } });
  el.memoryCreate.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/brain/memory", { method: "POST", body: {
        category: el.memoryCategory.value, key: el.memoryKey.value.trim(),
        value: el.memoryValue.value.trim(),
        topic_id: el.memoryCategory.value === "projects" ? currentTopicId() : null,
        provenance: "Added by the owner in the Brain panel",
      }});
      el.memoryKey.value = "";
      el.memoryValue.value = "";
      feedback("Memory saved locally.", "ok");
      await refresh();
    } catch (error) { feedback(`Could not save memory: ${error.message}`, "bad"); }
  });
  el.taskCreate.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/brain/tasks", { method: "POST", body: {
        title: el.taskTitle.value.trim(), topic_id: currentTopicId(),
      }});
      el.taskTitle.value = "";
      feedback("Task saved to this topic.", "ok");
      await refresh();
    } catch (error) { feedback(`Could not save task: ${error.message}`, "bad"); }
  });
  el.providerTest.addEventListener("click", async () => {
    el.providerTest.disabled = true;
    feedback("Testing Gemini with a real, budget-counted request…");
    try {
      const result = await api("/api/diagnostics/provider-test", { method: "POST", body: {} });
      feedback(`Connection verified with ${result.model}. The provider returned the expected test response.`, "ok");
      await refresh();
    } catch (error) { feedback(`Gemini test failed: ${error.message}`, "bad"); await refresh(); }
    finally { el.providerTest.disabled = false; }
  });
  el.backup.addEventListener("click", async () => {
    el.backup.disabled = true;
    try {
      const result = await api("/api/brain/backup", { method: "POST", body: {} });
      feedback(result.created
        ? `Verified local backup set created (${(result.files || []).length} files; manifest ${result.manifest}).`
        : result.reason, result.created ? "ok" : "");
      await refresh();
    } catch (error) { feedback(`Backup failed: ${error.message}`, "bad"); }
    finally { el.backup.disabled = false; }
  });

  window.SupperBrain = { refresh };
  if (stateOpen()) refresh();
  function stateOpen() { return !el.panel.hidden; }
})();
