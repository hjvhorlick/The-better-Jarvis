/* Email workspace — local drafts only. No provider connection and no send API. */

const EMPTY_FIELDS = () => ({ to: "", cc: "", bcc: "", subject: "", body: "" });
const FIELD_NAMES = ["to", "cc", "bcc", "subject", "body"];

function recipients(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function encodeHeader(value) {
  const text = String(value || "");
  if (/[\r\n\0]/.test(text)) throw new TypeError("Mail addresses and header fields must be single-line text.");
  return encodeURIComponent(text);
}

/** Build a standards-safe mailto handoff; opening it never sends the message. */
export function mailtoForEmailDraft(fields = {}) {
  const to = recipients(fields.to).map(encodeHeader).join(",");
  const params = [];
  for (const key of ["cc", "bcc"]) {
    const value = recipients(fields[key]).join(",");
    if (value) params.push(`${key}=${encodeHeader(value)}`);
  }
  for (const key of ["subject", "body"]) {
    const value = String(fields[key] || "");
    if (value) {
      const encoded = key === "subject" ? encodeHeader(value) : encodeURIComponent(value);
      params.push(`${key}=${encoded}`);
    }
  }
  return `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
}

function emailText(fields) {
  const lines = [];
  if (fields.to) lines.push(`To: ${fields.to}`);
  if (fields.cc) lines.push(`Cc: ${fields.cc}`);
  if (fields.bcc) lines.push(`Bcc: ${fields.bcc}`);
  if (fields.subject) lines.push(`Subject: ${fields.subject}`);
  return `${lines.length ? `${lines.join("\n")}\n\n` : ""}${fields.body}`;
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "time unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function add(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

export default {
  async mount(body) {
    body.classList.add("email-env");
    if (!document.querySelector('link[data-email-workspace-css="true"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("./email.css", import.meta.url).href;
      link.dataset.emailWorkspaceCss = "true";
      document.head.appendChild(link);
    }

    const root = add(body, "section", "email-workspace");
    root.setAttribute("aria-label", "Email workspace");

    const heading = add(root, "header", "email-heading");
    const intro = add(heading, "div", "email-intro");
    add(intro, "h1", "", "Email");
    add(intro, "p", "", "A quiet place to prepare, review and keep drafts.");
    const safety = add(heading, "p", "email-safety",
      "Local drafts only · no email account connected · nothing is sent here.");
    safety.setAttribute("role", "note");

    const toolbar = add(root, "div", "email-toolbar");
    const nav = add(toolbar, "nav", "email-nav");
    nav.setAttribute("aria-label", "Email views");
    const navItems = [
      ["compose", "Compose"],
      ["drafts", "Drafts"],
      ["recent", "Recently edited"],
      ["help", "Settings / Help"],
    ];
    const navButtons = new Map();
    for (const [id, label] of navItems) {
      const button = add(nav, "button", "email-nav-button", label);
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => changeView(id));
      navButtons.set(id, button);
    }
    const searchWrap = add(toolbar, "label", "email-search-wrap");
    add(searchWrap, "span", "", "Search drafts");
    const search = add(searchWrap, "input", "email-search");
    search.type = "search";
    search.placeholder = "Recipient, subject or words in the body";
    search.setAttribute("aria-label", "Search email drafts");

    const status = add(root, "p", "email-status", "Loading local drafts…");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const workspace = add(root, "div", "email-workspace-grid");
    const listPanel = add(workspace, "aside", "email-list-panel");
    const listHeader = add(listPanel, "div", "email-list-header");
    const listTitle = add(listHeader, "h2", "", "Drafts");
    const listCount = add(listHeader, "span", "email-list-count", "0");
    const draftList = add(listPanel, "div", "email-draft-list");
    draftList.setAttribute("role", "list");
    draftList.setAttribute("aria-label", "Saved email drafts");

    const main = add(workspace, "main", "email-main");
    const form = add(main, "form", "email-editor");
    form.noValidate = true;
    const editorHeader = add(form, "div", "email-editor-header");
    const editorTitle = add(editorHeader, "h2", "", "New draft");
    const lastEdited = add(editorHeader, "p", "email-last-edited", "Not saved yet");

    const fields = {};
    const textInput = (key, labelText, placeholder = "") => {
      const wrap = add(form, "label", "email-field");
      add(wrap, "span", "email-field-label", labelText);
      const input = add(wrap, "input", "email-input");
      input.type = "text";
      input.autocomplete = key === "to" || key === "cc" || key === "bcc" ? "off" : "on";
      input.placeholder = placeholder;
      input.name = key;
      input.addEventListener("input", () => fieldChanged(key, input.value));
      fields[key] = input;
      return wrap;
    };
    textInput("to", "To", "Name or email address");
    textInput("cc", "CC", "Optional");
    textInput("bcc", "BCC", "Optional");
    textInput("subject", "Subject", "Add a subject when you know it");
    const bodyWrap = add(form, "label", "email-field email-body-field");
    add(bodyWrap, "span", "email-field-label", "Body");
    const bodyInput = add(bodyWrap, "textarea", "email-body");
    bodyInput.name = "body";
    bodyInput.rows = 12;
    bodyInput.placeholder = "Write in your own words. Use [brackets] for details you still need to add.";
    bodyInput.addEventListener("input", () => fieldChanged("body", bodyInput.value));
    fields.body = bodyInput;

    add(form, "p", "email-editor-hint",
      "Save keeps a local copy. Missing details stay yours to fill in; your wording is not rewritten.");
    const actions = add(form, "div", "email-actions");
    const saveButton = add(actions, "button", "email-action email-primary", "Save draft");
    saveButton.type = "submit";
    const copyButton = add(actions, "button", "email-action", "Copy text");
    copyButton.type = "button";
    const duplicateButton = add(actions, "button", "email-action", "Duplicate");
    duplicateButton.type = "button";
    const deleteButton = add(actions, "button", "email-action email-danger", "Delete");
    deleteButton.type = "button";
    const mailtoLink = add(actions, "a", "email-action email-handoff", "Open in mail app");
    mailtoLink.target = "_blank";
    mailtoLink.rel = "noopener noreferrer";
    mailtoLink.title = "Prepare this draft in your mail app. Review it there; this workspace does not send it.";

    const help = add(main, "section", "email-help");
    help.hidden = true;
    add(help, "h2", "", "Settings / Help");
    add(help, "p", "", "This room is a local drafting desk. It does not connect to Gmail, Outlook or another provider, and it cannot send email.");
    add(help, "p", "", "Drafts are stored by the server in runtime/drafts/ and are shared with the existing local drafting desk. They are not kept in browser localStorage.");
    add(help, "p", "", "Use Compose to start, Drafts to reopen saved work, Recently edited to find the latest changes, or Search drafts to find text across To, CC, BCC, Subject and Body.");
    add(help, "p", "", "Save before switching drafts. Delete always asks you to confirm. Open in mail app creates a mailto handoff for your review; it is not a send action.");
    add(help, "p", "email-help-command", "You can also ask Jarvis: “draft an email to Alex about Friday”, “set subject of draft 4 to …”, “set recipient of draft 4 to …”, or “append … to body of draft 4”.");

    const state = {
      view: "drafts",
      drafts: [],
      currentId: null,
      currentUpdated: null,
      values: EMPTY_FIELDS(),
      dirty: false,
      search: "",
      initialized: false,
      searchTimer: null,
    };

    async function api(url, options = {}) {
      const response = await fetch(url, options);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Server returned HTTP ${response.status}`);
      return result;
    }

    function say(message, kind = "") {
      status.textContent = message;
      status.classList.toggle("is-error", kind === "error");
      status.classList.toggle("is-success", kind === "success");
    }

    function readFields() {
      return Object.fromEntries(FIELD_NAMES.map((key) => [key, fields[key].value]));
    }

    function setFields(values) {
      state.values = { ...EMPTY_FIELDS(), ...values };
      for (const key of FIELD_NAMES) fields[key].value = state.values[key];
      updateHandoff();
      renderEditorMeta();
    }

    function updateHandoff() {
      mailtoLink.href = mailtoForEmailDraft(readFields());
    }

    function fieldChanged(key, value) {
      state.values[key] = value;
      state.dirty = true;
      updateHandoff();
      renderEditorMeta();
      if (!state.currentId) say("Unsaved new draft — use Save draft to keep it on this computer.");
      else say(`Unsaved changes to draft ${state.currentId} — save before switching drafts.`);
    }

    function renderEditorMeta() {
      editorTitle.textContent = state.currentId ? `Email draft #${state.currentId}` : "New draft";
      lastEdited.textContent = state.currentId
        ? `Last edited ${formatDate(state.currentUpdated)}`
        : "Not saved yet";
      duplicateButton.disabled = !state.currentId;
      deleteButton.disabled = !state.currentId;
    }

    function orderedDrafts() {
      const items = state.drafts.slice();
      const timestamp = (draft, key) => Date.parse(draft[key] || draft.created || "") || 0;
      if (state.view === "recent") items.sort((a, b) => timestamp(b, "updated") - timestamp(a, "updated"));
      else items.sort((a, b) => timestamp(b, "created") - timestamp(a, "created"));
      return items;
    }

    function renderList() {
      const items = orderedDrafts();
      listTitle.textContent = state.view === "recent" ? "Recently edited" : "Drafts";
      listCount.textContent = String(items.length);
      draftList.textContent = "";
      if (!items.length) {
        const empty = add(draftList, "p", "email-empty-list",
          state.search ? "No drafts match that search." : "No saved email drafts yet. Choose Compose to start one.");
        empty.setAttribute("role", "note");
        return;
      }
      for (const draft of items) {
        const row = add(draftList, "button", "email-draft-row");
        row.type = "button";
        row.setAttribute("role", "listitem");
        row.setAttribute("aria-pressed", state.currentId === draft.id ? "true" : "false");
        const title = add(row, "span", "email-row-subject", draft.subject || "(No subject)");
        title.title = draft.subject || "No subject";
        add(row, "span", "email-row-recipient", draft.to || "No recipient named");
        add(row, "time", "email-row-time", formatDate(draft.updated || draft.created));
        row.addEventListener("click", () => openDraft(draft.id));
      }
    }

    function renderView() {
      for (const [id, button] of navButtons) button.setAttribute("aria-pressed", state.view === id ? "true" : "false");
      form.hidden = state.view === "help";
      help.hidden = state.view !== "help";
      searchWrap.hidden = state.view === "help";
      renderList();
      renderEditorMeta();
    }

    function hasUnsavedChanges() {
      return state.dirty && window.confirm("Discard these unsaved changes? Save the draft first if you want to keep them.");
    }

    async function openDraft(id, force = false) {
      if (!force && state.dirty && !hasUnsavedChanges()) return;
      say(`Opening draft ${id}…`);
      try {
        const result = await api(`/api/email/drafts/${encodeURIComponent(id)}`);
        state.currentId = result.draft.id;
        state.currentUpdated = result.draft.updated || result.draft.created;
        state.dirty = false;
        setFields(result.draft);
        state.dirty = false;
        state.view = state.view === "help" ? "drafts" : state.view;
        renderView();
        say(`Draft ${state.currentId} opened. Changes stay local until saved.`);
      } catch (error) {
        say(`Could not open draft ${id}: ${error.message}`, "error");
      }
    }

    async function refreshList(selectLatest = false) {
      const query = state.search.trim();
      const url = `/api/email/drafts${query ? `?q=${encodeURIComponent(query)}` : ""}`;
      try {
        const result = await api(url);
        state.drafts = Array.isArray(result.drafts) ? result.drafts : [];
        renderList();
        if (!state.dirty && state.currentId) await openDraft(state.currentId, true);
        else if (!state.dirty && !state.currentId && selectLatest && state.drafts.length) {
          await openDraft(orderedDrafts()[0].id, true);
        } else if (!state.drafts.length && !state.currentId) {
          say("No saved email drafts yet. Choose Compose to start one.");
        }
      } catch (error) {
        say(`Could not load local drafts: ${error.message}`, "error");
      }
    }

    async function changeView(view) {
      if (view === "compose") {
        if (state.dirty && !hasUnsavedChanges()) return;
        state.currentId = null;
        state.currentUpdated = null;
        state.dirty = false;
        setFields(EMPTY_FIELDS());
      }
      state.view = view;
      renderView();
      if ((view === "drafts" || view === "recent") && !state.currentId && state.drafts.length) {
        await openDraft(orderedDrafts()[0].id, true);
      } else if (view !== "help") {
        await refreshList(false);
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      saveButton.disabled = true;
      say("Saving local draft…");
      const method = state.currentId ? "PUT" : "POST";
      const url = state.currentId ? `/api/email/drafts/${encodeURIComponent(state.currentId)}` : "/api/email/drafts";
      try {
        const result = await api(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(readFields()),
        });
        state.currentId = result.draft.id;
        state.currentUpdated = result.draft.updated || result.draft.created;
        state.dirty = false;
        setFields(result.draft);
        state.dirty = false;
        state.view = "drafts";
        renderView();
        await refreshList(false);
        say(`Saved local draft #${state.currentId}. It has not been sent.`, "success");
      } catch (error) {
        say(`Save failed: ${error.message}. Your editor text is still here; try again.`, "error");
      } finally {
        saveButton.disabled = false;
      }
    });

    copyButton.addEventListener("click", async () => {
      const text = emailText(readFields());
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const temporary = document.createElement("textarea");
          temporary.value = text;
          temporary.setAttribute("readonly", "");
          temporary.style.position = "fixed";
          temporary.style.opacity = "0";
          document.body.appendChild(temporary);
          temporary.select();
          const copied = document.execCommand("copy");
          temporary.remove();
          if (!copied) throw new Error("Clipboard permission was not granted");
        }
        say("Copied draft text to the clipboard. Nothing was sent.", "success");
      } catch (error) {
        say(`Could not copy: ${error.message}`, "error");
      }
    });

    duplicateButton.addEventListener("click", async () => {
      if (!state.currentId) return;
      if (state.dirty && !hasUnsavedChanges()) return;
      duplicateButton.disabled = true;
      try {
        const result = await api(`/api/email/drafts/${encodeURIComponent(state.currentId)}/duplicate`, { method: "POST" });
        state.currentId = result.draft.id;
        state.currentUpdated = result.draft.updated || result.draft.created;
        state.dirty = false;
        setFields(result.draft);
        state.dirty = false;
        state.view = "drafts";
        await refreshList(false);
        renderView();
        say(`Created a separate copy as draft #${state.currentId}.`, "success");
      } catch (error) {
        say(`Could not duplicate draft: ${error.message}`, "error");
      } finally {
        duplicateButton.disabled = !state.currentId;
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (!state.currentId) return;
      const id = state.currentId;
      if (!window.confirm(`Delete local draft #${id}? This removes it from this computer and cannot be undone.`)) return;
      deleteButton.disabled = true;
      try {
        await api(`/api/email/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.currentId = null;
        state.currentUpdated = null;
        state.dirty = false;
        setFields(EMPTY_FIELDS());
        await refreshList(false);
        renderView();
        say(`Draft #${id} was deleted from local storage. No email was sent.`, "success");
      } catch (error) {
        say(`Delete failed: ${error.message}`, "error");
      } finally {
        deleteButton.disabled = !state.currentId;
      }
    });

    search.addEventListener("input", () => {
      state.search = search.value;
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => refreshList(false), 180);
    });
    mailtoLink.addEventListener("click", () => {
      updateHandoff();
      say("Handing this draft to your mail app for review. This workspace has not sent it.");
    });

    // Save the selected draft's ID in memory only; draft contents always come
    // from the authenticated local API, never browser localStorage.
    await refreshList(true);
    state.initialized = true;
    renderView();

    return {
      async resume() {
        if (!state.initialized) return;
        // A local voice/typed command may have created or edited a draft while
        // this room was open. Refresh the same stable ID without losing unsaved
        // editor text; if no draft was selected, open the newest one.
        await refreshList(!state.currentId && !state.dirty);
      },
    };
  },
};
