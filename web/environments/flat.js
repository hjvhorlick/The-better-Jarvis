/* Flat — the 2D room.
 *
 * For images and video: draw on a canvas, stack layers, bring in a picture or
 * the frames of a video, and edit them with the tools you would expect. It is
 * the flat counterpart to the 3D room next door — same idea, one dimension
 * fewer, and the tools that go with it.
 *
 * Plain JavaScript, no build step, no library. Every tool on the tab strip is
 * wired to something real. My Hands drives it too: the gesture engine already
 * publishes the whole hand on the shared bus, so a pinch draws, a fist pans,
 * two hands scale, and a clap fits the picture to the window.
 */
export default {
  mount(body, env) {
    const host = document.createElement("div");
    host.className = "flat";
    body.appendChild(host);

    // ---------- the picture ----------
    const wrap = document.createElement("div");
    wrap.className = "flat-canvas-wrap";
    host.appendChild(wrap);

    const view = document.createElement("canvas");
    view.className = "flat-canvas";
    view.width = 1280;
    view.height = 720;
    view.setAttribute("role", "img");
    view.setAttribute("aria-label", "The picture you are editing");
    wrap.appendChild(view);

    // The checkerboard shows through wherever nothing has been drawn, so a
    // transparent picture reads as transparent rather than as black.
    const check = document.createElement("div");
    check.className = "flat-check";
    check.setAttribute("aria-hidden", "true");
    wrap.appendChild(check);

    const say = (text) => { readout.textContent = text; };

    const readout = document.createElement("div");
    readout.className = "d3-readout flat-readout";
    readout.setAttribute("role", "status");
    readout.setAttribute("aria-live", "polite");
    host.appendChild(readout);

    // ---------- layers ----------
    // Each layer is its own canvas, painted bottom to top. That is what makes
    // undo cheap and keeps a background photo from being drawn over by mistake.
    const layers = [];
    let active = 0;

    function makeLayer(name, w = view.width, h = view.height) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const layer = { name, canvas: c, ctx: c.getContext("2d"), visible: true, opacity: 1 };
      layers.push(layer);
      return layer;
    }

    makeLayer("Background");

    function layerList() {
      const box = document.createElement("div");
      box.className = "flat-layers";
      // Newest first, the way every editor shows them.
      for (let i = layers.length - 1; i >= 0; i--) {
        const row = document.createElement("div");
        row.className = `flat-layer${i === active ? " is-active" : ""}`;

        const eye = document.createElement("button");
        eye.type = "button";
        eye.className = "flat-eye";
        eye.textContent = layers[i].visible ? "◉" : "◌";
        eye.title = layers[i].visible ? "Hide this layer" : "Show this layer";
        eye.setAttribute("aria-pressed", String(layers[i].visible));
        eye.addEventListener("click", () => {
          layers[i].visible = !layers[i].visible;
          eye.textContent = layers[i].visible ? "◉" : "◌";
          eye.setAttribute("aria-pressed", String(layers[i].visible));
          paint();
        });

        const name = document.createElement("button");
        name.type = "button";
        name.className = "flat-layer-name";
        name.textContent = layers[i].name;
        name.addEventListener("click", () => { active = i; layerList(); paint(); });

        const del = document.createElement("button");
        del.type = "button";
        del.className = "flat-eye";
        del.textContent = "×";
        del.title = `Delete ${layers[i].name}`;
        del.disabled = layers.length < 2;
        del.addEventListener("click", () => {
          layers.splice(i, 1);
          active = Math.max(0, Math.min(active, layers.length - 1));
          layerList();
          paint();
        });

        row.append(eye, name, del);
        box.appendChild(row);
      }
      return box;
    }

    function mountLayers() {
      const old = host.querySelector(".flat-layers");
      if (old) old.remove();
      host.appendChild(layerList());
    }

    // ---------- painting ----------
    function paint() {
      const ctx = view.getContext("2d");
      ctx.clearRect(0, 0, view.width, view.height);
      for (const layer of layers) {
        if (!layer.visible) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, 0, 0);
      }
      ctx.globalAlpha = 1;
    }

    // ---------- undo ----------
    // One snapshot per finished stroke, not per frame: it stays responsive and
    // still steps back the way you expect.
    const undoStack = [];
    const redoStack = [];
    const UNDO_LIMIT = 40;

    function snapshot() {
      const ctx = layers[active].ctx;
      undoStack.push(ctx.getImageData(0, 0, view.width, view.height));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
      syncHistoryButtons();
    }

    function undo() {
      if (!undoStack.length) { say("Nothing to undo."); return; }
      const ctx = layers[active].ctx;
      redoStack.push(ctx.getImageData(0, 0, view.width, view.height));
      ctx.putImageData(undoStack.pop(), 0, 0);
      paint();
      syncHistoryButtons();
      say("Undone.");
    }

    function redo() {
      if (!redoStack.length) { say("Nothing to redo."); return; }
      const ctx = layers[active].ctx;
      undoStack.push(ctx.getImageData(0, 0, view.width, view.height));
      ctx.putImageData(redoStack.pop(), 0, 0);
      paint();
      syncHistoryButtons();
      say("Redone.");
    }

    // ---------- the tools ----------
    const state = {
      tool: "brush",
      colour: "#58d7ff",
      fill: "#1d3557",
      size: 6,
      text: "",
      drawing: false,
      start: null,
      // Where the hand is on the picture, in picture coordinates.
      handPoint: null,
      zoom: 1,
    };

    const TOOLS = ["select", "brush", "eraser", "line", "rect", "ellipse", "fill", "text", "pick"];

    function setTool(name) {
      if (!TOOLS.includes(name)) return;
      state.tool = name;
      for (const t of TOOLS) {
        const b = document.getElementById(`tool-flat-${t}`);
        if (b) b.setAttribute("aria-pressed", String(t === name));
      }
      view.style.cursor = name === "pick" ? "crosshair"
        : name === "fill" ? "cell"
        : name === "text" ? "text"
        : "crosshair";
      say(`${LABEL[name]} selected.`);
    }

    const LABEL = {
      select: "Move", brush: "Brush", eraser: "Eraser", line: "Line",
      rect: "Rectangle", ellipse: "Ellipse", fill: "Fill", text: "Text", pick: "Eyedropper",
    };

    // Picture coordinates, whatever the zoom or the size of the window.
    function toPicture(evt) {
      const r = view.getBoundingClientRect();
      const cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left;
      const cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - r.top;
      return {
        x: (cx / r.width) * view.width,
        y: (cy / r.height) * view.height,
      };
    }

    function paintPixel(x, y) {
      const ctx = layers[active].ctx;
      const r = state.size;
      if (state.tool === "eraser") {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = state.colour;
        ctx.beginPath();
        ctx.arc(x, y, r / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function paintShape(from, to) {
      const ctx = layers[active].ctx;
      ctx.fillStyle = state.colour;
      ctx.strokeStyle = state.colour;
      ctx.lineWidth = state.size;
      ctx.beginPath();
      if (state.tool === "line") {
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      } else if (state.tool === "rect") {
        ctx.rect(from.x, from.y, to.x - from.x, to.y - from.y);
        ctx.stroke();
      } else if (state.tool === "ellipse") {
        ctx.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2,
          Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    function floodFill(x, y) {
      const ctx = layers[active].ctx;
      const img = ctx.getImageData(0, 0, view.width, view.height);
      const d = img.data;
      const w = view.width;
      const at = (px, py) => (py * w + px) * 4;
      const sx = Math.floor(x), sy = Math.floor(y);
      if (sx < 0 || sy < 0 || sx >= w || sy >= view.height) return;
      const target = [d[at(sx, sy)], d[at(sx, sy) + 1], d[at(sx, sy) + 2], d[at(sx, sy) + 3]];
      const hex = state.colour.replace("#", "");
      const fill = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16), 255];
      if (target.every((v, i) => v === fill[i])) return;

      const stack = [[sx, sy]];
      const seen = new Uint8Array(w * view.height);
      while (stack.length) {
        const [px, py] = stack.pop();
        if (px < 0 || py < 0 || px >= w || py >= view.height) continue;
        const idx = py * w + px;
        if (seen[idx]) continue;
        seen[idx] = 1;
        const o = idx * 4;
        if (d[o] === target[0] && d[o + 1] === target[1] &&
            d[o + 2] === target[2] && d[o + 3] === target[3]) {
          d[o] = fill[0]; d[o + 1] = fill[1]; d[o + 2] = fill[2]; d[o + 3] = fill[3];
          stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    function pickColour(x, y) {
      const d = layers[active].ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      state.colour = hex;
      const input = document.getElementById("tool-flat-colour");
      if (input) input.value = hex;
      say(`Picked ${hex}.`);
    }

    function placeText(x, y) {
      const text = state.text.trim();
      if (!text) { say("Type something in the text box first."); return; }
      snapshot();
      const ctx = layers[active].ctx;
      ctx.fillStyle = state.colour;
      ctx.font = `${Math.max(12, state.size * 6)}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      for (const [i, line] of text.split("\n").entries()) {
        ctx.fillText(line, x, y + i * Math.max(12, state.size * 6) * 1.2);
      }
      paint();
      say("Text placed.");
    }

    // ---------- pointer and hand input ----------
    let before = null;      // the layer as it was, so a drag can be previewed

    function down(p) {
      if (state.tool === "fill") { snapshot(); floodFill(p.x, p.y); paint(); return; }
      if (state.tool === "pick") { pickColour(p.x, p.y); return; }
      if (state.tool === "text") { placeText(p.x, p.y); return; }
      if (state.tool === "select") { state.start = p; say("Drag to move the picture."); return; }

      snapshot();
      state.drawing = true;
      state.start = p;
      before = layers[active].ctx.getImageData(0, 0, view.width, view.height);
      if (state.tool === "brush" || state.tool === "eraser") {
        paintPixel(p.x, p.y);
        paint();
      }
    }

    function move(p) {
      if (!state.drawing) return;
      const ctx = layers[active].ctx;
      if (state.tool === "brush" || state.tool === "eraser") {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = state.size;
        ctx.strokeStyle = state.colour;
        if (state.tool === "eraser") {
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath();
          ctx.moveTo(state.start.x, state.start.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.moveTo(state.start.x, state.start.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        state.start = p;
        paint();
        return;
      }
      // Shapes are previewed by putting the old picture back first.
      ctx.putImageData(before, 0, 0);
      paintShape(state.start, p);
      paint();
    }

    function up() {
      state.drawing = false;
      state.start = null;
      before = null;
    }

    view.addEventListener("pointerdown", (e) => {
      view.setPointerCapture(e.pointerId);
      down(toPicture(e));
    });
    view.addEventListener("pointermove", (e) => move(toPicture(e)));
    view.addEventListener("pointerup", up);
    view.addEventListener("pointercancel", up);
    view.addEventListener("pointerleave", up);

    // ---------- files in and out ----------
    function loadImageFile(file) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        snapshot();
        const ctx = layers[active].ctx;
        // Fit the picture inside the canvas without stretching it.
        const s = Math.min(view.width / img.width, view.height / img.height);
        const w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (view.width - w) / 2, (view.height - h) / 2, w, h);
        paint();
        URL.revokeObjectURL(url);
        adaptTo("photo");
        say(`${file.name} placed on ${layers[active].name}.`);
      };
      img.onerror = () => { URL.revokeObjectURL(url); say(`Could not read ${file.name}.`); };
      img.src = url;
    }

    // Video is brought in frame by frame: each frame becomes its own layer, so
    // the same drawing tools work on it and a frame can be exported on its own.
    const video = { el: null, frames: [], at: 0, playing: false };

    function loadVideoFile(file) {
      const el = document.createElement("video");
      el.src = URL.createObjectURL(file);
      el.muted = true;
      el.playsInline = true;
      el.onloadeddata = () => {
        video.el = el;
        adaptTo("video");
        say(`${file.name} loaded — the video frame tools are out. Step through it and place frames.`);
      };
      el.onerror = () => say(`Could not read ${file.name} as a video.`);
    }

    function grabFrame() {
      if (!video.el) { say("Bring in a video first."); return; }
      snapshot();
      const c = document.createElement("canvas");
      c.width = video.el.videoWidth;
      c.height = video.el.videoHeight;
      c.getContext("2d").drawImage(video.el, 0, 0);
      const ctx = layers[active].ctx;
      const s = Math.min(view.width / c.width, view.height / c.height);
      ctx.drawImage(c, (view.width - c.width * s) / 2, (view.height - c.height * s) / 2,
        c.width * s, c.height * s);
      paint();
      say("Frame placed.");
    }

    function stepVideo(seconds) {
      if (!video.el) { say("Bring in a video first."); return; }
      video.el.currentTime = Math.max(0, Math.min(video.el.duration || 0,
        video.el.currentTime + seconds));
      say(`At ${video.el.currentTime.toFixed(2)}s.`);
    }

    function exportPng() {
      // Paint onto a clean canvas so what you save is what you see.
      const out = document.createElement("canvas");
      out.width = view.width;
      out.height = view.height;
      const ctx = out.getContext("2d");
      for (const layer of layers) {
        if (!layer.visible) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, 0, 0);
      }
      const a = document.createElement("a");
      a.download = "flat-design.png";
      a.href = out.toDataURL("image/png");
      a.click();
      say("Saved as flat-design.png.");
    }

    function newPicture() {
      // No pixel questions — a new picture simply fits the window you are in.
      const host = view.parentElement;
      const w = Math.max(64, Math.min(4096, Math.round((host && host.clientWidth) || 1280)));
      const h = Math.max(64, Math.min(4096, Math.round((host && host.clientHeight) || 720)));
      view.width = w;
      view.height = h;
      layers.length = 0;
      active = 0;
      makeLayer("Background", w, h);
      undoStack.length = 0;
      redoStack.length = 0;
      mountLayers();
      paint();
      syncHistoryButtons();
      say(`New picture, ${w}×${h}.`);
    }

    // ---------- the tab strip ----------
    function toolButton(id, name, hint, run) {
      const b = document.createElement("button");
      b.type = "button";
      b.id = `tool-flat-${id}`;
      b.className = "env-tool";
      b.textContent = name;
      b.title = hint;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        if (run) run();
        else setTool(id);
      });
      return b;
    }

    // The bar itself stays almost empty: the real design tools live in a
    // sub-section (the drawer), and what the drawer shows follows what you
    // bring in — a video surfaces its frame tools, a photo surfaces the
    // annotation tools, a blank canvas keeps only the brushes. As you talk
    // to Jarvis, more can surface here the same way.
    let adaptTo = () => {};
    const strip = env._tools;
    if (strip) {
      const slideEl = strip.parentElement;
      const drawer = document.createElement("div");
      drawer.className = "flat-drawer";
      drawer.hidden = true;
      const bodyEl = slideEl ? slideEl.querySelector(".env-body") : null;
      if (slideEl && bodyEl) slideEl.insertBefore(drawer, bodyEl);
      else strip.appendChild(drawer);

      function group(title) {
        const g = document.createElement("div");
        g.className = "flat-group";
        if (title) {
          const t = document.createElement("span");
          t.className = "flat-group-title";
          t.textContent = title;
          g.appendChild(t);
        }
        drawer.appendChild(g);
        return g;
      }

      // On the bar: just the way in, and the way out.
      const toolsBtn = toolButton("tools", "🧰 Tools", "Open the design tools", () => {
        drawer.hidden = !drawer.hidden;
        toolsBtn.setAttribute("aria-pressed", drawer.hidden ? "false" : "true");
      });
      strip.appendChild(toolsBtn);
      strip.appendChild(toolButton("save", "Save", "Save the picture", exportPng));

      // In the drawer: the real design tools, grouped.
      const gDraw = group("Draw");
      for (const name of TOOLS) {
        gDraw.appendChild(toolButton(name, LABEL[name], `${LABEL[name]} tool`, null));
      }
      // Colour, size and text are controls, not buttons, so they get slots.
      const colourSlot = document.createElement("span");
      colourSlot.className = "env-tool env-tool-control";
      colourSlot.id = "tool-flat-colour-slot";
      const colour = document.createElement("input");
      colour.type = "color";
      colour.id = "tool-flat-colour";
      colour.value = state.colour;
      colour.title = "Drawing colour";
      colour.addEventListener("input", () => { state.colour = colour.value; });
      colourSlot.appendChild(colour);
      gDraw.appendChild(colourSlot);

      const sizeSlot = document.createElement("span");
      sizeSlot.className = "env-tool env-tool-control";
      const size = document.createElement("input");
      size.type = "range";
      size.id = "tool-flat-size";
      size.min = "1";
      size.max = "64";
      size.value = String(state.size);
      size.title = "Brush size";
      size.setAttribute("aria-label", "Brush size");
      size.addEventListener("input", () => { state.size = Number(size.value); });
      sizeSlot.appendChild(size);
      gDraw.appendChild(sizeSlot);

      const textSlot = document.createElement("span");
      textSlot.className = "env-tool env-tool-control";
      const text = document.createElement("input");
      text.type = "text";
      text.placeholder = "text to place";
      text.title = "Text to place with the Text tool";
      text.setAttribute("aria-label", "Text to place");
      text.addEventListener("input", () => { state.text = text.value; });
      textSlot.appendChild(text);
      gDraw.appendChild(textSlot);

      const gHist = group("Steps");
      gHist.appendChild(toolButton("undo", "Undo", "Step back one stroke", undo));
      gHist.appendChild(toolButton("redo", "Redo", "Step forward again", redo));

      const gBring = group("Bring in");
      gBring.appendChild(toolButton("image", "Image", "Bring in a picture", () => filePick("image/*", loadImageFile)));
      gBring.appendChild(toolButton("video", "Video", "Bring in a video, frame by frame", () => filePick("video/*", loadVideoFile)));

      // The video tools only exist once there IS a video.
      const gVideo = group("Video frames");
      gVideo.hidden = true;
      gVideo.appendChild(toolButton("frame", "Frame", "Place the current video frame", grabFrame));
      gVideo.appendChild(toolButton("back", "◀ 1s", "Back one second of video", () => stepVideo(-1)));
      gVideo.appendChild(toolButton("fwd", "1s ▶", "Forward one second of video", () => stepVideo(1)));

      const gPic = group("Picture");
      gPic.appendChild(toolButton("layer", "+ Layer", "Add a layer", () => {
        makeLayer(`Layer ${layers.length + 1}`);
        active = layers.length - 1;
        mountLayers();
        say(`Added ${layers[active].name}.`);
      }));
      gPic.appendChild(toolButton("new", "New", "Start a new picture", newPicture));

      // Jarvis does the heavy lifting; everything above is the fallback
      // for minor changes by hand.
      const gAI = group("Jarvis");
      gAI.appendChild(toolButton("ai-make", "✨ Make", "Jarvis makes two takes — you pick the one you like", () => {
        const words = prompt("What should Jarvis make?");
        if (words && words.trim()) aiMake(words.trim());
      }));
      gAI.appendChild(toolButton("ai-change", "🪄 Change", "Jarvis changes this picture as you say", () => {
        const words = prompt("What should Jarvis change?");
        if (words && words.trim()) aiChange(words.trim());
      }));

      // One flat copy of every visible layer, for sending to Jarvis.
      function flattenPng() {
        const c = document.createElement("canvas");
        c.width = view.width;
        c.height = view.height;
        const ctx = c.getContext("2d");
        for (const layer of layers) {
          if (!layer.visible) continue;
          ctx.globalAlpha = layer.opacity;
          ctx.drawImage(layer.canvas, 0, 0);
        }
        ctx.globalAlpha = 1;
        return c.toDataURL("image/png").split(",")[1];
      }

      async function aiRequest(words, imageB64) {
        const body = { prompt: words };
        if (imageB64) body.image = imageB64;
        const resp = await fetch("/api/ai/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        // With no Gemini model available the server finds a real photograph on
        // the open web instead, and hands back its address rather than pixels.
        // The browser loads it straight into the layer, so the hand tools still
        // work on it exactly as they would on a drawn picture.
        if (data.found && data.url) {
          say(data.author ? `Found one — ${data.title}, by ${data.author} (${data.source}).` : `Found one — ${data.title} (${data.source}).`);
          return data.url;
        }
        return `data:${data.mime || "image/png"};base64,${data.image}`;
      }

      function placeResult(dataUrl, label) {
        const img = new Image();
        img.onload = () => {
          // The result lands on its own new layer, so the hand tools can
          // still fix the small things afterwards — and undo still works.
          makeLayer(label);
          active = layers.length - 1;
          snapshot();
          const ctx = layers[active].ctx;
          const s = Math.min(view.width / img.width, view.height / img.height);
          const w = img.width * s, h = img.height * s;
          ctx.drawImage(img, (view.width - w) / 2, (view.height - h) / 2, w, h);
          mountLayers();
          paint();
          say("Done. It is on its own layer — touch it up by hand if you want.");
        };
        img.src = dataUrl;
      }

      // The AI creates; you choose from what comes in.
      function chooseBetween(urls, label) {
        const host = slideEl || document.body;
        const overlay = document.createElement("div");
        overlay.className = "flat-choices";
        const title = document.createElement("p");
        title.className = "flat-choices-title";
        title.textContent = "Two takes. Pick one.";
        overlay.appendChild(title);
        const row = document.createElement("div");
        row.className = "flat-choices-row";
        for (const url of urls) {
          const pic = document.createElement("img");
          pic.src = url;
          pic.alt = "A take from Jarvis";
          pic.addEventListener("click", () => {
            overlay.remove();
            placeResult(url, label);
          });
          row.appendChild(pic);
        }
        overlay.appendChild(row);
        const neither = document.createElement("button");
        neither.type = "button";
        neither.textContent = "Neither — try different words";
        neither.addEventListener("click", () => {
          overlay.remove();
          say("Fair enough. Say it differently and press Make again.");
        });
        overlay.appendChild(neither);
        host.appendChild(overlay);
      }

      async function aiMake(words) {
        say("Jarvis is making two takes — pick the one you like…");
        const settled = await Promise.allSettled([aiRequest(words), aiRequest(words)]);
        const takes = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
        if (takes.length === 0) {
          const why = settled[0].status === "rejected" ? settled[0].reason.message : "no result";
          say(`Jarvis could not do it: ${why}`);
        } else if (takes.length === 1) {
          placeResult(takes[0], "Jarvis make");
        } else {
          chooseBetween(takes, "Jarvis make");
        }
      }

      async function aiChange(words) {
        say("Jarvis is changing the picture…");
        try {
          const result = await aiRequest(words, flattenPng());
          placeResult(result, "Jarvis change");
        } catch (err) {
          say(`Jarvis could not do it: ${err.message}`);
        }
      }

      // The room adapts to what you bring in.
      adaptTo = (kind) => {
        if (kind === "video") gVideo.hidden = false;
        if (kind === "photo" || kind === "video") {
          drawer.hidden = false;
          toolsBtn.setAttribute("aria-pressed", "true");
        }
      };
    }

    function filePick(accept, onFile) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        if (f) onFile(f);
      });
      input.click();
    }

    function syncHistoryButtons() {
      for (const [id, ok] of [["undo", undoStack.length > 0], ["redo", redoStack.length > 0]]) {
        const b = document.getElementById(`tool-flat-${id}`);
        if (b) b.disabled = !ok;
      }
    }

    // ---------- keyboard, because a mouse is not the only way in ----------
    function onKey(e) {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === "b") setTool("brush");
      else if (k === "e") setTool("eraser");
      else if (k === "l") setTool("line");
      else if (k === "r") setTool("rect");
      else if (k === "o") setTool("ellipse");
      else if (k === "f") setTool("fill");
      else if (k === "t") setTool("text");
      else if (k === "i") setTool("pick");
      else if (k === "v") setTool("select");
    }
    host.addEventListener("keydown", onKey);
    host.tabIndex = 0;

    // ---------- My Hands ----------
    // The engine already publishes the whole hand; a 2D picture uses it the same
    // way the 3D room does.
    const hand = { point: null, pinch: false, fist: false };
    let socket = null;

    function connectHand() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      try { socket = new WebSocket(`${proto}://${location.host}/ws/myhands`); } catch (_) { return; }
      socket.addEventListener("message", (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch (_) { return; }
        if (ev.type === "cursor_moved") {
          hand.point = {
            x: ev.x * view.width,
            y: ev.y * view.height,
          };
        } else if (ev.type === "pinch_started" || ev.type === "fist_started") {
          if (hand.point) down(hand.point);
        } else if (ev.type === "pinch_released" || ev.type === "fist_released") {
          up();
        }
      });
    }

    // ---------- start ----------
    mountLayers();
    setTool("brush");
    syncHistoryButtons();
    connectHand();
    say("Flat ready. Draw, or bring in an image or a video.");

    window.addEventListener("resize", () => paint());

    return {
      pause() { if (socket) { try { socket.close(); } catch (_) { /* already gone */ } } },
      resume() { if (!socket || socket.readyState > 1) connectHand(); },
    };
  },
};
