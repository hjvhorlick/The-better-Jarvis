/* Files environment — browse and read what is on this computer.
 *
 * Two panes: folders on the left, the file on the right. Read-only on purpose.
 * The app only ever looks inside the folders you have allowed it to, and the
 * text is written with textContent, so a file can never run anything.
 */
export default {
  mount(body) {
    body.classList.add("files-env");

    const pane = document.createElement("div");
    pane.className = "files-pane";

    const list = document.createElement("div");
    list.className = "files-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Files and folders");

    const view = document.createElement("pre");
    view.className = "files-view";
    view.tabIndex = 0;

    pane.appendChild(list);
    pane.appendChild(view);
    body.appendChild(pane);

    const status = document.createElement("p");
    status.className = "files-status";
    status.setAttribute("role", "status");
    body.appendChild(status);

    const state = { path: null, parent: null };
    const say = (t) => { status.textContent = t; };

    async function api(path) {
      const r = await fetch(path);
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error((b && b.detail) || `HTTP ${r.status}`);
      return b;
    }

    async function showRoots() {
      state.path = null; state.parent = null;
      view.textContent = "Choose a file to preview it.";
      say("Allowed folders");
      try {
        const data = await api("/api/files/roots");
        list.textContent = "";
        if (!data.roots.length) {
          say("No folders are allowed yet. Set SUPPER_FILE_ROOTS to point at your work.");
          return;
        }
        for (const r of data.roots) list.appendChild(row(r.name, r.path, "folder"));
      } catch (e) { say(`Could not list folders: ${e.message}`); }
    }

    async function openDir(path) {
      say("Opening…");
      try {
        const data = await api(`/api/files/list?path=${encodeURIComponent(path)}`);
        state.path = data.path; state.parent = data.parent;
        list.textContent = "";
        if (data.parent) list.appendChild(row("↑ up", data.parent, "folder"));
        for (const e of data.entries) {
          list.appendChild(row(e.name, e.path, e.kind === "folder" ? "folder" : "file"));
        }
        say(data.truncated ? `${data.path} — first 500 items` : data.path);
      } catch (e) { say(`Could not open that folder: ${e.message}`); }
    }

    async function openFile(path, name) {
      view.textContent = "Loading…";
      say(name);
      try {
        const data = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
        const head = `${data.name} — ${data.size} bytes${data.truncated ? " (first 64 KB shown)" : ""}\n\n`;
        view.textContent = head + data.text;
        view.scrollTop = 0;
      } catch (e) { view.textContent = `Cannot preview: ${e.message}`; }
    }

    function row(label, path, kind) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `files-row is-${kind}`;
      b.setAttribute("role", "option");
      b.textContent = (kind === "folder" ? "📁 " : "📄 ") + label;
      b.addEventListener("click", () => {
        if (kind === "folder") openDir(path);
        else openFile(path, label);
      });
      return b;
    }

    document.getElementById("tool-files-up").addEventListener("click", () => {
      if (state.parent) openDir(state.parent);
      else showRoots();
    });

    showRoots();
  },
};
