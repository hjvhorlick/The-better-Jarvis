/* Design environment — the 3D room.
 *
 * A real 3D room, not a picture of one. You bring in a model you made in
 * Blender, it keeps its textures and throws real shadows, and your hand moves
 * it. A wireframe switch and a transparency slider sit on the tool tabs at the
 * top, so the middle of the window stays empty for the model itself.
 *
 * Files are read in the browser and parsed here. Nothing is uploaded: a model
 * you are working on never leaves this computer.
 *
 * This module is only fetched when you open Design (see shell.js), so the 3D
 * engine costs nothing while you are coding.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";

const EXT = {
  glb: "gltf", gltf: "gltf",
  obj: "obj",
  fbx: "fbx",
  stl: "stl",
  "3mf": "3mf",
};

let api = null;          // { mount, pause, resume }
let renderer, scene, camera, controls, clock;
let pivot;               // everything the hand moves hangs off this
let model = null;
let raf = 0;
let frames = 0, fpsShownAt = 0;
let handSocket = null;
let wireframe = false;
let modelScale = 1;           // eased toward the two-hand scale
let readoutNode = null;        // the status line, so any gesture can speak
let transparency = 1;

// Hand state, kept here so the 3D world and the gesture engine agree. Every
// field below is filled by a real event from the engine, which reads all 21
// landmarks of every hand with depth kept -- so a turn, a scale and a pull are
// each their own gesture rather than one guess at a fingertip.
const hand = {
  connected: false,
  present: false,
  cursor: null,          // {x, y} in 0..1, mirrored to match the camera
  grabbing: false,       // pinch or fist
  grabbedId: null,
  turning: false,        // hold still: the model is being turned
  yaw: 0,                // how far it has been turned left/right
  pitch: 0,              // and tipped back/forward
  scaling: false,        // two hands on screen
  scale: 1,              // how far apart they are, relative to where they started
  pulling: 0,            // how far the claw has pulled toward the camera
  lastMove: 0,
  flash: 0,              // a clap makes the room flash, so it is felt
};

export default {
  mount(body) {
    const host = document.createElement("div");
    host.className = "d3";
    body.appendChild(host);

    const canvas = document.createElement("canvas");
    canvas.className = "d3-canvas";
    host.appendChild(canvas);

    const drop = document.createElement("div");
    drop.className = "d3-drop";
    drop.textContent = "Drop a Blender model here — .glb .gltf .obj .fbx .stl .3mf";
    host.appendChild(drop);

    const readout = document.createElement("div");
    readout.className = "d3-readout";
    readout.setAttribute("role", "status");
    readout.setAttribute("aria-live", "polite");
    host.appendChild(readout);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".glb,.gltf,.obj,.fbx,.stl,.3mf";
    fileInput.multiple = true;
    fileInput.hidden = true;
    host.appendChild(fileInput);

    buildScene(canvas);

    // ---------- the tool tabs, wired here ----------
    const tool = (id) => document.getElementById(`tool-design-${id}`);
    tool("import").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      loadFiles(Array.from(fileInput.files || []), readout);
      fileInput.value = "";
    });

    tool("wireframe").addEventListener("click", (e) => {
      wireframe = !wireframe;
      e.currentTarget.setAttribute("aria-pressed", wireframe ? "true" : "false");
      applyWireframe();
      say(readout, wireframe ? "Wireframe on" : "Wireframe off");
    });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "10";
    slider.max = "100";
    slider.value = "100";
    slider.className = "d3-slider";
    slider.setAttribute("aria-label", "How see-through the model is");
    slider.addEventListener("input", () => {
      transparency = Number(slider.value) / 100;
      applyTransparency();
      say(readout, `See-through ${slider.value}%`);
    });
    tool("opacity").appendChild(slider);

    tool("frame").addEventListener("click", () => { frameModel(); say(readout, "Framed"); });

    // Drag and drop, because that is how you work with files.
    ["dragenter", "dragover"].forEach((t) =>
      host.addEventListener(t, (e) => { e.preventDefault(); host.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((t) =>
      host.addEventListener(t, (e) => { e.preventDefault(); host.classList.remove("is-over"); }));
    host.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) loadFiles(files, readout);
    });

    connectHand(readout);
    startLoop();
    say(readout, "3D room ready. Drop a model in, or press Import.");
  },

  pause() { if (raf) { cancelAnimationFrame(raf); raf = 0; } },
  resume() { if (!raf) startLoop(); },
};

// ---------- the room ----------

function buildScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // capped: 3x is wasted work
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b14);

  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  camera.position.set(3.2, 2.4, 4.6);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.9, 0);

  // Light the room the way a studio would: a soft sky, a key light that casts
  // the shadow, and a cool rim so edges read against the dark background.
  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x0a0f18, 0.55));

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(4, 6.5, 3.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -6; key.shadow.camera.right = 6;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0005;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x58d7ff, 0.7);
  rim.position.set(-4, 2.5, -3.5);
  scene.add(rim);

  // A floor to catch the shadow, so the object sits in a room and not a void.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.ShadowMaterial({ opacity: 0.42 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(20, 40, 0x2a4a66, 0x14202e);
  grid.position.y = 0.001;
  scene.add(grid);

  // Everything the hand moves hangs off one pivot, so turning the pivot turns
  // the model without fighting the camera.
  pivot = new THREE.Group();
  scene.add(pivot);

  clock = new THREE.Clock();
  resize();
  window.addEventListener("resize", resize);
}

function resize() {
  const host = renderer.domElement.parentElement;
  if (!host) return;
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function startLoop() {
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);   // clamp: a stalled tab must not jump
    applyHand(dt);
    controls.update();
    renderer.render(scene, camera);
    countFps();
  };
  raf = requestAnimationFrame(tick);
}

function countFps() {
  frames++;
  const now = performance.now();
  if (now - fpsShownAt > 1000) {
    const fps = Math.round((frames * 1000) / (now - fpsShownAt));
    frames = 0; fpsShownAt = now;
    const el = document.querySelector(".d3-fps");
    if (el) el.textContent = `${fps} fps`;
  }
}

// ---------- bringing a model in ----------

async function loadFiles(files, readout) {
  const named = files.filter((f) => EXT[(f.name.split(".").pop() || "").toLowerCase()]);
  if (!named.length) {
    say(readout, "None of those are model files I can read.");
    return;
  }
  // Pick the main file: a .glb/.obj/.fbx/.stl/.3mf stands alone; a .gltf wants
  // its .bin and textures beside it, so keep every file the drop gave us.
  const main = named.find((f) => /\.(glb|obj|fbx|stl|3mf)$/i.test(f.name)) || named[0];
  say(readout, `Reading ${main.name}…`);

  try {
    const urls = new Map();
    for (const f of named) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const clean = decodeURI(url.split("/").pop().split("?")[0]).toLowerCase();
      return urls.get(clean) || url;
    });

    const kind = EXT[(main.name.split(".").pop() || "").toLowerCase()];
    const object = await parseModel(main, kind, manager);
    if (!object) { say(readout, "That file gave me nothing."); return; }

    for (const u of urls.values()) URL.revokeObjectURL(u);

    swapModel(object);
    frameModel();
    const tris = countTriangles(object);
    say(readout, `${main.name} loaded — ${tris.toLocaleString()} triangles.`);
  } catch (err) {
    say(readout, `Could not read that model: ${err.message}`);
  }
}

async function parseModel(file, kind, manager) {
  // glTF is the one loader that is asynchronous: it must fetch a model's
  // textures and buffers, so it hands back a promise rather than the object.
  if (kind === "gltf") {
    const loader = new GLTFLoader(manager);
    const data = /\.glb$/i.test(file.name) ? await file.arrayBuffer() : await file.text();
    const gltf = await loader.parseAsync(data, "");
    return gltf.scene || gltf.scenes?.[0] || null;
  }
  if (kind === "obj") return new OBJLoader(manager).parse(await file.text());
  if (kind === "fbx") return new FBXLoader(manager).parse(await file.arrayBuffer(), "");
  if (kind === "stl") {
    const geometry = new STLLoader().parse(await file.arrayBuffer());
    const mesh = new THREE.Mesh(geometry, defaultMaterial());
    mesh.castShadow = true;
    return mesh;
  }
  if (kind === "3mf") return new ThreeMFLoader(manager).parse(await file.arrayBuffer());
  return null;
}

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xb9c6d6, roughness: 0.45, metalness: 0.1 });
}

function swapModel(object) {
  if (model) {
    pivot.remove(model);
    disposeTree(model);
  }
  model = object;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      // Blender's own materials come through as they are; only fill in a
      // material for a mesh that arrived without one.
      if (!o.material) o.material = defaultMaterial();
    }
  });
  pivot.add(model);
  applyWireframe();
  applyTransparency();
}

function frameModel() {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCentre(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.001);

  // Stand the model on the floor and put the pivot at its middle, so the hand
  // turns it about its own centre rather than about a corner.
  pivot.position.set(0, 0, 0);
  model.position.sub(centre);
  model.position.y += size.y / 2;

  const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.15;
  const dir = new THREE.Vector3(0.55, 0.42, 1).normalize();
  camera.position.copy(dir.multiplyScalar(dist));
  controls.target.set(0, size.y / 2, 0);
  controls.update();
}

function countTriangles(object) {
  let n = 0;
  object.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      n += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    }
  });
  return Math.round(n);
}

function disposeTree(object) {
  object.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"]) {
          m[k]?.dispose();
        }
        m.dispose();
      }
    }
  });
}

// ---------- the two settings he asked for ----------

function applyWireframe() {
  if (!model) return;
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if ("wireframe" in m) m.wireframe = wireframe;
    }
  });
}

function applyTransparency() {
  if (!model) return;
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      // See-through, but never fully invisible, and always still clickable.
      m.transparent = transparency < 1;
      m.opacity = transparency;
      m.depthWrite = transparency > 0.85;
      m.needsUpdate = true;
    }
  });
}

// ---------- the hand ----------

/**
 * My Hands already publishes every gesture on the shared bus. We listen for it
 * and turn it into movement in the room. The rule set is the recipe we agreed:
 * move with a pinch, turn by holding still, scale with two hands.
 */
function connectHand(readout) {
  readoutNode = readout;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/myhands`;
  try {
    handSocket = new WebSocket(url);
  } catch (_) {
    say(readout, "Hand tracking is not connected. The mouse still works.");
    return;
  }
  handSocket.addEventListener("open", () => { hand.connected = true; say(readout, "Hand connected."); });
  handSocket.addEventListener("close", () => {
    hand.connected = false; hand.present = false; hand.grabbing = false;
  });
  handSocket.addEventListener("message", (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    onHandEvent(ev);
  });
}

function onHandEvent(ev) {
  switch (ev.type) {
    case "hand_detected": hand.present = true; break;
    case "hand_lost":
      hand.present = false; hand.grabbing = false; hand.cursor = null;
      hand.turning = false; hand.scaling = false; hand.pulling = 0;
      break;

    case "cursor_moved":
      hand.cursor = { x: ev.x, y: ev.y };
      hand.lastMove = performance.now();
      break;

    // Move: a pinch for precision, a fist for something too big to pinch.
    case "pinch_started":
    case "fist_started":
      hand.grabbing = true;
      hand.grabbedId = ev.id || null;
      break;
    case "pinch_released":
    case "fist_released":
    case "object_released":
      hand.grabbing = false; hand.grabbedId = null; hand.turning = false;
      break;

    // Turn: hold your hand still for a second, then tilt it. The engine reports
    // how far the palm has tilted, not where a fingertip happens to be.
    case "rotate_started": hand.turning = true; break;
    case "rotate_ended": hand.turning = false; break;
    case "rotate_delta":
      hand.yaw += ev.yaw || 0;
      hand.pitch += ev.pitch || 0;
      break;

    // Scale: two hands. The distance is measured in 3D, so moving your hands
    // toward the camera scales it too.
    case "scale_started": hand.scaling = true; hand.scale = 1; break;
    case "scale_ended": hand.scaling = false; break;
    case "scale_delta": hand.scale = ev.factor || 1; break;

    // Clap: bring your palms together. Centre it and say so.
    case "clap":
      hand.flash = 1;
      frameModel();
      if (readoutNode) say(readoutNode, "Centred.");
      break;

    // Pull: a half-closed hand dragged toward you. Only depth can tell this
    // from a sideways slide, which is exactly why the whole hand is read.
    case "pull_started": hand.pulling = 0; break;
    case "pull_ended": hand.pulling = 0; break;
    case "pull_delta": hand.pulling = ev.dz || 0; break;

    default: break;
  }
}

function applyHand(dt) {
  if (!model) return;

  if (hand.cursor) {
    // The cursor is 0..1 from the camera. Map it onto a plane through the
    // middle of the room so the model follows the hand where it actually is.
    const target = new THREE.Vector3(
      (hand.cursor.x - 0.5) * 6,
      (0.5 - hand.cursor.y) * 4 + 1,
      0
    );
    if (hand.grabbing) {
      // Move: ease toward the hand so it feels weighted, not teleported.
      pivot.position.lerp(target, Math.min(1, dt * 12));
    }
  }

  // Turn: the engine decides when the hand has been still long enough and
  // reports the palm's tilt from then on. We only apply what it says.
  if (hand.turning) {
    pivot.rotation.y = hand.yaw * 2.2;
    pivot.rotation.x = THREE.MathUtils.clamp(hand.pitch * 2.0, -0.9, 0.9);
  }

  // Scale: two hands, and only while both are on screen.
  const want = hand.scaling ? hand.scale : 1;
  if (Math.abs(want - modelScale) > 0.001) {
    modelScale += (want - modelScale) * Math.min(1, dt * 14);
    pivot.scale.setScalar(modelScale);
  }

  // Pull: a clawed hand drawn toward the camera brings the model closer, and
  // slides it toward you at the same time, because that is what pulling does.
  if (hand.pulling) {
    const z = THREE.MathUtils.clamp(hand.pulling * 6, -4, 4);
    pivot.position.z += (z - pivot.position.z) * Math.min(1, dt * 10);
  }

  // A clap flashes the status line so the gesture is felt, then fades.
  if (hand.flash > 0) {
    hand.flash = Math.max(0, hand.flash - dt * 2.5);
    if (readoutNode) readoutNode.classList.toggle("is-flash", hand.flash > 0.05);
  } else if (readoutNode) {
    readoutNode.classList.remove("is-flash");
  }
}

// ---------- small helpers ----------

function say(node, text) {
  node.textContent = text;
}
