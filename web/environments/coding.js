/* Coding environment — your code, and Jarvis on hand for it.
 *
 * A two-pane workspace: the tree on the left, the file on the right. The tool
 * tabs at the top do the two things you actually want while reading code — ask
 * Jarvis about the open file, or jump back to the top of the tree.
 *
 * Being in this environment also tells Jarvis you are coding, so answers come
 * back precise and code-first rather than chatty.
 */
export default {
  mount(body, env) {
    body.classList.add("code-env");

    const pane = document.createElement("div");
    pane.className = "code-pane";

    const tree = document.createElement("div");
    tree.className = "code-tree";
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Files");

    const viewer = document.createElement("div");
    viewer.className = "code-viewer";
    viewer.tabIndex = 0;

    pane.appendChild(tree);
    pane.appendChild(viewer);
    body.appendChild(pane);

    const status = document.createElement("p");
    status.className = "code-status";
    status.setAttribute("role", "status");
    body.appendChild(status);

    const state = { path: null, parent: null, name: null };

    async function api(path) {
      const r = await fetch(path);
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error((b && b.detail) || `HTTP ${r.status}`);
      return b;
    }

    function say(t) { status.textContent = t; }

    async function showRoots() {
      state.path = null; state.parent = null; state.name = null;
      viewer.textContent = "Pick a file to read it.";
      say("Allowed folders");
      try {
        const data = await api("/api/files/roots");
        tree.textContent = "";
        if (!data.roots.length) {
          say("No folders are allowed yet. Set SUPPER_FILE_ROOTS to point at your projects.");
          return;
        }
        for (const r of data.roots) tree.appendChild(row(r.name, r.path, "folder"));
      } catch (e) { say(`Could not list folders: ${e.message}`); }
    }

    async function openDir(path) {
      say("Opening…");
      try {
        const data = await api(`/api/files/list?path=${encodeURIComponent(path)}`);
        state.path = data.path; state.parent = data.parent;
        tree.textContent = "";
        if (data.parent) tree.appendChild(row("↑ up", data.parent, "folder"));
        for (const e of data.entries) {
          tree.appendChild(row(e.name, e.path, e.kind === "folder" ? "folder" : "file"));
        }
        say(data.truncated ? `${data.path} — first 500 items` : data.path);
      } catch (e) { say(`Could not open that folder: ${e.message}`); }
    }

    async function openFile(path, name) {
      state.name = name;
      viewer.textContent = "Loading…";
      say(name);
      try {
        const data = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
        const head = `${data.name} — ${data.size} bytes${data.truncated ? " (first 64 KB)" : ""}\n\n`;
        viewer.textContent = head + data.text;
        viewer.scrollTop = 0;
      } catch (e) { viewer.textContent = `Cannot read: ${e.message}`; }
    }

    function row(label, path, kind) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `code-row is-${kind}`;
      b.setAttribute("role", "treeitem");
      b.textContent = (kind === "folder" ? "▸ " : "· ") + label;
      b.addEventListener("click", () => {
        if (kind === "folder") openDir(path);
        else openFile(path, label);
      });
      return b;
    }

    // ---------- tool tabs ----------
    document.getElementById("tool-coding-ask").addEventListener("click", () => {
      if (!state.name) { say("Open a file first, then ask about it."); return; }
      const box = document.getElementById("input");
      if (box) {
        box.value = `About ${state.name}: `;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
      say(`Ask anything about ${state.name}.`);
    });

    document.getElementById("tool-coding-top").addEventListener("click", showRoots);

    showRoots();
  },
};
