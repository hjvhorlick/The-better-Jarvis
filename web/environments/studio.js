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
      aspect: "9:16",
      model: "flux",
      script: null,          // {title, title_variants, hook, shots[], ...}
      busy: false,
      compiling: false,
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
    briefInput.addEventListener("input", () => { state.brief = briefInput.value; });
    briefBox.appendChild(briefInput);

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
      ["9:16", "Shorts / Reels / TikTok"],
      ["16:9", "YouTube, landscape"],
      ["1:1", "feed post"],
      ["4:5", "Instagram portrait"],
    ]) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = `${name} — ${note}`;
      aspect.appendChild(o);
    }
    aspect.addEventListener("change", () => { state.aspect = aspect.value; });
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
        variants.value = "";
      }
    });
    titleLine.appendChild(variants);

    const shots = document.createElement("div");
    shots.className = "studio-shots";
    shots.id = "studio-shots";
    scriptBox.appendChild(shots);

    // ---------- the library ----------
    const libraryBox = document.createElement("aside");
    libraryBox.className = "studio-library";
    libraryBox.setAttribute("aria-label", "Everything you have made");
    host.appendChild(libraryBox);

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
      const resp = await fetch(path, options);
      let data = null;
      try { data = await resp.json(); } catch (_) { /* not JSON */ }
      if (!resp.ok) {
        const detail = (data && data.detail) || `HTTP ${resp.status}`;
        throw new Error(detail);
      }
      return data;
    }

    const post = (path, payload) => api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

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
          renderShots();
        });
        head.appendChild(del);

        const caption = document.createElement("input");
        caption.type = "text";
        caption.className = "studio-shot-caption";
        caption.value = shot.on_screen || "";
        caption.placeholder = "caption burned into the picture";
        caption.setAttribute("aria-label", `Shot ${i + 1} caption`);
        caption.addEventListener("input", () => { shot.on_screen = caption.value; });
        card.appendChild(caption);

        const narration = document.createElement("textarea");
        narration.className = "studio-shot-narration";
        narration.rows = 2;
        narration.value = shot.narration;
        narration.setAttribute("aria-label", `Shot ${i + 1} narration`);
        narration.addEventListener("input", () => { shot.narration = narration.value; });
        card.appendChild(narration);

        const prompt = document.createElement("input");
        prompt.type = "text";
        prompt.className = "studio-shot-prompt";
        prompt.value = shot.image_prompt || "";
        prompt.placeholder = "what the picture should show";
        prompt.setAttribute("aria-label", `Shot ${i + 1} picture prompt`);
        prompt.addEventListener("input", () => { shot.image_prompt = prompt.value; });
        card.appendChild(prompt);

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
      titleInput.value = s ? s.title : "";
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
    }

    // ---------- Jarvis writes it ----------
    async function writeScript() {
      if (state.busy) return;
      if (!state.brief.trim()) { say("Say what the video is about first."); return; }
      state.busy = true;
      say("Jarvis is writing it…");
      try {
        const script = await post("/api/media/script", {
          brief: state.brief,
          seconds: state.seconds,
          aspect: state.aspect,
        });
        state.script = script;
        renderTitle();
        say(`Script ready: ${script.shots.length} shots, about ${script.seconds}s. `
            + `Now make a picture for each shot, or compile what you have.`);
      } catch (e) {
        say(`Could not write it: ${e.message}`);
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

    // ---------- the hand-off to Scenering ----------
    function sceneringText() {
      const s = state.script;
      if (!s) return "";
      const lines = [s.title, ""];
      s.shots.forEach((shot, i) => {
        lines.push(`${i + 1}. ${shot.narration}`);
        if (shot.on_screen) lines.push(`   [on screen: ${shot.on_screen}]`);
        lines.push("");
      });
      return lines.join("\n").trim();
    }

    async function copyForScenering() {
      const text = sceneringText();
      if (!text) { say("Write a script first."); return; }
      try {
        await navigator.clipboard.writeText(text);
        say("Script and title copied. Paste them into Scenering.");
      } catch (_) {
        // Clipboard access can be refused; show the text so it can be copied by hand.
        const box = document.createElement("textarea");
        box.className = "studio-raw";
        box.value = text;
        box.setAttribute("aria-label", "Script, ready to copy");
        host.appendChild(box);
        box.select();
        say("Select the text below and copy it.");
      }
    }

    function openScenering() {
      window.open("https://scenering.com", "_blank", "noopener");
      say("Scenering is open in a new tab. The script is on your clipboard.");
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

      tool("write", "Jarvis, write it", "Write the script, the title and a picture prompt for every shot", writeScript);
      tool("pictures", "All pictures", "Make a picture for every shot that does not have one yet", async () => {
        if (!state.script) { say("Write a script first."); return; }
        for (let i = 0; i < state.script.shots.length; i++) {
          if (!state.script.shots[i].image) await makePicture(i);
        }
      });
      tool("compile", "Compile video", "Play the shot list through a canvas and record it", compile);
      tool("scenering", "Copy for Scenering", "Put the title and script on the clipboard", copyForScenering);
      tool("open", "Open Scenering", "Open scenering.com in a new tab", openScenering);
      tool("refresh", "Refresh library", "Read the library again", () => loadLibrary(libSearch.value));
    }

    // ---------- start ----------
    renderTitle();
    loadLibrary();

    // Ask what the server can do. If Jarvis has no key he cannot write the
    // script, and it is kinder to say so now than when the button is pressed.
    let options = null;
    try {
      options = await api("/api/media/options");
    } catch (_) {
      /* the room still works without it; it only loses the warning */
    }
    if (options && options.script_ready === false) {
      say("Jarvis has no API key, so he cannot write the script yet. "
          + "You can still make pictures and compile by hand.");
    } else {
      say("Say what the video is about, then press “Jarvis, write it”.");
    }

    return {
      pause() {},
      resume() { loadLibrary(libSearch.value); },
    };
  },
};
