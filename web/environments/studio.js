/* Studio — the room where Jarvis makes the video with you.
 *
 * The job: you say what the video is about, Jarvis writes the script, the title
 * and a picture prompt for every shot; the pictures come from a free service
 * that needs no account; everything made is kept in a library you can search;
 * and the finished script is laid out ready to paste into Scenering, which
 * turns it into the video. There is a compile button too, which plays the shot
 * list through a canvas and records it, so you get a real video file without
 * installing anything.
 *
 * Plain JavaScript, no build step. Text from the server is written with
 * textContent only.
 */
export default {
  async mount(body, env) {
    const host = document.createElement("div");
    host.className = "studio";
    body.appendChild(host);

    const say = (text) => { readout.textContent = text; };

    // ---------- the shape of what we are making ----------
    const state = {
      brief: "",
      seconds: 30,
      aspect: "16:9",
      model: "flux",
      script: null,          // Existing title/hook/shots scene structure
      project: null,
      research: null,
      dirty: false,
      saving: false,
      busy: false,
      compiling: false,
      projectSearchSeq: 0,
    };

    // ---------- the brief ----------
    const briefBox = document.createElement("div");
    briefBox.className = "studio-brief";
    host.appendChild(briefBox);

    const briefLabel = document.createElement("label");
    briefLabel.className = "studio-label";
    briefLabel.textContent = "What is the video about?";
    briefLabel.htmlFor = "studio-brief-input";
    briefBox.appendChild(briefLabel);

    const briefInput = document.createElement("input");
    briefInput.id = "studio-brief-input";
    briefInput.type = "text";
    briefInput.maxLength = 2000;
    briefInput.placeholder = "a 30-second explainer on why the ocean is salty";
    briefInput.addEventListener("input", () => { state.brief = briefInput.value; markDirty(); });
    briefBox.appendChild(briefInput);

    const audienceLabel = document.createElement("label");
    audienceLabel.className = "studio-label";
    audienceLabel.textContent = "Intended audience (optional)";
    audienceLabel.htmlFor = "studio-audience";
    briefBox.appendChild(audienceLabel);

    const audienceInput = document.createElement("input");
    audienceInput.id = "studio-audience";
    audienceInput.type = "text";
    audienceInput.maxLength = 400;
    audienceInput.placeholder = "e.g. first-time viewers, teens, a church group";
    audienceInput.addEventListener("input", markDirty);
    briefBox.appendChild(audienceInput);

    const narrationLabel = document.createElement("label");
    narrationLabel.className = "studio-label";
    narrationLabel.textContent = "Narration or dialogue notes (optional)";
    narrationLabel.htmlFor = "studio-narration-notes";
    briefBox.appendChild(narrationLabel);

    const narrationNotesInput = document.createElement("textarea");
    narrationNotesInput.id = "studio-narration-notes";
    narrationNotesInput.rows = 2;
    narrationNotesInput.maxLength = 2000;
    narrationNotesInput.placeholder = "Tone, speaker, pronunciation, or dialogue cues";
    narrationNotesInput.addEventListener("input", markDirty);
    briefBox.appendChild(narrationNotesInput);

    const sourceScriptLabel = document.createElement("label");
    sourceScriptLabel.className = "studio-label";
    sourceScriptLabel.textContent = "Existing script to break into scenes (optional)";
    sourceScriptLabel.htmlFor = "studio-source-script";
    briefBox.appendChild(sourceScriptLabel);

    const sourceScriptInput = document.createElement("textarea");
    sourceScriptInput.id = "studio-source-script";
    sourceScriptInput.rows = 4;
    sourceScriptInput.maxLength = 12000;
    sourceScriptInput.placeholder = "Paste a script here to organise it into scenes";
    sourceScriptInput.addEventListener("input", markDirty);
    briefBox.appendChild(sourceScriptInput);

    const researchBox = document.createElement("div");
    researchBox.className = "studio-research-picker";
    briefBox.appendChild(researchBox);

    const researchLabel = document.createElement("label");
    researchLabel.className = "studio-label";
    researchLabel.textContent = "Saved Research report (optional)";
    researchLabel.htmlFor = "studio-research-select";
    researchBox.appendChild(researchLabel);

    const researchRow = document.createElement("div");
    researchRow.className = "studio-row";
    researchBox.appendChild(researchRow);

    const researchSelect = document.createElement("select");
    researchSelect.id = "studio-research-select";
    researchSelect.setAttribute("aria-label", "Choose a saved Research report");
    researchRow.appendChild(researchSelect);

    const attachResearchButton = document.createElement("button");
    attachResearchButton.type = "button";
    attachResearchButton.className = "studio-button";
    attachResearchButton.textContent = "Attach report";
    researchRow.appendChild(attachResearchButton);

    const researchNote = document.createElement("p");
    researchNote.className = "studio-note";
    researchNote.textContent = "Research is attached only when you choose it. Sources stay linked; Jarvis never converts a report automatically.";
    researchBox.appendChild(researchNote);

    const researchCard = document.createElement("div");
    researchCard.className = "studio-research-card";
    researchCard.setAttribute("aria-live", "polite");
    researchBox.appendChild(researchCard);

    const row = document.createElement("div");
    row.className = "studio-row";
    briefBox.appendChild(row);

    const secLabel = document.createElement("label");
    secLabel.className = "studio-label";
    secLabel.textContent = "Length";
    secLabel.htmlFor = "studio-seconds";
    row.appendChild(secLabel);

    const secInput = document.createElement("input");
    secInput.id = "studio-seconds";
    secInput.type = "number";
    secInput.min = "5";
    secInput.max = "600";
    secInput.value = "30";
    secInput.addEventListener("input", () => {
      state.seconds = Math.max(5, Math.min(600, Number(secInput.value) || 30));
      markDirty();
    });
    row.appendChild(secInput);

    const shapeLabel = document.createElement("label");
    shapeLabel.className = "studio-label";
    shapeLabel.textContent = "Shape";
    shapeLabel.htmlFor = "studio-aspect";
    row.appendChild(shapeLabel);

    const aspect = document.createElement("select");
    aspect.id = "studio-aspect";
    for (const [name, note] of [
      ["16:9", "YouTube / landscape"],
      ["9:16", "vertical short"],
    ]) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = `${name} — ${note}`;
      aspect.appendChild(o);
    }
    aspect.value = state.aspect;
    aspect.addEventListener("change", () => { state.aspect = aspect.value; markDirty(); });
    row.appendChild(aspect);

    const modelLabel = document.createElement("label");
    modelLabel.className = "studio-label";
    modelLabel.textContent = "Picture model";
    modelLabel.htmlFor = "studio-model";
    row.appendChild(modelLabel);

    const model = document.createElement("select");
    model.id = "studio-model";
    for (const m of ["flux", "turbo"]) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      model.appendChild(o);
    }
    model.addEventListener("change", () => { state.model = model.value; });
    row.appendChild(model);

    // ---------- the script ----------
    const scriptBox = document.createElement("section");
    scriptBox.className = "studio-script";
    scriptBox.setAttribute("aria-label", "The script");
    host.appendChild(scriptBox);

    const titleLine = document.createElement("div");
    titleLine.className = "studio-title-line";
    scriptBox.appendChild(titleLine);

    const titleInput = document.createElement("input");
    titleInput.id = "studio-title";
    titleInput.type = "text";
    titleInput.placeholder = "the title";
    titleInput.setAttribute("aria-label", "Video title");
    titleInput.addEventListener("input", () => {
      if (state.script) state.script.title = titleInput.value;
      markDirty();
    });
    titleLine.appendChild(titleInput);

    const variants = document.createElement("select");
    variants.id = "studio-variants";
    variants.setAttribute("aria-label", "Other title options Jarvis suggested");
    variants.hidden = true;
    variants.addEventListener("change", () => {
      if (variants.value) {
        titleInput.value = variants.value;
        if (state.script) state.script.title = variants.value;
        markDirty();
        variants.value = "";
      }
    });
    titleLine.appendChild(variants);

    const projectMeta = document.createElement("p");
    projectMeta.className = "studio-project-meta";
    projectMeta.setAttribute("role", "status");
    projectMeta.id = "studio-project-meta";
    scriptBox.appendChild(projectMeta);

    const creativeDetails = document.createElement("details");
    creativeDetails.className = "studio-creative-details";
    scriptBox.appendChild(creativeDetails);

    const creativeSummary = document.createElement("summary");
    creativeSummary.textContent = "Music and sound ideas (creative suggestions)";
    creativeDetails.appendChild(creativeSummary);

    const musicLabel = document.createElement("label");
    musicLabel.className = "studio-label";
    musicLabel.textContent = "Music suggestion";
    creativeDetails.appendChild(musicLabel);

    const musicInput = document.createElement("textarea");
    musicInput.id = "studio-music-suggestion";
    musicInput.rows = 2;
    musicInput.maxLength = 2000;
    musicInput.addEventListener("input", markDirty);
    creativeDetails.appendChild(musicInput);

    const soundLabel = document.createElement("label");
    soundLabel.className = "studio-label";
    soundLabel.textContent = "Sound-effect suggestions";
    creativeDetails.appendChild(soundLabel);

    const soundInput = document.createElement("textarea");
    soundInput.id = "studio-sound-suggestions";
    soundInput.rows = 2;
    soundInput.maxLength = 2000;
    soundInput.addEventListener("input", markDirty);
    creativeDetails.appendChild(soundInput);

    const shots = document.createElement("div");
    shots.className = "studio-shots";
    shots.id = "studio-shots";
    scriptBox.appendChild(shots);

    // ---------- the library ----------
    const libraryBox = document.createElement("aside");
    libraryBox.className = "studio-library";
    libraryBox.setAttribute("aria-label", "Everything you have made");
    host.appendChild(libraryBox);

    const projectShelf = document.createElement("section");
    projectShelf.className = "studio-project-shelf";
    projectShelf.setAttribute("aria-label", "Saved video projects");
    libraryBox.appendChild(projectShelf);

    const projectHead = document.createElement("div");
    projectHead.className = "studio-library-head";
    projectShelf.appendChild(projectHead);

    const projectTitle = document.createElement("strong");
    projectTitle.textContent = "Video projects";
    projectHead.appendChild(projectTitle);

    const projectSearch = document.createElement("input");
    projectSearch.type = "search";
    projectSearch.placeholder = "Search saved projects";
    projectSearch.setAttribute("aria-label", "Search saved video projects");
    projectSearch.addEventListener("input", () => loadProjects(projectSearch.value));
    projectHead.appendChild(projectSearch);

    const projectActions = document.createElement("div");
    projectActions.className = "studio-project-actions";
    projectShelf.appendChild(projectActions);

    const newProjectButton = actionButton("New project", "Start an empty video project");
    projectActions.appendChild(newProjectButton);
    const saveProjectButton = actionButton("Save project", "Save or update this local video project");
    projectActions.appendChild(saveProjectButton);
    const duplicateProjectButton = actionButton("Duplicate", "Duplicate the current saved project");
    projectActions.appendChild(duplicateProjectButton);
    const renameProjectButton = actionButton("Rename", "Rename the current saved project");
    projectActions.appendChild(renameProjectButton);
    const deleteProjectButton = actionButton("Delete", "Delete the current saved project after confirmation");
    projectActions.appendChild(deleteProjectButton);

    const projectList = document.createElement("div");
    projectList.className = "studio-project-list";
    projectList.setAttribute("aria-live", "polite");
    projectShelf.appendChild(projectList);

    const exportActions = document.createElement("div");
    exportActions.className = "studio-project-actions";
    projectShelf.appendChild(exportActions);

    const copyScriptButton = actionButton("Copy script", "Copy the current script for manual pasting into Scenering");
    exportActions.appendChild(copyScriptButton);
    const copyScenesButton = actionButton("Copy scene breakdown", "Copy narration, captions, visual prompts and source links");
    exportActions.appendChild(copyScenesButton);
    const copyProjectButton = actionButton("Copy project brief", "Copy project details and research provenance");
    exportActions.appendChild(copyProjectButton);

    const openSceneringButton = actionButton("Open Scenering", "Open Scenering separately; nothing is transferred");
    projectShelf.appendChild(openSceneringButton);

    const manualHandoff = document.createElement("p");
    manualHandoff.className = "studio-note";
    manualHandoff.textContent = "Scenering remains a separate app. No supported project-import API or format was verified; opening it never transfers this project. Copy above, then paste or import manually in Scenering. Nothing is uploaded or published.";
    projectShelf.appendChild(manualHandoff);

    const copyFallback = document.createElement("textarea");
    copyFallback.className = "studio-copy-fallback";
    copyFallback.setAttribute("aria-label", "Text to copy manually");
    copyFallback.hidden = true;
    projectShelf.appendChild(copyFallback);

    const projectResearchSummary = document.createElement("p");
    projectResearchSummary.className = "studio-note";
    projectResearchSummary.textContent = "Projects are stored separately from personal memory.";
    projectShelf.appendChild(projectResearchSummary);

    const libHead = document.createElement("div");
    libHead.className = "studio-library-head";
    libraryBox.appendChild(libHead);

    const libTitle = document.createElement("strong");
    libTitle.textContent = "Library";
    libHead.appendChild(libTitle);

    const libSearch = document.createElement("input");
    libSearch.type = "search";
    libSearch.placeholder = "search";
    libSearch.setAttribute("aria-label", "Search the library");
    libSearch.addEventListener("input", () => loadLibrary(libSearch.value));
    libHead.appendChild(libSearch);

    const libGrid = document.createElement("div");
    libGrid.className = "studio-library-grid";
    libraryBox.appendChild(libGrid);

    const readout = document.createElement("div");
    readout.className = "d3-readout studio-readout";
    readout.setAttribute("role", "status");
    readout.setAttribute("aria-live", "polite");
    host.appendChild(readout);

    // ---------- talking to the server ----------
    async function api(path, options = {}) {
      const token = (window.sessionStorage && window.sessionStorage.getItem("jarvis_token")) || "jarvis-live-session-token";
      const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${token}` });
      const resp = await fetch(path, { ...options, headers });
      let data = null;
      try { data = await resp.json(); } catch (_) { /* not JSON */ }
      if (!resp.ok) {
        const detail = (data && (data.error || data.detail)) || `HTTP ${resp.status}`;
        const error = new Error(detail);
        error.status = resp.status;
        throw error;
      }
      return data;
    }

    const post = (path, payload) => api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    const put = (path, payload) => api(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    function actionButton(label, title) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "studio-button";
      button.id = `studio-action-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      button.textContent = label;
      button.title = title;
      return button;
    }

    function clearElement(element) {
      element.textContent = "";
      while (element.children && element.children.length) element.removeChild(element.children[0]);
    }

    function markDirty() {
      state.dirty = true;
      renderProjectMeta();
    }

    function renderProjectMeta() {
      if (!state.project) {
        projectMeta.textContent = `Not saved${state.dirty ? " · Unsaved changes" : ""}`;
        return;
      }
      const changed = new Date(state.project.updatedAt);
      const formatted = Number.isNaN(changed.getTime()) ? state.project.updatedAt : changed.toLocaleString();
      projectMeta.textContent = `${state.project.status === "script-ready" ? "Script ready" : "Brief"} · Last modified ${formatted}`
        + (state.dirty ? " · Unsaved changes" : "");
    }

    function collectProject() {
      const title = titleInput.value.trim() || (state.script && state.script.title) || briefInput.value.trim() || "Untitled video project";
      const script = state.script ? {
        ...state.script,
        title,
        music_suggestion: musicInput.value,
        sound_effects: soundInput.value,
      } : null;
      return {
        title,
        topic: briefInput.value.trim(),
        audience: audienceInput.value.trim(),
        format: aspect.value,
        durationSeconds: Number(secInput.value) || 30,
        narrationNotes: narrationNotesInput.value,
        musicSuggestion: musicInput.value,
        soundEffectSuggestions: soundInput.value,
        sourceScript: sourceScriptInput.value,
        script,
        research: state.research,
      };
    }

    async function saveProject(options = {}) {
      if (state.saving) return null;
      const payload = collectProject();
      if (!payload.topic && !payload.script && !payload.research) {
        say("Add a topic, script, or selected Research report before saving a project.");
        return null;
      }
      state.saving = true;
      try {
        const createNew = Boolean(options.newProject);
        const saved = state.project && !createNew
          ? await put(`/api/studio/projects/${encodeURIComponent(state.project.id)}`, payload)
          : await post("/api/studio/projects", payload);
        state.project = saved.project;
        state.dirty = false;
        renderProjectMeta();
        await loadProjects(projectSearch.value);
        if (!options.silent) say(`Saved “${state.project.title}” locally in Video projects. It is separate from personal memory and has not been sent to Scenering.`);
        return state.project;
      } catch (error) {
        say(`Could not save the project: ${error.message}. Your current editor draft is still visible; it was not reported as saved.`);
        return null;
      } finally {
        state.saving = false;
      }
    }

    function renderResearchCard() {
      clearElement(researchCard);
      if (!state.research) {
        const empty = document.createElement("p");
        empty.className = "studio-empty";
        empty.textContent = "No report attached. Choose one above if you want source-based claims in this project.";
        researchCard.appendChild(empty);
        projectResearchSummary.textContent = "Projects are stored separately from personal memory.";
        return;
      }
      const report = state.research;
      const heading = document.createElement("strong");
      heading.textContent = `Source-based report notes: ${report.title}`;
      researchCard.appendChild(heading);
      const question = document.createElement("p");
      question.textContent = `Research question: ${report.question}`;
      researchCard.appendChild(question);
      const body = document.createElement("p");
      body.className = "studio-research-report";
      body.textContent = report.report;
      researchCard.appendChild(body);
      const list = document.createElement("ol");
      for (const source of report.sources || []) {
        const item = document.createElement("li");
        const anchor = document.createElement("a");
        anchor.href = source.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = `[${source.id}] ${source.title} — ${source.publisher}`;
        item.appendChild(anchor);
        const status = document.createElement("span");
        status.textContent = ` · ${source.fetchStatus}; grounding checked ${source.searchCheckedAt}${source.accessedAt ? `; page access attempted ${source.accessedAt}` : "; page not opened"}`;
        item.appendChild(status);
        if (source.excerpt || source.searchExcerpt) {
          const excerpt = document.createElement("p");
          excerpt.textContent = source.excerpt || source.searchExcerpt;
          item.appendChild(excerpt);
        }
        list.appendChild(item);
      }
      researchCard.appendChild(list);
      const note = document.createElement("p");
      note.className = "studio-note";
      note.textContent = "The report and citations are source-based context; music, sound and visual treatments remain creative suggestions. Review claims before publishing.";
      researchCard.appendChild(note);
      projectResearchSummary.textContent = `${report.sources.length} linked research source${report.sources.length === 1 ? "" : "s"} attached to this project.`;
    }

    async function loadResearchReports() {
      try {
        const data = await api("/api/studio/research-reports");
        clearElement(researchSelect);
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = data.reports.length ? "Choose a saved report…" : "No saved reports found";
        researchSelect.appendChild(placeholder);
        for (const report of data.reports) {
          const option = document.createElement("option");
          option.value = report.id;
          option.textContent = `${report.title} · ${report.sourceCount} sources · ${new Date(report.updatedAt).toLocaleDateString()}`;
          researchSelect.appendChild(option);
        }
        if (state.research) researchSelect.value = state.research.reportId;
      } catch (error) {
        clearElement(researchSelect);
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Saved Research is unavailable";
        researchSelect.appendChild(option);
        say(`Could not list saved Research reports: ${error.message}`);
      }
    }

    async function attachSelectedResearch() {
      const id = researchSelect.value;
      if (!id) { say("Choose a saved Research report first. Nothing was attached."); return; }
      try {
        const data = await api(`/api/studio/research-reports/${encodeURIComponent(id)}`);
        state.research = data.report;
        renderResearchCard();
        markDirty();
        say(`Attached “${state.research.title}” with ${state.research.sources.length} source links. This is still a draft until you save the video project.`);
      } catch (error) {
        say(`Could not attach that Research report: ${error.message}. No research was added.`);
      }
    }

    async function loadProjects(search = "") {
      const seq = ++state.projectSearchSeq;
      try {
        const data = await api(`/api/studio/projects${search ? `?q=${encodeURIComponent(search)}` : ""}`);
        if (seq !== state.projectSearchSeq) return;
        clearElement(projectList);
        if (data.warning) say(data.warning);
        if (!data.projects.length) {
          const empty = document.createElement("p");
          empty.className = "studio-empty";
          empty.textContent = data.warning || (search ? "No matching saved projects." : "No saved video projects yet.");
          projectList.appendChild(empty);
          return;
        }
        for (const project of data.projects) {
          const row = document.createElement("article");
          row.className = "studio-project-row";
          const open = actionButton(project.title, `Open ${project.title}`);
          open.className = "studio-project-open";
          open.addEventListener("click", () => openProject(project.id));
          row.appendChild(open);
          const meta = document.createElement("p");
          const modified = new Date(project.updatedAt);
          meta.textContent = `${project.topic || "No topic"} · ${project.format} · ${project.durationSeconds}s · ${project.status} · ${Number.isNaN(modified.getTime()) ? project.updatedAt : modified.toLocaleString()}`;
          row.appendChild(meta);
          if (project.sourceCount) {
            const sourceCount = document.createElement("span");
            sourceCount.className = "studio-note";
            sourceCount.textContent = `${project.sourceCount} research source${project.sourceCount === 1 ? "" : "s"}`;
            row.appendChild(sourceCount);
          }
          projectList.appendChild(row);
        }
      } catch (error) {
        if (seq !== state.projectSearchSeq) return;
        clearElement(projectList);
        const failed = document.createElement("p");
        failed.className = "studio-empty";
        failed.textContent = `Saved projects could not be loaded: ${error.message}`;
        projectList.appendChild(failed);
      }
    }

    async function openProject(id) {
      if (state.dirty && !window.confirm("Discard unsaved changes and open the saved video project?")) return;
      try {
        const data = await api(`/api/studio/projects/${encodeURIComponent(id)}`);
        const project = data.project;
        state.project = project;
        state.brief = project.topic;
        briefInput.value = project.topic;
        audienceInput.value = project.audience;
        state.seconds = project.durationSeconds;
        secInput.value = String(project.durationSeconds);
        state.aspect = project.format;
        aspect.value = project.format;
        narrationNotesInput.value = project.narrationNotes;
        musicInput.value = project.musicSuggestion || (project.script && project.script.music_suggestion) || "";
        soundInput.value = project.soundEffectSuggestions || (project.script && project.script.sound_effects) || "";
        sourceScriptInput.value = project.sourceScript || "";
        state.script = project.script;
        state.research = project.research;
        titleInput.value = project.title;
        state.dirty = false;
        await loadResearchReports();
        renderResearchCard();
        renderTitle();
        renderProjectMeta();
        say(`Opened “${project.title}” from local Video projects. It remains separate from personal memory and Scenering.`);
      } catch (error) {
        say(`Could not reopen this project: ${error.message}`);
      }
    }

    function clearWorkspace() {
      state.project = null;
      state.research = null;
      state.script = null;
      state.brief = "";
      state.seconds = 30;
      state.aspect = "16:9";
      state.dirty = false;
      briefInput.value = "";
      audienceInput.value = "";
      secInput.value = "30";
      aspect.value = "16:9";
      narrationNotesInput.value = "";
      sourceScriptInput.value = "";
      musicInput.value = "";
      soundInput.value = "";
      titleInput.value = "";
      researchSelect.value = "";
      renderResearchCard();
      renderTitle();
      renderProjectMeta();
    }

    async function newProject() {
      if (state.dirty && !window.confirm("Discard unsaved changes and start a new project?")) return;
      clearWorkspace();
      say("New unsaved video project. Add a topic or script, then save it. No personal memory was changed.");
    }

    async function duplicateProject() {
      if (!state.project) { say("Open a saved project first, then Duplicate it."); return; }
      if (state.dirty && !await saveProject({ silent: true })) return;
      try {
        const data = await post(`/api/studio/projects/${encodeURIComponent(state.project.id)}/duplicate`, {});
        await openProject(data.project.id);
        say(`Duplicated as “${data.project.title}”. The copy has a new stable ID and remains a local draft.`);
        await loadProjects(projectSearch.value);
      } catch (error) {
        say(`Could not duplicate the project: ${error.message}. The original was not changed.`);
      }
    }

    async function renameProject(requestedTitle = "") {
      if (!state.project) { say("Open a saved project first, then Rename it."); return; }
      if (state.dirty && !await saveProject({ silent: true })) return;
      const title = requestedTitle || window.prompt("New video project title", state.project.title);
      if (title == null || !String(title).trim()) return;
      try {
        const data = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: String(title).trim() }),
        });
        state.project = data.project;
        titleInput.value = data.project.title;
        if (state.script) state.script.title = data.project.title;
        state.dirty = false;
        renderTitle();
        renderProjectMeta();
        await loadProjects(projectSearch.value);
        say(`Renamed the saved project to “${data.project.title}”.`);
      } catch (error) {
        say(`Could not rename the project: ${error.message}. The saved title is unchanged.`);
      }
    }

    async function deleteProject() {
      if (!state.project) { say("Open a saved project first, then Delete it."); return; }
      const unsavedWarning = state.dirty ? " Unsaved edits to this project will also be discarded." : "";
      if (!window.confirm(`Delete “${state.project.title}” from local Video projects? This cannot be undone.${unsavedWarning}`)) return;
      try {
        await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}`, { method: "DELETE" });
        clearWorkspace();
        await loadProjects(projectSearch.value);
        say("Video project deleted locally. Personal memory and Research reports were not changed.");
      } catch (error) {
        say(`Could not delete the project: ${error.message}. It may still be saved.`);
      }
    }

    async function copyProjectText(format) {
      if (format === "script" && !state.script) { say("There is no script to copy. Write or break one into scenes first."); return; }
      const project = await saveProject({ silent: true });
      if (!project) return;
      try {
        const data = await api(`/api/studio/projects/${encodeURIComponent(project.id)}/text?format=${encodeURIComponent(format)}`);
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("Clipboard access is unavailable");
          await navigator.clipboard.writeText(data.text);
          copyFallback.hidden = true;
          say(`${format === "script" ? "Script" : format === "scenes" ? "Scene breakdown" : "Project details"} copied. Paste it manually into Scenering if that is where you want to work. Nothing was sent.`);
        } catch (_) {
          copyFallback.value = data.text;
          copyFallback.hidden = false;
          copyFallback.focus();
          copyFallback.select();
          say("Clipboard access failed. The text is shown below; select and copy it, then paste it manually. Nothing was sent.");
        }
      } catch (error) {
        say(`Could not prepare copy text: ${error.message}. The project remains saved locally; nothing was sent.`);
      }
    }

    function openScenering() {
      window.open("https://scenering.com", "_blank", "noopener,noreferrer");
      say("Scenering was opened in a separate tab (or the browser blocked it). No project was transferred. Copy the script or scenes here, then paste/import manually in Scenering.");
    }

    // ---------- the shot cards ----------
    function renderShots() {
      shots.textContent = "";
      if (!state.script) {
        const p = document.createElement("p");
        p.className = "studio-empty";
        p.textContent = "Say what the video is about, then press “Jarvis, write it”.";
        shots.appendChild(p);
        return;
      }

      state.script.shots.forEach((shot, i) => {
        const card = document.createElement("article");
        card.className = "studio-shot";
        if (shot.image) card.classList.add("has-image");

        const head = document.createElement("div");
        head.className = "studio-shot-head";
        card.appendChild(head);

        const num = document.createElement("span");
        num.className = "studio-shot-num";
        num.textContent = String(i + 1);
        head.appendChild(num);

        const secs = document.createElement("input");
        secs.type = "number";
        secs.className = "studio-shot-secs";
        secs.min = "1";
        secs.max = "60";
        secs.value = String(shot.seconds);
        secs.title = "seconds on screen";
        secs.setAttribute("aria-label", `Shot ${i + 1} seconds`);
        secs.addEventListener("input", () => {
          shot.seconds = Math.max(1, Math.min(60, Number(secs.value) || 4));
          markDirty();
        });
        head.appendChild(secs);

        const pic = document.createElement("button");
        pic.type = "button";
        pic.textContent = shot.image ? "New picture" : "Make picture";
        pic.title = "Generate a picture for this shot";
        pic.addEventListener("click", () => makePicture(i));
        head.appendChild(pic);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "studio-shot-del";
        del.textContent = "×";
        del.title = `Remove shot ${i + 1}`;
        del.disabled = state.script.shots.length < 2;
        del.addEventListener("click", () => {
          state.script.shots.splice(i, 1);
          markDirty();
          renderShots();
        });
        head.appendChild(del);

        const caption = document.createElement("input");
        caption.type = "text";
        caption.className = "studio-shot-caption";
        caption.value = shot.on_screen || "";
        caption.placeholder = "caption burned into the picture";
        caption.setAttribute("aria-label", `Shot ${i + 1} caption`);
        caption.addEventListener("input", () => { shot.on_screen = caption.value; markDirty(); });
        card.appendChild(caption);

        const narration = document.createElement("textarea");
        narration.className = "studio-shot-narration";
        narration.rows = 2;
        narration.value = shot.narration;
        narration.setAttribute("aria-label", `Shot ${i + 1} narration`);
        narration.addEventListener("input", () => { shot.narration = narration.value; markDirty(); });
        card.appendChild(narration);

        const prompt = document.createElement("input");
        prompt.type = "text";
        prompt.className = "studio-shot-prompt";
        prompt.value = shot.image_prompt || "";
        prompt.placeholder = "what the picture should show";
        prompt.setAttribute("aria-label", `Shot ${i + 1} picture prompt`);
        prompt.addEventListener("input", () => { shot.image_prompt = prompt.value; markDirty(); });
        card.appendChild(prompt);

        if (Array.isArray(shot.citations) && shot.citations.length) {
          const citations = document.createElement("p");
          citations.className = "studio-citations";
          citations.textContent = `Source-based citations: ${shot.citations.map((id) => `[${id}]`).join(" ")}`;
          card.appendChild(citations);
        }

        if (shot.image) {
          const img = document.createElement("img");
          img.className = "studio-shot-img";
          img.src = shot.image.url;
          img.alt = shot.image_prompt || `picture for shot ${i + 1}`;
          card.appendChild(img);
        }

        shots.appendChild(card);
      });

      const total = state.script.shots.reduce((n, s) => n + (Number(s.seconds) || 0), 0);
      const sum = document.createElement("p");
      sum.className = "studio-total";
      sum.textContent = `${state.script.shots.length} shots · ${total}s on screen`;
      shots.appendChild(sum);
    }

    function renderTitle() {
      const s = state.script;
      titleInput.value = s ? s.title : (state.project ? state.project.title : "");
      musicInput.value = s ? (s.music_suggestion || "") : (state.project ? state.project.musicSuggestion || "" : "");
      soundInput.value = s ? (s.sound_effects || "") : (state.project ? state.project.soundEffectSuggestions || "" : "");
      variants.textContent = "";
      if (s && s.title_variants && s.title_variants.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "other titles…";
        variants.appendChild(o);
        for (const t of s.title_variants) {
          const opt = document.createElement("option");
          opt.value = t;
          opt.textContent = t;
          variants.appendChild(opt);
        }
        variants.hidden = false;
      } else {
        variants.hidden = true;
      }
      renderShots();
      renderProjectMeta();
    }

    // ---------- Jarvis writes it ----------
    async function writeScript() {
      if (state.busy) return;
      const topic = briefInput.value.trim();
      if (!topic) { say("Tell Jarvis the video topic first. The project has not been generated or saved."); return; }
      state.busy = true;
      state.brief = topic;
      say(state.research ? "Jarvis is preparing a draft using the selected saved Research report…" : "Jarvis is writing a first-draft script…");
      try {
        const request = {
          topic,
          audience: audienceInput.value.trim(),
          format: aspect.value,
          durationSeconds: Math.max(5, Math.min(600, Number(secInput.value) || 30)),
          narrationNotes: narrationNotesInput.value.trim(),
          mode: "write",
          sourceScript: "",
          researchReportId: state.research ? state.research.reportId : "",
        };
        let data;
        try {
          data = await post("/api/studio/scripts", request);
        } catch (error) {
          if (error.status !== 404 || request.researchReportId) throw error;
          data = { script: await post("/api/media/script", { brief: topic, seconds: request.durationSeconds, aspect: request.format }) };
        }
        state.script = data.script;
        if (data.research !== undefined) state.research = data.research;
        markDirty();
        renderTitle();
        renderResearchCard();
        say(`Draft ready: ${state.script.shots.length} scenes, about ${state.script.seconds}s. Review factual claims${state.research ? " against the linked report and sources" : " before use"}; nothing has been sent to Scenering. Save the project when ready.`);
      } catch (error) {
        say(`Could not write the script: ${error.message}. No new project was reported as saved.`);
      } finally {
        state.busy = false;
      }
    }

    async function breakIntoScenes(sourceOverride = "") {
      if (state.busy) return;
      const sourceScript = String(sourceOverride || sourceScriptInput.value || (state.script && state.script.shots.map((shot) => shot.narration).join("\\n")) || "").trim();
      if (sourceScript.length < 20) { say("Paste at least 20 characters of script into the scene-breakdown box first. Nothing was generated or saved."); return; }
      state.busy = true;
      say("Jarvis is organising the supplied script into editable scenes…");
      try {
        const request = {
          topic: briefInput.value.trim(),
          audience: audienceInput.value.trim(),
          format: aspect.value,
          durationSeconds: Math.max(5, Math.min(600, Number(secInput.value) || 30)),
          narrationNotes: narrationNotesInput.value.trim(),
          mode: "breakdown",
          sourceScript,
          researchReportId: state.research ? state.research.reportId : "",
        };
        const data = await post("/api/studio/scripts", request);
        state.script = data.script;
        if (data.research !== undefined) state.research = data.research;
        markDirty();
        renderTitle();
        renderResearchCard();
        say(`Draft breakdown ready with ${state.script.shots.length} scenes. Review it before saving. The source text was treated as untrusted data; no code was run.`);
      } catch (error) {
        say(`Could not break the script into scenes: ${error.message}. Your pasted source remains in the editor.`);
      } finally {
        state.busy = false;
      }
    }

    // ---------- a picture for one shot ----------
    async function makePicture(index) {
      const shot = state.script && state.script.shots[index];
      if (!shot) return;
      if (state.busy) return;
      state.busy = true;
      say(`Making the picture for shot ${index + 1}. The free service allows about one every 15 seconds…`);
      try {
        const item = await post("/api/media/image", {
          prompt: shot.image_prompt || shot.narration,
          aspect: state.aspect,
          model: state.model,
          name: `${state.script.title} — shot ${index + 1}`,
        });
        shot.image = item;
        markDirty();
        renderShots();
        loadLibrary();
        say(`Shot ${index + 1} has its picture.`);
      } catch (e) {
        say(`Could not make that picture: ${e.message}`);
      } finally {
        state.busy = false;
      }
    }

    // ---------- the library ----------
    async function loadLibrary(search = "") {
      try {
        const data = await api(`/api/media/library${search ? `?q=${encodeURIComponent(search)}` : ""}`);
        libGrid.textContent = "";
        if (!data.items.length) {
          const p = document.createElement("p");
          p.className = "studio-empty";
          p.textContent = "Nothing made yet.";
          libGrid.appendChild(p);
          return;
        }
        for (const item of data.items) {
          const cell = document.createElement("div");
          cell.className = "studio-cell";

          if (item.kind === "images") {
            const img = document.createElement("img");
            img.src = item.url;
            img.alt = item.name;
            img.loading = "lazy";
            cell.appendChild(img);
          } else {
            const tag = document.createElement("span");
            tag.className = "studio-cell-kind";
            tag.textContent = item.kind;
            cell.appendChild(tag);
          }

          const name = document.createElement("input");
          name.type = "text";
          name.className = "studio-cell-name";
          name.value = item.name;
          name.setAttribute("aria-label", "Name");
          name.addEventListener("change", async () => {
            await api(`/api/media/file/${item.kind}/${encodeURIComponent(item.id)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: name.value }),
            });
            say("Renamed.");
          });
          cell.appendChild(name);

          const del = document.createElement("button");
          del.type = "button";
          del.className = "studio-cell-del";
          del.textContent = "Delete";
          del.addEventListener("click", async () => {
            await api(`/api/media/file/${item.kind}/${encodeURIComponent(item.id)}`,
              { method: "DELETE" });
            loadLibrary(libSearch.value);
            say("Deleted.");
          });
          cell.appendChild(del);

          libGrid.appendChild(cell);
        }
      } catch (e) {
        say(`Could not read the library: ${e.message}`);
      }
    }

    // ---------- compiling the video ----------
    // The browser can record a canvas. That means a real video file with no
    // ffmpeg and no upload: the shot list is played through a canvas and
    // MediaRecorder captures it. The result is a WebM with the pictures and the
    // captions, and no sound.
    const MIME = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));

    async function compile() {
      const s = state.script;
      if (!s) { say("Write a script first."); return; }
      const withPicture = s.shots.filter((shot) => shot.image);
      if (!withPicture.length) { say("Make at least one picture first."); return; }
      if (!MIME) { say("This browser cannot record video. Try Chrome or Edge."); return; }
      if (state.compiling) return;

      state.compiling = true;
      say("Compiling. Keep this window in front — it records in real time.");

      // The sizes come from the server, so the canvas can never disagree with it.
      const sizes = (options && options.aspects) || {};
      const [w, h] = sizes[s.aspect] || [720, 1280];
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");

      // Load every picture before recording, so nothing pops in late.
      const images = new Map();
      await Promise.all(s.shots.map(async (shot) => {
        if (!shot.image) return;
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((res) => {
          img.onload = res;
          img.onerror = res;
          img.src = shot.image.url;
        });
        if (img.width) images.set(shot, img);
      }));

      const drawShot = (shot) => {
        ctx.fillStyle = "#05080f";
        ctx.fillRect(0, 0, w, h);
        const img = images.get(shot);
        if (img) {
          const scale = Math.max(w / img.width, h / img.height);
          const dw = img.width * scale, dh = img.height * scale;
          ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        }
        if (shot.on_screen) {
          const size = Math.round(w / 14);
          ctx.font = `700 ${size}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const y = h - size * 1.6;
          ctx.lineWidth = size / 8;
          ctx.strokeStyle = "rgba(0,0,0,0.75)";
          ctx.strokeText(shot.on_screen, w / 2, y);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(shot.on_screen, w / 2, y);
        }
      };

      const stream = canvas.captureStream(30);
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 4_000_000 });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const done = new Promise((res) => { rec.onstop = res; });
      rec.start();

      for (const shot of s.shots) {
        if (!images.has(shot)) continue;
        drawShot(shot);
        await new Promise((res) => setTimeout(res, (Number(shot.seconds) || 4) * 1000));
      }

      rec.stop();
      await done;
      state.compiling = false;

      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);

      // Offer it to keep, so it lands in the library with everything else.
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(s.title || "video").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}.webm`;
      a.textContent = `Download ${a.download}`;
      a.className = "studio-download";
      host.appendChild(a);

      // And save a copy into the library.
      try {
        const reader = new FileReader();
        const base64 = await new Promise((res) => {
          reader.onload = () => res(String(reader.result));
          reader.readAsDataURL(blob);
        });
        await post("/api/media/save", {
          kind: "video", ext: "webm", data: base64,
          name: s.title || "compiled video", prompt: s.logline || "",
        });
        loadLibrary();
        say("Compiled and kept in the library. The download link is below.");
      } catch (e) {
        say(`Compiled, but I could not keep a copy: ${e.message}`);
      }
    }

    newProjectButton.addEventListener("click", newProject);
    saveProjectButton.addEventListener("click", () => saveProject());
    duplicateProjectButton.addEventListener("click", duplicateProject);
    renameProjectButton.addEventListener("click", () => renameProject());
    deleteProjectButton.addEventListener("click", deleteProject);
    copyScriptButton.addEventListener("click", () => copyProjectText("script"));
    copyScenesButton.addEventListener("click", () => copyProjectText("scenes"));
    copyProjectButton.addEventListener("click", () => copyProjectText("project"));
    openSceneringButton.addEventListener("click", openScenering);
    attachResearchButton.addEventListener("click", attachSelectedResearch);

    window.addEventListener("message", (event) => {
      if (event.origin && location.origin && event.origin !== location.origin) return;
      if (event.source && window.parent && event.source !== window.parent) return;
      const message = event.data || {};
      if (message.type !== "studio_control" || !message.command || typeof message.command.action !== "string") return;
      const command = message.command;
      if (command.action === "open-project") {
        if (typeof command.projectId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.projectId)) openProject(command.projectId);
        else say("Jarvis sent an invalid project identifier; no project was opened.");
      } else if (command.action === "open-scenering") openScenering();
      else if (command.action === "copy-script") copyProjectText("script");
      else if (command.action === "copy-scenes") copyProjectText("scenes");
      else if (command.action === "copy-project") copyProjectText("project");
      else if (command.action === "save-new") {
        if (state.project) duplicateProject();
        else saveProject({ newProject: true });
      } else if (command.action === "save-current") {
        saveProject({ newProject: !state.project });
      } else if (command.action === "duplicate-current") duplicateProject();
      else if (command.action === "rename-current") renameProject(typeof command.title === "string" ? command.title : "");
      else if (command.action === "delete-current") deleteProject();
      else if (command.action === "search-projects") {
        projectSearch.value = typeof command.query === "string" ? command.query.slice(0, 200) : "";
        loadProjects(projectSearch.value);
        say(`Showing saved video projects matching “${projectSearch.value}”. Choose a result to reopen it.`);
      } else if (command.action === "breakdown") {
        const source = typeof command.sourceScript === "string" ? command.sourceScript.slice(0, 12000) : "";
        if (source) sourceScriptInput.value = source;
        breakIntoScenes(source);
      } else if (command.action === "open-studio") {
        say("Studio is open. Tell me the topic to prepare, then save the local video project when ready.");
      }
    });

    // ---------- the tool strip ----------
    const strip = env._tools;
    if (strip) {
      const tool = (id, name, hint, run) => {
        const b = document.createElement("button");
        b.type = "button";
        b.id = `tool-studio-${id}`;
        b.className = "env-tool";
        b.textContent = name;
        b.title = hint;
        b.setAttribute("role", "tab");
        b.addEventListener("click", run);
        strip.appendChild(b);
        return b;
      };

      tool("write", "Jarvis, write it", "Write a draft script using the brief and any selected saved Research report", writeScript);
      tool("breakdown", "Break into scenes", "Organise pasted source text into editable scenes", () => breakIntoScenes());
      tool("save", "Save project", "Save or update this local video project", () => saveProject());
      tool("pictures", "All pictures", "Make a picture for every shot that does not have one yet", async () => {
        if (!state.script) { say("Write a script first."); return; }
        for (let i = 0; i < state.script.shots.length; i++) {
          if (!state.script.shots[i].image) await makePicture(i);
        }
      });
      tool("compile", "Compile video", "Play the shot list through a canvas and record it", compile);
      tool("scenering", "Copy for Scenering", "Copy script text for manual paste; nothing is transferred", () => copyProjectText("script"));
      tool("open", "Open Scenering", "Open scenering.com separately; nothing is transferred", openScenering);
      tool("refresh", "Refresh library", "Read the library again", () => loadLibrary(libSearch.value));
    }

    // ---------- start ----------
    renderTitle();
    renderResearchCard();
    renderProjectMeta();
    loadLibrary();
    loadProjects();
    loadResearchReports();

    // Ask what the server can do. The primary dashboard owns script generation
    // and project storage; legacy media options are retained for the picture,
    // library and compile controls.
    let options = null;
    let studioStatus = null;
    try { studioStatus = await api("/api/studio/status"); } catch (_) { /* project API may be unavailable */ }
    try { options = await api("/api/media/options"); } catch (_) { /* legacy media routes may be unavailable */ }
    if (studioStatus && studioStatus.scriptReady === false) {
      say("Jarvis needs the configured Gemini key and daily budget to write scripts. Saved local projects, manual copy, and the separate Scenering tab do not depend on an import API.");
    } else if (options && options.script_ready === false) {
      say("Script generation is not ready on this server. You can still edit a saved project and use copy/manual handoff.");
    } else {
      say("Tell Jarvis the topic, then write or break a script into scenes. Save the project when ready; Scenering handoff is manual.");
    }
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage({ type: "studio_ready" }, location.origin);
    } catch (_) { /* the Studio remains usable if a browser blocks parent messaging */ }

    return {
      pause() {},
      resume() { loadLibrary(libSearch.value); },
    };
  },
};
