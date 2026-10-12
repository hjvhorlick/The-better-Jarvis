/* Integrated Internet Research room. All remote content is rendered as text. */
const EMPTY = () => ({ question: "" });

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return "";
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if ((url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) || host === "localhost" || host.endsWith(".localhost") || /\.(?:local|internal|test|invalid|example|onion)$/.test(host)) return "";
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b, c] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
          (a === 192 && b === 88 && c === 99) || (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) ||
          (a === 203 && b === 0 && c === 113)) return "";
    }
    if (host.includes(":")) {
      const firstWord = host.split(":").find(Boolean) || "0";
      if (!/^[23]/.test(firstWord) || /^2001(?::|$)/.test(host) || /^2002(?::|$)/.test(host) || /^3fff(?::|$)/.test(host)) return "";
    }
    return url.toString();
  } catch (_) { return ""; }
}

function dateLabel(value) {
  if (!value) return "Date not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function reportFilename(title) {
  const slug = String(title || "research-report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${slug || "research-report"}.md`;
}

export default {
  async mount(root) {
    if (!document.querySelector('link[data-research-workspace-css="true"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("./research.css", import.meta.url).href;
      link.dataset.researchWorkspaceCss = "true";
      document.head.appendChild(link);
    }
    const state = {
      view: "new",
      status: null,
      reports: [],
      tasks: [],
      taskId: null,
      task: null,
      report: null,
      savedReportId: null,
      pollTimer: null,
      searchTimer: null,
      searchText: "",
      followups: [],
      error: "",
      destroyed: false,
    };

    const make = (tag, cls, text) => {
      const item = document.createElement(tag);
      if (cls) item.className = cls;
      if (text !== undefined) item.textContent = text;
      return item;
    };
    const button = (label, cls, handler) => {
      const item = make("button", cls, label);
      item.type = "button";
      item.addEventListener("click", handler);
      return item;
    };
    const shell = make("section", "research-workspace");
    const header = make("header", "research-header");
    const headingBlock = make("div", "research-heading");
    headingBlock.append(make("h1", "", "Internet Research"), make("p", "", "Investigate with current web evidence, inspect bounded page extracts, and keep cited reports locally."));
    const providerBadge = make("span", "research-provider", "Checking provider…");
    header.append(headingBlock, providerBadge);

    const tabs = make("nav", "research-tabs");
    const main = make("main", "research-main");
    const layout = make("div", "research-layout");
    const rail = make("aside", "research-rail");
    const workForm = make("form", "research-start-form");
    const questionLabel = make("label", "research-label", "Research question");
    const question = make("textarea", "research-question");
    question.id = "research-question";
    question.rows = 4;
    question.maxLength = 1200;
    question.placeholder = "Compare these services and their pricing…";
    questionLabel.htmlFor = question.id;
    const startButton = make("button", "research-primary", "Start research");
    startButton.type = "submit";
    const queryHint = make("p", "research-hint", "One grounded search request, up to three public page extracts, then a cited report.");
    workForm.append(questionLabel, question, startButton, queryHint);

    const taskSection = make("section", "research-rail-section");
    taskSection.append(make("h2", "research-section-title", "Recent tasks"));
    const taskList = make("div", "research-list");
    taskSection.append(taskList);

    const reportSection = make("section", "research-rail-section");
    reportSection.append(make("h2", "research-section-title", "Saved reports"));
    const reportSearchLabel = make("label", "research-label", "Search reports");
    const reportSearch = make("input", "research-search");
    reportSearch.type = "search";
    reportSearch.maxLength = 200;
    reportSearch.placeholder = "Title, question, source…";
    reportSearchLabel.htmlFor = "research-report-search";
    reportSearch.id = "research-report-search";
    const savedList = make("div", "research-list");
    reportSection.append(reportSearchLabel, reportSearch, savedList);
    rail.append(workForm, taskSection, reportSection);

    const costNote = make("p", "research-cost-note",
      "Search is not always free. Google Search grounding uses your existing Gemini key and model; current Google terms and usage-based charges depend on your account. See Help for the published rate note.");
    const errorNote = make("p", "research-global-error");
    errorNote.hidden = true;
    rail.append(costNote, errorNote);
    layout.append(rail, main);
    shell.append(header, tabs, layout);
    root.replaceChildren(shell);

    function setError(message) {
      state.error = message || "";
      errorNote.textContent = state.error;
      errorNote.hidden = !state.error;
      errorNote.setAttribute("role", state.error ? "alert" : "status");
    }

    async function api(url, options = {}) {
      const token = (() => { try { return sessionStorage.getItem("jarvis_token") || "jarvis-live-session-token"; } catch (_) { return "jarvis-live-session-token"; } })();
      const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${token}` });
      if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      const response = await fetch(url, { ...options, headers });
      let data = null;
      try { data = await response.json(); } catch (_) { /* non-JSON provider/server error */ }
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
      return data || {};
    }

    function currentTaskStatusLabel(task) {
      return ({
        queued: "Queued — no provider request yet",
        searching: "Searching with Google Search grounding",
        fetching: "Checking public source pages",
        synthesizing: "Comparing evidence and writing report",
        complete: "Research complete",
        failed: "Research stopped",
      })[task.status] || task.status;
    }

    function stopPolling() {
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    function startPolling(id) {
      stopPolling();
      state.taskId = id;
      void refreshTask(id);
      state.pollTimer = window.setInterval(() => { void refreshTask(id); }, 900);
    }

    async function refreshTask(id) {
      if (!id || state.destroyed) return;
      try {
        const data = await api(`/api/research/tasks/${encodeURIComponent(id)}`);
        if (state.taskId !== id || state.destroyed) return;
        state.task = data.task;
        if (state.task.status === "complete") {
          state.report = state.task.report;
          state.savedReportId = state.task.savedReportId || null;
          stopPolling();
          void refreshTaskList();
          void refreshSavedReports();
        } else if (state.task.status === "failed") {
          state.report = null;
          stopPolling();
        }
        paintMain();
      } catch (error) {
        if (state.taskId !== id || state.destroyed) return;
        setError(`Could not refresh research progress: ${error.message}`);
        stopPolling();
      }
    }

    async function refreshProviderStatus() {
      try {
        state.status = await api("/api/research/status");
        if (typeof state.status.costNote === "string" && state.status.costNote) costNote.textContent = state.status.costNote;
        providerBadge.textContent = state.status.configured
          ? `${state.status.provider} · ${state.status.model}`
          : "Search unavailable · Gemini key required";
        providerBadge.classList.toggle("is-unavailable", !state.status.configured);
        if (!state.status.configured) setError(state.status.configuration);
      } catch (error) {
        providerBadge.textContent = "Provider status unavailable";
        setError(`Could not check Research configuration: ${error.message}`);
      }
    }

    async function refreshTaskList() {
      try {
        const data = await api("/api/research/tasks?limit=10");
        state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
        renderTaskList();
        return state.tasks;
      } catch (error) {
        setError(`Could not load recent task status: ${error.message}`);
        return [];
      }
    }

    async function refreshSavedReports() {
      try {
        const query = state.searchText.trim();
        const data = await api(`/api/research/reports${query ? `?q=${encodeURIComponent(query)}` : ""}`);
        state.reports = Array.isArray(data.reports) ? data.reports : [];
        renderSavedList();
        if (data.warning) setError(data.warning);
      } catch (error) {
        setError(`Could not load saved research reports: ${error.message}`);
      }
    }

    function renderTaskList() {
      taskList.replaceChildren();
      if (!state.tasks.length) {
        taskList.append(make("p", "research-empty", "No recent research tasks."));
        return;
      }
      for (const task of state.tasks) {
        const item = button("", "research-list-item", () => { state.view = "task"; state.report = null; state.savedReportId = null; startPolling(task.id); });
        item.append(make("span", "research-list-title", task.title || task.question), make("span", "research-list-meta", `${currentTaskStatusLabel(task)} · ${dateLabel(task.updatedAt)}`));
        taskList.append(item);
      }
    }

    function renderSavedList() {
      savedList.replaceChildren();
      if (!state.reports.length) {
        savedList.append(make("p", "research-empty", state.searchText ? "No saved reports match." : "No saved reports yet. Finish a task and choose Save report."));
        return;
      }
      for (const report of state.reports) {
        const item = button("", "research-list-item", () => { void openSavedReport(report.id); });
        item.append(make("span", "research-list-title", report.title), make("span", "research-list-meta", `${report.sourceCount} source(s) · edited ${dateLabel(report.updatedAt)}`));
        savedList.append(item);
      }
    }

    function renderTabs() {
      tabs.replaceChildren();
      const options = [["new", "New research"], ["saved", "Saved reports"], ["help", "Help & limits"]];
      for (const [view, label] of options) {
        const item = button(label, "research-tab", () => {
          state.view = view;
          if (view === "saved") void refreshSavedReports();
          paintMain();
        });
        item.setAttribute("aria-pressed", state.view === view ? "true" : "false");
        tabs.append(item);
      }
    }

    function addExternalLink(container, rawUrl, label) {
      const url = safeExternalUrl(rawUrl);
      if (!url) {
        container.append(make("span", "research-source-url research-muted", "No safe public link was returned."));
        return;
      }
      const link = make("a", "research-source-url", label || url);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      container.append(link);
    }

    function renderSources(sources) {
      const section = make("section", "research-sources");
      section.append(make("h3", "", "Sources and inspected evidence"));
      for (const source of sources || []) {
        const card = make("article", "research-source-card");
        const title = make("div", "research-source-title");
        title.append(make("strong", "", `[${source.id}] ${source.title || "Untitled source"}`));
        const stateText = source.fetchStatus === "read"
          ? "Text extract inspected — not a full-page review"
          : source.fetchStatus === "not-opened" ? "Search-grounded citation only — page not opened"
            : source.fetchStatus === "blocked" ? "Blocked by public-network safety check"
              : source.fetchStatus === "insufficient" ? "Page opened; readable information insufficient"
                : "Page could not be accessed";
        title.append(make("span", `research-source-status ${source.fetchStatus || ""}`, stateText));
        const pageAccessLabel = source.accessedAt
          ? `${source.fetchStatus === "read" ? "Page text fetched" : "Page access attempted"} ${dateLabel(source.accessedAt)}`
          : "Page not opened";
        card.append(title, make("p", "research-source-meta", `${source.publisher || "Publisher not identified"} · Published ${source.publishedAt || "date not stated"} · Google grounding checked ${dateLabel(source.searchCheckedAt)} · ${pageAccessLabel}`));
        addExternalLink(card, source.url, source.url || "");
        if (source.fetchedUrl && source.fetchedUrl !== source.url) {
          addExternalLink(card, source.fetchedUrl, `Fetched destination: ${source.fetchedUrl}`);
        }
        if (source.excerpt) {
          card.append(make("p", "research-source-label", "Bounded page text extract"), make("blockquote", "research-excerpt", source.excerpt));
        }
        if (source.searchExcerpt) {
          card.append(make("p", "research-source-label", "Google grounding evidence (not a page extract)"), make("blockquote", "research-excerpt research-search-excerpt", source.searchExcerpt));
        }
        if (source.fetchNote) card.append(make("p", "research-source-note", source.fetchNote));
        section.append(card);
      }
      return section;
    }

    function startEmailDraft(report) {
      void api("/api/email/drafts", {
        method: "POST",
        body: JSON.stringify({
          to: "", cc: "", bcc: "",
          subject: `Research: ${report.title}`.slice(0, 998),
          body: report.report,
        }),
      }).then((data) => {
        setError(`Created local Email draft #${data.draft.id}. Add a recipient and review it there; nothing was sent.`);
        if (window.Shell && typeof window.Shell.open === "function") void window.Shell.open("email");
      }).catch((error) => setError(`Could not create a local email draft: ${error.message}. Nothing was sent.`));
    }

    async function copyReport(report) {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(report.report);
        else {
          const temp = make("textarea", "", report.report);
          temp.setAttribute("readonly", "");
          temp.style.position = "fixed";
          temp.style.opacity = "0";
          document.body.append(temp);
          temp.select();
          const ok = document.execCommand("copy");
          temp.remove();
          if (!ok) throw new Error("Clipboard permission was not granted");
        }
        setError("Copied the report and its source references. Nothing was published.");
      } catch (error) { setError(`Could not copy the report: ${error.message}`); }
    }

    function exportReport(report) {
      try {
        const blob = new Blob([report.report], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = make("a", "");
        anchor.href = url;
        anchor.download = reportFilename(report.title);
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { setError(`Could not export the report: ${error.message}`); }
    }

    function renderFollowups(report) {
      const wrap = make("section", "research-followup");
      wrap.append(make("h3", "", "Ask about this report"), make("p", "research-hint", "Follow-ups use this saved report and its bounded extracts only; they do not run a fresh web search."));
      const list = make("div", "research-followup-list");
      for (const item of state.followups) {
        list.append(make("p", "research-followup-question", `You: ${item.question}`), make("pre", "research-followup-answer", item.answer));
      }
      const form = make("form", "research-followup-form");
      const input = make("input", "research-followup-input");
      input.type = "text";
      input.maxLength = 1000;
      input.placeholder = "What did the sources say about…?";
      input.setAttribute("aria-label", "Follow-up question about this report");
      const submit = make("button", "research-secondary", "Ask follow-up");
      submit.type = "submit";
      form.append(input, submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const questionText = input.value.trim();
        if (questionText.length < 5) { setError("Enter a specific follow-up question (at least five characters)."); return; }
        submit.disabled = true;
        setError("Checking the saved report and source extracts; no new web search is being run.");
        try {
          const data = await api(`/api/research/reports/${encodeURIComponent(report.id)}/followup`, { method: "POST", body: JSON.stringify({ question: questionText }) });
          state.followups.push({ question: questionText, answer: data.answer });
          input.value = "";
          paintMain();
          setError(data.note || "Follow-up answered from this report only.");
        } catch (error) { setError(`Follow-up failed: ${error.message}`); }
        finally { submit.disabled = false; }
      });
      wrap.append(list, form);
      return wrap;
    }

    function renderMemoryForm(report, isSaved) {
      const details = make("details", "research-memory-details");
      const summary = make("summary", "", "Save a concise finding to local knowledge (optional)");
      details.append(summary);
      const form = make("form", "research-memory-form");
      const questionText = make("input", "research-memory-question");
      questionText.type = "text";
      questionText.maxLength = 200;
      questionText.placeholder = "Question that should retrieve this fact";
      questionText.setAttribute("aria-label", "Knowledge question");
      const answerText = make("textarea", "research-memory-answer");
      answerText.rows = 3;
      answerText.maxLength = 2000;
      answerText.placeholder = "A concise finding to keep";
      answerText.setAttribute("aria-label", "Concise research finding");
      const submit = make("button", "research-secondary", "Save selected finding");
      submit.type = "submit";
      submit.disabled = !isSaved;
      const note = make("p", "research-hint", isSaved
        ? "Only the text you enter is saved to the existing local knowledge base. Research is never added automatically."
        : "Save this report first. No research content is written to memory automatically.");
      form.append(questionText, answerText, submit, note);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!isSaved) return;
        submit.disabled = true;
        try {
          const data = await api(`/api/research/reports/${encodeURIComponent(report.id)}/memory`, {
            method: "POST", body: JSON.stringify({ question: questionText.value.trim(), answer: answerText.value.trim() }),
          });
          questionText.value = "";
          answerText.value = "";
          setError(`Finding saved to local knowledge entry #${data.id} because you requested it.`);
        } catch (error) { setError(`Could not save the finding: ${error.message}`); }
        finally { submit.disabled = false; }
      });
      details.append(form);
      return details;
    }

    function renameReport(report) {
      const wrap = make("form", "research-rename-form");
      const input = make("input", "research-rename-input");
      input.type = "text";
      input.maxLength = 160;
      input.value = report.title;
      input.setAttribute("aria-label", "New report title");
      const save = make("button", "research-secondary", "Save title");
      save.type = "submit";
      const cancel = button("Cancel", "research-quiet", () => paintMain());
      wrap.append(input, save, cancel);
      wrap.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          const data = await api(`/api/research/reports/${encodeURIComponent(report.id)}`, { method: "PATCH", body: JSON.stringify({ title: input.value.trim() }) });
          state.report = data.report;
          state.savedReportId = data.report.id;
          await refreshSavedReports();
          paintMain();
          setError("Report title updated on this computer.");
        } catch (error) { setError(`Could not rename report: ${error.message}`); save.disabled = false; }
      });
      return wrap;
    }

    async function updateReport(report) {
      try {
        const data = await api(`/api/research/reports/${encodeURIComponent(report.id)}/update`, { method: "POST", body: JSON.stringify({}) });
        state.view = "task";
        state.task = data.task;
        state.report = null;
        state.savedReportId = report.id;
        setError("Fresh research is running. The existing saved report stays intact until the update completes.");
        startPolling(data.task.id);
        paintMain();
      } catch (error) { setError(`Could not update report: ${error.message}`); }
    }

    async function deleteReport(report) {
      if (!window.confirm(`Delete saved research report “${report.title}”? This removes the local report and cannot be undone.`)) return;
      try {
        await api(`/api/research/reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
        state.report = null;
        state.savedReportId = null;
        state.followups = [];
        state.view = "saved";
        await refreshSavedReports();
        paintMain();
        setError("Saved report deleted from this computer. No memory or email draft was changed.");
      } catch (error) { setError(`Could not delete report: ${error.message}`); }
    }

    function renderReport(report, isSaved) {
      const view = make("article", "research-report-view");
      const titleBlock = make("header", "research-report-heading");
      titleBlock.append(make("h2", "", report.title), make("p", "research-report-meta", `Created ${dateLabel(report.createdAt)} · Updated ${dateLabel(report.updatedAt)} · ${report.sources.length} source(s) · ${isSaved ? `Saved report ${report.id}` : "Unsaved research result"}`));
      view.append(titleBlock);

      const actions = make("div", "research-report-actions");
      actions.append(button("Copy report", "research-secondary", () => void copyReport(report)));
      actions.append(button("Export .md", "research-secondary", () => exportReport(report)));
      actions.append(button("Create Email draft", "research-secondary", () => startEmailDraft(report)));
      if (isSaved) {
        actions.append(button("Rename", "research-secondary", () => view.insertBefore(renameReport(report), view.children[1] || null)));
        actions.append(button("Update from web", "research-secondary", () => void updateReport(report)));
        actions.append(button("Delete…", "research-danger", () => void deleteReport(report)));
      } else if (state.task?.status === "complete" && !state.task.savedReportId) {
        actions.append(button("Save report", "research-primary", async () => {
          try {
            const data = await api("/api/research/reports", { method: "POST", body: JSON.stringify({ taskId: state.task.id }) });
            state.report = data.report;
            state.savedReportId = data.report.id;
            state.task.savedReportId = data.report.id;
            await Promise.all([refreshTaskList(), refreshSavedReports()]);
            paintMain();
            setError(`Saved report ${data.report.id} locally. No memory entry was created.`);
          } catch (error) { setError(`Could not save report: ${error.message}`); }
        }));
      }
      actions.append(isSaved ? button("Open saved report", "research-quiet", () => void openSavedReport(report.id)) : make("span", "research-hint", "Save to keep this report across restarts."));
      view.append(actions);
      const questionBox = make("p", "research-question-display");
      questionBox.append(make("strong", "", "Research question: "), document.createTextNode(report.question));
      view.append(questionBox);
      const reportText = make("pre", "research-report-text", report.report);
      reportText.setAttribute("aria-label", "Completed research report in Markdown");
      view.append(reportText, renderSources(report.sources));
      if (isSaved) view.append(renderFollowups(report));
      else view.append(make("p", "research-hint", "Save this report before asking follow-up questions. Follow-ups never trigger a fresh web search."));
      view.append(renderMemoryForm(report, isSaved));
      return view;
    }

    function renderTask(task) {
      const view = make("section", "research-task-view");
      view.append(make("p", "research-status-pill", currentTaskStatusLabel(task)), make("h2", "", task.title || "Research in progress"));
      view.append(make("p", "research-progress", task.progress || "Waiting for status…"));
      view.append(make("p", "research-question-display", `Question: ${task.question}`));
      if (task.status === "failed") {
        const warning = make("div", "research-task-error", task.error || "Research stopped; no completed report was saved.");
        warning.setAttribute("role", "alert");
        view.append(warning);
        if (/search|grounding|page|source/i.test(task.error || "")) {
          view.append(make("p", "research-hint", "No completed web search is claimed for a failed task. Check provider configuration or the source-specific messages, then retry."));
        }
      }
      if (task.status === "complete" && task.report) {
        view.append(renderReport(task.report, Boolean(task.savedReportId)));
      } else if (task.status === "failed" && state.savedReportId) {
        view.append(button("Open unchanged saved report", "research-secondary", () => void openSavedReport(state.savedReportId)));
      } else if (task.status !== "failed") {
        const spinner = make("div", "research-progress-bar");
        spinner.setAttribute("aria-label", "Research is in progress");
        view.append(spinner);
      }
      return view;
    }

    function renderNew() {
      const view = make("section", "research-welcome");
      view.append(make("h2", "", "Start with a question"), make("p", "", "Research will report the queries returned by Google Search, inspect at most three permitted public pages, compare evidence, and cite source IDs near claims."));
      view.append(make("p", "research-hint", "Search unavailable? Check Settings → The Brain for a Gemini key and a model with Google Search grounding access. The report will not pretend a search succeeded."));
      return view;
    }

    function renderHelp() {
      const view = make("section", "research-help");
      view.append(make("h2", "", "Research, with limits made visible"));
      const bullets = [
        "Provider: the existing Gemini API key and the Google Search grounding tool; no separate search key or package is added.",
        "The search stage and report stage each try at most two configured models; at most two tasks run at once. The existing shared Gemini daily budget and Google's account quotas/rate limits apply. Retries and token usage can incur charges, and Google Search may make multiple provider queries. Follow-ups use the saved report only; Update report runs fresh research.",
        "At most three public source pages are fetched per task. Fetches are HTTP/HTTPS only, public-address validated, pinned to DNS results, manually revalidated after redirects, limited to three redirects, 8 seconds, and 1 MB.",
        "A fetched source is a bounded text extract, not a full-page review. Search-only evidence, inaccessible pages, publication dates, and uncertainty are labelled.",
        "Reports separate extract-supported facts, search-only or publisher claims, inferences, open questions, and recommendations; disagreements and evidence gaps should be explicit.",
        "Page text is untrusted. It is never executed and cannot ask the agent to reveal local files, API keys, memory, or take actions.",
        "Reports are stored in runtime/research/. Tasks are temporary until saved. Web research is not automatically added to long-term memory; use the explicit finding form to save only text you select into runtime/knowledge.json.",
        "No login, form submission, purchase, posting, or automated email sending is performed. A report can only create a local Email draft after you ask.",
        "Google's published pricing note for Gemini 3+ Google Search grounding: 5,000 free search requests per month shared across those models, then $14 per 1,000 search requests; Gemini token charges are separate. Gemini 2.5 and older are billed per prompt. Check current terms and your account's billing/quotas before use.",
      ];
      const list = make("ul", "research-help-list");
      for (const text of bullets) list.append(make("li", "", text));
      view.append(list);
      const link = make("a", "research-source-url", "Google Search grounding documentation and current billing terms");
      link.href = "https://ai.google.dev/gemini-api/docs/google-search";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      view.append(link, make("p", "research-hint", "Price note from Google documentation retrieved 23 September 2026. Rates, free allowances, and supported-model lists can change; verify your current account terms before use."));
      return view;
    }

    function paintMain() {
      renderTabs();
      main.replaceChildren();
      main.setAttribute("aria-live", "polite");
      if (state.view === "help") { main.append(renderHelp()); return; }
      if (state.view === "saved") {
        const view = make("section", "research-saved-view");
        view.append(make("h2", "", "Saved reports"), make("p", "research-hint", "Search, reopen, rename, refresh, export, or delete after confirmation using the list in the Research rail."));
        main.append(view);
        return;
      }
      if (state.view === "task" && state.task) {
        main.append(renderTask(state.task));
      } else if (state.view === "report" && state.report) {
        main.append(renderReport(state.report, Boolean(state.savedReportId)));
      } else {
        main.append(renderNew());
      }
    }

    async function openSavedReport(id) {
      setError("Opening saved report…");
      stopPolling();
      state.taskId = null;
      try {
        const data = await api(`/api/research/reports/${encodeURIComponent(id)}`);
        state.report = data.report;
        state.savedReportId = data.report.id;
        state.task = null;
        state.taskId = null;
        state.followups = [];
        state.view = "report";
        paintMain();
        setError("");
      } catch (error) { setError(`Could not open report: ${error.message}`); }
    }

    workForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const prompt = question.value.trim();
      if (prompt.length < 8) { setError("Please enter a specific research question (at least eight characters)."); question.focus(); return; }
      if (prompt.length > 1200) { setError("Research questions are limited to 1,200 characters."); return; }
      startButton.disabled = true;
      setError("Starting a bounded research task…");
      try {
        const data = await api("/api/research/tasks", { method: "POST", body: JSON.stringify({ question: prompt }) });
        state.view = "task";
        state.task = data.task;
        state.report = null;
        state.savedReportId = null;
        state.followups = [];
        question.value = "";
        await refreshTaskList();
        paintMain();
        startPolling(data.task.id);
        setError("Task started. The status will say if search or source access fails.");
      } catch (error) { setError(`Research did not start: ${error.message}`); }
      finally { startButton.disabled = false; }
    });

    reportSearch.addEventListener("input", () => {
      state.searchText = reportSearch.value;
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => void refreshSavedReports(), 220);
    });

    await Promise.all([refreshProviderStatus(), refreshTaskList(), refreshSavedReports()]);
    const activeTask = state.tasks.find((task) => ["queued", "searching", "fetching", "synthesizing"].includes(task.status));
    if (activeTask) {
      state.view = "task";
      startPolling(activeTask.id);
    } else {
      const unsaved = state.tasks.find((task) => task.status === "complete" && !task.savedReportId);
      if (unsaved) { state.view = "task"; startPolling(unsaved.id); }
      else paintMain();
    }

    return {
      pause() { stopPolling(); },
      async resume() {
        if (state.destroyed) return;
        await Promise.all([refreshProviderStatus(), refreshTaskList(), refreshSavedReports()]);
        const active = state.tasks.find((task) => ["queued", "searching", "fetching", "synthesizing"].includes(task.status));
        if (active && active.id !== state.taskId) {
          state.view = "task";
          state.report = null;
          state.savedReportId = null;
          state.followups = [];
          startPolling(active.id);
        } else if (state.taskId) {
          startPolling(state.taskId);
        } else if (active) {
          state.view = "task";
          startPolling(active.id);
        }
        paintMain();
      },
      pauseOnRemove() { state.destroyed = true; stopPolling(); if (state.searchTimer) window.clearTimeout(state.searchTimer); },
    };
  },
};
