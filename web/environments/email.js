/* Email room — safe, provider-neutral draft preparation.
 *
 * Drafts are stored only in this browser's localStorage. This room does not
 * connect to an email provider or send messages. "Open in mail app" hands the
 * draft to the user's configured mail client for review and sending.
 */
export default {
  mount(body) {
    const host = document.createElement("div");
    host.className = "email-room";
    body.appendChild(host);

    const compose = document.createElement("section");
    compose.className = "email-compose";
    host.appendChild(compose);

    const heading = document.createElement("h2");
    heading.textContent = "Prepare an email";
    compose.appendChild(heading);

    const note = document.createElement("p");
    note.className = "email-note";
    note.textContent = "Drafts stay in this browser. Nothing is sent by Supper AI Agent. Review the message in your mail app before sending.";
    compose.appendChild(note);

    const fields = {};
    function field(key, labelText, type = "text") {
      const wrap = document.createElement("div");
      wrap.className = "email-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      label.htmlFor = `email-${key}`;
      let input;
      if (type === "textarea") {
        input = document.createElement("textarea");
      } else {
        input = document.createElement("input");
        input.type = type;
        if (type === "email") input.autocomplete = "email";
      }
      input.id = `email-${key}`;
      input.name = key;
      wrap.append(label, input);
      compose.appendChild(wrap);
      fields[key] = input;
      return input;
    }
    field("to", "To", "email");
    field("cc", "CC (optional)");
    field("subject", "Subject");
    field("body", "Message", "textarea");

    const actions = document.createElement("div");
    actions.className = "email-actions";
    compose.appendChild(actions);

    const status = document.createElement("p");
    status.className = "email-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    compose.appendChild(status);
    const say = (message) => { status.textContent = message; };

    const savedPanel = document.createElement("aside");
    savedPanel.className = "email-saved";
    host.appendChild(savedPanel);
    const savedHeading = document.createElement("h2");
    savedHeading.textContent = "Saved drafts";
    savedPanel.appendChild(savedHeading);
    const savedNote = document.createElement("p");
    savedNote.className = "email-note";
    savedNote.textContent = "Saved locally in this browser, not in an email account.";
    savedPanel.appendChild(savedNote);
    const savedList = document.createElement("div");
    savedList.className = "email-saved-list";
    savedPanel.appendChild(savedList);

    const STORAGE_KEY = "supper.emailDrafts.v1";
    const MAX_DRAFTS = 100;
    let currentId = null;

    function readDrafts() {
      try {
        const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        return Array.isArray(data) ? data.filter(d => d && typeof d.id === "string") : [];
      } catch (_) {
        return [];
      }
    }
    function writeDrafts(drafts) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts.slice(0, MAX_DRAFTS)));
        return true;
      } catch (_) {
        say("Could not save drafts. Browser storage may be full or disabled.");
        return false;
      }
    }
    function currentDraft() {
      return {
        id: currentId || (globalThis.crypto && crypto.randomUUID
          ? crypto.randomUUID() : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
        to: fields.to.value.trim().slice(0, 320),
        cc: fields.cc.value.trim().slice(0, 320),
        subject: fields.subject.value.trim().slice(0, 500),
        body: fields.body.value.slice(0, 30000),
        updated: new Date().toISOString(),
      };
    }
    function loadDraft(draft) {
      currentId = draft.id;
      for (const key of ["to", "cc", "subject", "body"]) fields[key].value = draft[key] || "";
      say("Draft loaded. Review it before using your mail app.");
    }
    function renderSaved() {
      savedList.textContent = "";
      const drafts = readDrafts().sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      if (!drafts.length) {
        const empty = document.createElement("p");
        empty.className = "email-note";
        empty.textContent = "No saved drafts yet.";
        savedList.appendChild(empty);
        return;
      }
      for (const draft of drafts) {
        const row = document.createElement("div");
        row.className = "email-saved-item";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "email-saved-open";
        open.textContent = draft.subject || "(No subject)";
        open.title = draft.to ? `To: ${draft.to}` : "Load draft";
        open.addEventListener("click", () => loadDraft(draft));
        const del = document.createElement("button");
        del.type = "button";
        del.className = "email-saved-delete";
        del.textContent = "Delete";
        del.setAttribute("aria-label", `Delete draft ${draft.subject || "without subject"}`);
        del.addEventListener("click", () => {
          if (!window.confirm("Delete this saved draft from this browser?")) return;
          const remaining = readDrafts().filter(item => item.id !== draft.id);
          if (writeDrafts(remaining)) {
            if (currentId === draft.id) currentId = null;
            renderSaved();
            say("Saved draft deleted.");
          }
        });
        row.append(open, del);
        savedList.appendChild(row);
      }
    }
    function button(label, run) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", run);
      actions.appendChild(b);
      return b;
    }

    button("New draft", () => {
      currentId = null;
      for (const key of Object.keys(fields)) fields[key].value = "";
      say("New draft ready.");
      fields.to.focus();
    });
    button("Save draft", () => {
      const draft = currentDraft();
      const drafts = readDrafts().filter(item => item.id !== draft.id);
      drafts.unshift(draft);
      if (writeDrafts(drafts)) {
        currentId = draft.id;
        renderSaved();
        say("Draft saved in this browser only.");
      }
    });
    button("Copy email", async () => {
      const draft = currentDraft();
      const text = `To: ${draft.to}\n${draft.cc ? `CC: ${draft.cc}\n` : ""}Subject: ${draft.subject}\n\n${draft.body}`;
      try {
        await navigator.clipboard.writeText(text);
        say("Email copied to clipboard.");
      } catch (_) {
        const fallback = document.createElement("textarea");
        fallback.className = "studio-raw";
        fallback.value = text;
        fallback.setAttribute("aria-label", "Complete email draft ready to copy");
        compose.appendChild(fallback);
        fallback.focus();
        fallback.select();
        say("Clipboard access was blocked. The complete email is selected below so you can copy it manually.");
      }
    });
    button("Open in mail app", () => {
      const draft = currentDraft();
      if (!draft.to && !draft.subject && !draft.body) {
        say("Enter a recipient, subject or message first.");
        return;
      }
      const params = [];
      if (draft.cc) params.push(`cc=${encodeURIComponent(draft.cc)}`);
      if (draft.subject) params.push(`subject=${encodeURIComponent(draft.subject)}`);
      if (draft.body) params.push(`body=${encodeURIComponent(draft.body)}`);
      const recipient = encodeURIComponent(draft.to).replace(/%40/gi, "@");
      const url = `mailto:${recipient}${params.length ? `?${params.join("&")}` : ""}`;
      say("Opening your configured mail app. Check the message there; Supper AI Agent has not sent it.");
      window.location.href = url;
    });

    renderSaved();
    say("Ready. Create a draft or load one saved in this browser.");
  },
};
