/* Super AI Agent — the environment shell.
 *
 * The app is a windowing environment, not a page of tabs. Each "environment"
 * is a full-screen workspace with its own job (code, design, files). You slide
 * between them left and right, and each one carries its own compact tool tabs
 * at the top so the rest of the window stays free for the thing you are moving.
 *
 * Three rules keep it fast, because a laggy tool is a tool nobody uses:
 *
 *   1. One environment is live at a time. The others are removed from layout
 *      and paint entirely (`content-visibility`), so a heavy 3D world costs
 *      nothing while you are coding.
 *   2. An environment's code is fetched the first time you open it, never
 *      before. Opening Design is what downloads the 3D engine.
 *   3. Sliding is a single CSS transform on a compositor layer. Nothing here
 *      reads layout during a slide, so it cannot stutter.
 *
 * Plain JavaScript, no build step. All text from files is written with
 * textContent, never innerHTML.
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);

  const rail = $("#env-rail");
  const track = $("#env-track");
  const prevBtn = $("#env-prev");
  const nextBtn = $("#env-next");
  const label = $("#env-label");

  /** Environments register themselves here. Order is the slide order. */
  const registry = [];
  const loaded = new Map();   // id -> the module's default export
  let current = -1;           // index into registry
  let sliding = false;

  // ---------- registering an environment ----------

  /**
   * @param {object} env
   * @param {string} env.id        stable id, also the module filename
   * @param {string} env.name      shown on the tool tab and the label
   * @param {string} env.hint      one line on what the environment is for
   * @param {Array}  [env.tools]   compact tool tabs: {id, name, run, hint}
   *
   * `mount` is not needed here: it arrives with the environment's own module
   * the first time you open it.
   */
  function register(env) {
    if (!env || !env.id || !env.name) {
      throw new Error("an environment needs at least an id and a name");
    }
    if (registry.some((e) => e.id === env.id)) return env;
    registry.push(env);
    buildSlide(env);
    buildTab(env);
    // The first environment to arrive sets the starting frame; later ones just
    // bring the arrows and the inert flags back in step. Neither loads code.
    if (registry.length === 1) slideTo(0);
    else syncSlides();
    return env;
  }

  // ---------- building the DOM ----------

  function buildSlide(env) {
    const slide = document.createElement("section");
    slide.className = "env-slide";
    slide.id = `env-${env.id}`;
    slide.dataset.env = env.id;
    slide.setAttribute("role", "region");
    slide.setAttribute("aria-label", env.name);

    // The tool tab strip lives at the top of the window, inside it, so it never
    // steals room from the content the way a sidebar would.
    const tabs = document.createElement("div");
    tabs.className = "env-tools";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", `${env.name} tools`);

    const name = document.createElement("span");
    name.className = "env-tools-name";
    name.textContent = env.name;
    tabs.appendChild(name);

    if (env.tools && env.tools.length) {
      for (const tool of env.tools) {
        // A tool that carries its own control (a slider, say) becomes a plain
        // slot, not a button: a slider inside a button is invalid and swallows
        // its own drags.
        const isSlot = Boolean(tool.control);
        const b = document.createElement(isSlot ? "span" : "button");
        if (!isSlot) b.type = "button";
        b.className = `env-tool${isSlot ? " env-tool-control" : ""}`;
        b.id = `tool-${env.id}-${tool.id}`;
        b.title = tool.hint || tool.name;
        b.textContent = tool.name;
        if (!isSlot) {
          b.setAttribute("role", "tab");
          b.addEventListener("click", () => {
            setActiveTool(env.id, tool.id);
            // An environment wires its own tools when it mounts, so `run` is
            // optional here.
            if (typeof tool.run === "function") tool.run(slide);
          });
        }
        tabs.appendChild(b);
      }
    }

    const body = document.createElement("div");
    body.className = "env-body";

    slide.appendChild(tabs);
    slide.appendChild(body);
    track.appendChild(slide);

    env._slide = slide;
    env._body = body;
    // The tool strip, so an environment can add its own controls the first time
    // it mounts (a colour picker, a brush size, a layer list). Without this an
    // environment would have to declare every control up front.
    env._tools = tabs;
    env._activeTool = null;
  }

  function buildTab(env) {
    // The top-level environment switcher lives in the top bar.
    const strip = $("#env-switcher");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "env-switch";
    b.dataset.env = env.id;
    b.textContent = env.name;
    b.title = env.hint || env.name;
    b.addEventListener("click", () => open(env.id));
    strip.appendChild(b);
  }

  // ---------- opening and sliding ----------

  /** How an environment's code is fetched. Tests swap this out. */
  let loadModule = (id) => import(`./environments/${id}.js`);

  async function open(id) {
    const index = registry.findIndex((e) => e.id === id);
    if (index < 0) return;
    // Already on screen and already loaded: nothing to do.
    if (index === current && loaded.has(id)) return;

    const env = registry[index];
    const first = !loaded.has(env.id);

    // Show the shell straight away so the slide never waits on the network.
    document.body.dataset.env = env.id;
    slideTo(index);
    markTab(env.id);

    if (first) {
      env._body.setAttribute("aria-busy", "true");
      try {
        // One request, only ever once per environment.
        const mod = await loadModule(env.id);
        loaded.set(env.id, mod.default || mod);
        env._body.removeAttribute("aria-busy");
        await loaded.get(env.id).mount(env._body, env);
      } catch (err) {
        env._body.removeAttribute("aria-busy");
        showError(env._body, `Could not start ${env.name}: ${err.message}`);
        return;
      }
    }

    // An environment that was opened before is told it is visible again, so it
    // can restart its render loop only while it is actually on screen.
    const live = loaded.get(env.id);
    if (live && typeof live.resume === "function") live.resume();
  }

  function slideTo(index) {
    current = index;
    // A single compositor transform. No layout reads here.
    track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
    label.textContent = registry[index].name;
    syncSlides();
  }

  /**
   * Put the arrows, the live slide and the inert flags in step with however
   * many environments exist right now. Called on every slide and again each
   * time an environment is added, so an arrow is never left in the wrong state.
   */
  function syncSlides() {
    prevBtn.disabled = current <= 0;
    nextBtn.disabled = current >= registry.length - 1;

    registry.forEach((e, i) => {
      const on = i === current;
      e._slide.classList.toggle("is-live", on);
      e._slide.setAttribute("aria-hidden", on ? "false" : "true");
      // Everything that is not on screen stops costing layout or paint, and
      // cannot be reached by the keyboard or a stray click.
      e._slide.inert = !on;
      if (!on) {
        const live = loaded.get(e.id);
        if (live && typeof live.pause === "function") live.pause();
      }
    });
  }

  function step(delta) {
    const next = Math.min(registry.length - 1, Math.max(0, current + delta));
    if (next !== current) open(registry[next].id);
  }

  function markTab(id) {
    for (const b of document.querySelectorAll(".env-switch")) {
      const on = b.dataset.env === id;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function setActiveTool(envId, toolId) {
    const env = registry.find((e) => e.id === envId);
    if (!env) return;
    env._activeTool = toolId;
    for (const b of env._slide.querySelectorAll(".env-tool")) {
      b.setAttribute("aria-selected", b.id === `tool-${envId}-${toolId}` ? "true" : "false");
    }
  }

  function showError(body, message) {
    body.textContent = "";
    const p = document.createElement("p");
    p.className = "env-error";
    p.textContent = message;
    body.appendChild(p);
  }

  // ---------- wiring the shell's own controls ----------

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));

  // Left and right arrows slide between environments, the way a desktop
  // switches workspaces. Typing in a box never triggers it.
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
    else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < registry.length) open(registry[i].id);
    }
  });

  // Touch: a horizontal drag on the rail slides between environments.
  let touchStartX = null;
  rail.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    touchStartX = e.clientX;
  });
  window.addEventListener("pointerup", (e) => {
    if (touchStartX === null) return;
    const dx = e.clientX - touchStartX;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    touchStartX = null;
  });

  window.Shell = {
    register, open, step,
    list: () => registry.map((e) => ({ id: e.id, name: e.name })),
    /** Test hook: replace how environment code is fetched. */
    _setLoader: (fn) => { loadModule = fn; },
  };
})();
