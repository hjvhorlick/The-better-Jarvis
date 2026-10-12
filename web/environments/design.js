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
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
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
let modelAssetUrls = [];
let handCursorNode = null;

// Reused math objects for camera-plane hand dragging; keeping these outside the
// animation loop avoids a new Vector3/Raycaster allocation on every frame.
let handRaycaster = null;
let handNdc = null;
let handDragPlane = null;
let handPlaneNormal = null;
let handPlanePoint = null;
let handWorldPoint = null;

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
  grabOffset: new THREE.Vector3(),
  dragPlane: null,       // fixed camera-facing plane for this grab
  turning: false,        // hold still: the model is being turned
  yaw: 0,                // how far it has been turned left/right
  pitch: 0,              // and tipped back/forward
  rotationBase: new THREE.Vector2(),
  scaling: false,        // two hands on screen
  scale: 1,              // retained model scale
  scaleBase: 1,          // model scale when this two-hand gesture began
  pulling: 0,            // depth change since the claw pull began
  pullOffset: null,      // {dx, dy, dz} from the hand's pull origin
  pullBase: null,        // model position when the claw pull began
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
    drop.textContent = "Import OBJ / STL (include an OBJ's MTL and textures), or drop a 3D model here";
    host.appendChild(drop);

    const handCursor = document.createElement("div");
    handCursor.className = "d3-hand-cursor";
    handCursor.hidden = true;
    handCursor.setAttribute("aria-hidden", "true");
    host.appendChild(handCursor);
    handCursorNode = handCursor;

    const readout = document.createElement("div");
    readout.className = "d3-readout";
    readout.setAttribute("role", "status");
    readout.setAttribute("aria-live", "polite");
    host.appendChild(readout);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".glb,.gltf,.obj,.mtl,.fbx,.stl,.3mf,.bin,.png,.jpg,.jpeg,.webp,.bmp,.ktx2";
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.setAttribute("aria-label", "Choose an OBJ, STL, or other 3D model file");
    host.appendChild(fileInput);

    buildScene(canvas);

    // ---------- the tool tabs, wired here ----------
    const tool = (id) => document.getElementById(`tool-design-${id}`);
    tool("import").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      loadFiles(Array.from(fileInput.files || []), readout, host);
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

    tool("frame").addEventListener("click", () => {
      say(readout, frameModel() ? "Framed" : "Import a model first.");
    });

    // Drag and drop, because that is how you work with files.
    ["dragenter", "dragover"].forEach((t) =>
      host.addEventListener(t, (e) => { e.preventDefault(); host.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((t) =>
      host.addEventListener(t, (e) => { e.preventDefault(); host.classList.remove("is-over"); }));
    host.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) loadFiles(files, readout, host);
    });

    connectHand(readout, handCursor);
    startLoop();
    say(readout, "Ready — Import OBJ/STL; pinch to move, hold still and tilt to rotate, two hands to scale.");
  },

  pause() { if (raf) { cancelAnimationFrame(raf); raf = 0; } },
  resume() { if (!raf) startLoop(); },
};

// ---------- the room ----------

function buildScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // capped: 3x is wasted work
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  scene = new THREE.Scene();
  // Clear the WebGL canvas so the parent dashboard (or camera behind the glass)
  // remains visible anywhere no model or room tool is drawing.
  scene.background = null;

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

  handRaycaster = new THREE.Raycaster();
  handNdc = new THREE.Vector2();
  handDragPlane = new THREE.Plane();
  handPlaneNormal = new THREE.Vector3();
  handPlanePoint = new THREE.Vector3();
  handWorldPoint = new THREE.Vector3();

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

async function loadFiles(files, readout, host) {
  const available = files.filter((file) => file && typeof file.name === "string");
  const modelFiles = available.filter((file) => EXT[(file.name.split(".").pop() || "").toLowerCase()]);
  if (!modelFiles.length) {
    say(readout, "Choose an OBJ, STL, or another supported 3D model file.");
    return;
  }
  // A glTF may need sibling .bin and texture files, so keep every selected or
  // dropped file available to the local LoadingManager, not just the main model.
  const main = modelFiles.find((file) => /\.(glb|obj|fbx|stl|3mf)$/i.test(file.name)) || modelFiles[0];
  say(readout, `Reading ${main.name}…`);

  const urls = new Map();
  const createdUrls = [];
  let keepUrls = false;
  try {
    for (const file of available) {
      const url = URL.createObjectURL(file);
      createdUrls.push(url);
      const fullName = normalizeAssetPath(file.webkitRelativePath || file.name);
      const baseName = fullName.split("/").pop();
      urls.set(fullName, url);
      urls.set(baseName, url);
      urls.set(normalizeAssetPath(file.name), url);
    }

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const clean = normalizeAssetPath(url);
      const baseName = clean.split("/").pop();
      return urls.get(clean) || urls.get(baseName) || url;
    });

    const kind = EXT[(main.name.split(".").pop() || "").toLowerCase()];
    const object = await parseModel(main, kind, manager, available);
    if (!object) { say(readout, "That file did not contain a readable 3D model."); return; }

    const tris = countTriangles(object);
    if (!tris) { say(readout, "That model has no triangle mesh to display."); return; }

    swapModel(object, createdUrls);
    keepUrls = true;
    if (frameModel() && host) host.classList.add("has-model");
    say(readout, `${main.name} loaded — ${tris.toLocaleString()} triangles. Pinch/fist moves; hold and tilt rotates; two hands scale.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    say(readout, `Could not read ${main.name}: ${message}`);
  } finally {
    if (!keepUrls) createdUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}

async function parseModel(file, kind, manager, files = []) {
  // glTF is the one loader that is asynchronous: it must fetch a model's
  // textures and buffers, so it hands back a promise rather than the object.
  if (kind === "gltf") {
    const loader = new GLTFLoader(manager);
    const data = /\.glb$/i.test(file.name) ? await file.arrayBuffer() : await file.text();
    const gltf = await loader.parseAsync(data, "");
    return gltf.scene || gltf.scenes?.[0] || null;
  }
  if (kind === "obj") {
    const text = await file.text();
    const loader = new OBJLoader(manager);
    const materialFile = findObjMaterialLibrary(text, files);
    if (materialFile) {
      const creator = new MTLLoader(manager).parse(await materialFile.text(), "");
      creator.preload();
      loader.setMaterials(creator);
    }
    return loader.parse(text);
  }
  if (kind === "fbx") return new FBXLoader(manager).parse(await file.arrayBuffer(), "");
  if (kind === "stl") {
    const geometry = new STLLoader().parse(await file.arrayBuffer());
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = geometry.hasColors
      ? new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.45,
          metalness: 0.1,
          transparent: geometry.alpha < 1,
          opacity: geometry.alpha ?? 1,
        })
      : defaultMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    return mesh;
  }
  if (kind === "3mf") return new ThreeMFLoader(manager).parse(await file.arrayBuffer());
  return null;
}

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xb9c6d6, roughness: 0.45, metalness: 0.1 });
}

function swapModel(object, assetUrls = []) {
  if (model) {
    pivot.remove(model);
    disposeTree(model);
  }
  for (const url of modelAssetUrls) URL.revokeObjectURL(url);
  modelAssetUrls = assetUrls;

  model = object;
  pivot.position.set(0, 0, 0);
  pivot.rotation.set(0, 0, 0);
  pivot.scale.setScalar(1);
  modelScale = 1;
  hand.grabbing = hand.pinching = hand.fisting = false;
  hand.grabbedId = null;
  hand.grabOffset.set(0, 0, 0);
  hand.dragPlane = null;
  hand.turning = false;
  hand.yaw = hand.pitch = 0;
  hand.rotationBase.set(0, 0);
  hand.scale = hand.scaleBase = 1;
  hand.pullOffset = hand.pullBase = null;
  hand.pulling = 0;

  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      // Fill in a material for meshes that arrived without one.
      if (!o.material) o.material = defaultMaterial();
    }
  });
  pivot.add(model);
  pivot.updateMatrixWorld(true);

  // Put the model's geometric centre at the pivot origin. This makes a hand
  // grab move the visible model without jumping to an arbitrary file origin.
  const bounds = new THREE.Box3().setFromObject(model);
  if (!bounds.isEmpty()) {
    const centre = pivot.worldToLocal(bounds.getCenter(new THREE.Vector3()));
    model.position.sub(centre);
    model.updateMatrixWorld(true);
  }

  applyWireframe();
  applyTransparency();
}

function frameModel() {
  if (!model || !camera || !controls) return false;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return false;

  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const target = new THREE.Vector3(0, size.y / 2, 0);

  // Move the model's actual bounds to the room centre and floor while retaining
  // its current rotation and hand-controlled scale (including after a clap).
  pivot.position.add(new THREE.Vector3().subVectors(target, centre));
  pivot.updateMatrixWorld(true);

  const radius = Math.max(size.length() / 2, 0.001);
  const fovY = THREE.MathUtils.degToRad(camera.fov);
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * Math.max(camera.aspect, 0.1));
  const fitHalfFov = Math.max(0.01, Math.min(fovX, fovY) / 2);
  const distance = radius / Math.sin(fitHalfFov) * 1.15;
  const direction = new THREE.Vector3(0.55, 0.42, 1).normalize();

  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = Math.max(0.0001, distance / 1000);
  camera.far = Math.max(500, distance * 4);
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.update();
  return true;
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
      if ("wireframe" in m) { m.wireframe = wireframe; m.needsUpdate = true; }
    }
  });
}

function applyTransparency() {
  if (!model) return;
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      // Keep imported material alpha (including coloured STL) and apply the
      // slider as an additional transparency factor without changing the mesh.
      if (!Number.isFinite(m.userData.jarvisBaseOpacity)) {
        m.userData.jarvisBaseOpacity = Number.isFinite(m.opacity) ? m.opacity : 1;
      }
      const opacity = m.userData.jarvisBaseOpacity * transparency;
      m.transparent = opacity < 1;
      m.opacity = opacity;
      m.depthWrite = opacity > 0.85;
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
function connectHand(readout, cursorNode) {
  readoutNode = readout;
  handCursorNode = cursorNode || handCursorNode;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/myhands`;
  try {
    handSocket = new WebSocket(url);
  } catch (_) {
    say(readout, "My Hands is not connected. Use the mouse to orbit; reconnect hand tracking to move models.");
    return;
  }
  handSocket.addEventListener("open", () => {
    hand.connected = true;
    say(readout, "My Hands connected — pinch or fist-grab to move a model.");
  });
  handSocket.addEventListener("close", () => {
    hand.connected = false;
    clearHandState();
  });
  handSocket.addEventListener("message", (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    onHandEvent(ev);
  });
}

function clearHandState() {
  hand.present = false;
  hand.cursor = null;
  hand.grabbing = hand.pinching = hand.fisting = false;
  hand.grabbedId = null;
  hand.grabOffset.set(0, 0, 0);
  hand.dragPlane = null;
  hand.turning = hand.scaling = false;
  hand.pulling = 0;
  hand.pullOffset = hand.pullBase = null;
  if (handCursorNode) {
    handCursorNode.hidden = true;
    handCursorNode.classList.remove("is-grabbing", "is-turning", "is-scaling", "is-pulling");
  }
}

function updateHandCursor() {
  if (!handCursorNode) return;
  handCursorNode.classList.toggle("is-grabbing", hand.grabbing);
  handCursorNode.classList.toggle("is-turning", hand.turning);
  handCursorNode.classList.toggle("is-scaling", hand.scaling);
  handCursorNode.classList.toggle("is-pulling", Boolean(hand.pullOffset));
}

function beginHandGrab() {
  if (!pivot || !camera || !hand.cursor) return;
  hand.grabOffset.set(0, 0, 0);
  camera.getWorldDirection(handPlaneNormal);
  pivot.getWorldPosition(handPlanePoint);
  hand.dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(handPlaneNormal, handPlanePoint);
  const point = cursorWorldPoint(hand.cursor, handWorldPoint, hand.dragPlane);
  if (point) hand.grabOffset.copy(pivot.position).sub(point);
}

function endHandGrab() {
  hand.grabOffset.set(0, 0, 0);
  hand.dragPlane = null;
}

function onHandEvent(ev) {
  switch (ev.type) {
    case "hand_detected": hand.present = true; break;
    case "hand_lost":
      clearHandState();
      break;

    case "cursor_moved": {
      if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) break;
      hand.cursor = mapSharedCursorToRoom(ev.x, ev.y);
      hand.present = true;
      hand.lastMove = performance.now();
      if (hand.grabbing && !hand.dragPlane) beginHandGrab();
      if (handCursorNode) {
        handCursorNode.hidden = false;
        handCursorNode.style.left = `${hand.cursor.x * 100}%`;
        handCursorNode.style.top = `${hand.cursor.y * 100}%`;
      }
      break;
    }

    // Move: either a precise pinch or a whole-hand fist can hold the model.
    case "pinch_started":
      hand.pinching = true;
      hand.grabbing = true;
      hand.grabbedId = ev.id || null;
      beginHandGrab();
      break;
    case "fist_started":
      hand.fisting = true;
      hand.grabbing = true;
      hand.grabbedId = ev.id || null;
      beginHandGrab();
      break;
    case "pinch_released":
      hand.pinching = false;
      hand.grabbing = hand.fisting;
      if (!hand.grabbing) { hand.grabbedId = null; hand.turning = false; endHandGrab(); }
      break;
    case "fist_released":
      hand.fisting = false;
      hand.grabbing = hand.pinching;
      if (!hand.grabbing) { hand.grabbedId = null; hand.turning = false; endHandGrab(); }
      break;
    case "object_released":
      hand.pinching = hand.fisting = hand.grabbing = false;
      hand.grabbedId = null;
      hand.turning = false;
      endHandGrab();
      break;

    // Hold a grab still for a second, then tilt the palm to turn the model.
    case "rotate_started":
      hand.turning = true;
      hand.rotationBase.set(pivot?.rotation.x || 0, pivot?.rotation.y || 0);
      hand.yaw = hand.pitch = 0;
      break;
    case "rotate_ended": hand.turning = false; break;
    case "rotate_delta":
      hand.yaw += ev.yaw || 0;
      hand.pitch += ev.pitch || 0;
      break;

    // Scale is relative to the model's size when the two-hand gesture began;
    // keep the result after one hand leaves instead of snapping back to 1.
    case "scale_started":
      hand.scaling = true;
      hand.scaleBase = modelScale;
      hand.scale = modelScale;
      break;
    case "scale_ended": hand.scaling = false; break;
    case "scale_delta":
      hand.scale = THREE.MathUtils.clamp(hand.scaleBase * (ev.factor || 1), 0.1, 4);
      break;

    // Clap: bring your palms together. Centre the model without discarding its scale.
    case "clap":
      hand.flash = 1;
      frameModel();
      if (readoutNode) say(readoutNode, "Centred.");
      break;

    // Claw-pull offsets are relative to the model position when the pull began.
    // MediaPipe depth decreases toward the camera, so invert dz for world +Z.
    case "pull_started":
      hand.pulling = 0;
      hand.pullOffset = { dx: 0, dy: 0, dz: 0 };
      hand.pullBase = pivot ? pivot.position.clone() : null;
      break;
    case "pull_ended":
      hand.pulling = 0;
      hand.pullOffset = hand.pullBase = null;
      break;
    case "pull_delta":
      hand.pullOffset = { dx: ev.dx || 0, dy: ev.dy || 0, dz: ev.dz || 0 };
      hand.pulling = ev.dz || 0;
      break;

    default: break;
  }
  updateHandCursor();
}

function mapSharedCursorToRoom(x, y) {
  let u = Number(x);
  let v = Number(y);
  const viewport = handCursorNode?.parentElement;
  if (!viewport || !Number.isFinite(u) || !Number.isFinite(v)) {
    return { x: Math.max(0, Math.min(1, u || 0)), y: Math.max(0, Math.min(1, v || 0)) };
  }

  let pixelX = u * window.innerWidth;
  let pixelY = v * window.innerHeight;
  try {
    const frame = window.frameElement;
    if (frame && window.parent !== window) {
      const frameRect = frame.getBoundingClientRect();
      const parentWidth = window.parent.innerWidth;
      const parentHeight = window.parent.innerHeight;
      if (frameRect.width > 0 && frameRect.height > 0 && parentWidth > 0 && parentHeight > 0) {
        pixelX = (u * parentWidth - frameRect.left) * window.innerWidth / frameRect.width;
        pixelY = (v * parentHeight - frameRect.top) * window.innerHeight / frameRect.height;
      }
    }
    // The canvas is below the room tabs and tool strip; map to the actual 3D
    // viewport, not the full dashboard or the iframe's surrounding chrome.
    const rect = viewport.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      u = (pixelX - rect.left) / rect.width;
      v = (pixelY - rect.top) / rect.height;
    }
  } catch (_) {
    // A standalone Design room falls back to its own viewport coordinates.
  }
  return { x: Math.max(0, Math.min(1, u)), y: Math.max(0, Math.min(1, v)) };
}

function cursorWorldPoint(cursor, target = handWorldPoint, plane = null) {
  if (!cursor || !camera || !handRaycaster || !handNdc) return null;
  handNdc.set(cursor.x * 2 - 1, 1 - cursor.y * 2);
  handRaycaster.setFromCamera(handNdc, camera);

  let dragPlane = plane;
  if (!dragPlane) {
    camera.getWorldDirection(handPlaneNormal);
    pivot.getWorldPosition(handPlanePoint);
    dragPlane = handDragPlane.setFromNormalAndCoplanarPoint(handPlaneNormal, handPlanePoint);
  }
  return handRaycaster.ray.intersectPlane(dragPlane, target);
}

function applyHand(dt) {
  if (!model) return;

  if (hand.cursor && hand.grabbing) {
    const point = cursorWorldPoint(hand.cursor, handWorldPoint, hand.dragPlane);
    if (point) {
      point.add(hand.grabOffset);
      // A fixed camera-facing drag plane keeps the mesh under the hand without
      // snapping it to the cursor or allowing depth to drift while moving.
      pivot.position.lerp(point, Math.min(1, dt * 12));
    }
  }

  // The engine waits for a steady hold, then sends palm tilt deltas. Preserve
  // the model's existing orientation when each deliberate turn begins.
  if (hand.turning) {
    pivot.rotation.y = hand.rotationBase.y + hand.yaw * 2.2;
    pivot.rotation.x = THREE.MathUtils.clamp(hand.rotationBase.x + hand.pitch * 2.0, -0.9, 0.9);
  }

  // Scale: ease toward the target and retain the size when the two-hand gesture ends.
  const want = hand.scale;
  if (Math.abs(want - modelScale) > 0.001) {
    modelScale += (want - modelScale) * Math.min(1, dt * 14);
    pivot.scale.setScalar(modelScale);
  }

  // Pull: position is measured from the start of the claw gesture, so it does
  // not accumulate a new offset on every frame.
  if (hand.pullOffset && hand.pullBase) {
    const x = hand.pullBase.x - THREE.MathUtils.clamp(hand.pullOffset.dx * 6, -3, 3);
    const y = hand.pullBase.y - THREE.MathUtils.clamp(hand.pullOffset.dy * 4, -2, 2);
    const z = hand.pullBase.z - THREE.MathUtils.clamp(hand.pullOffset.dz * 6, -4, 4);
    const ease = Math.min(1, dt * 10);
    pivot.position.x += (x - pivot.position.x) * ease;
    pivot.position.y += (y - pivot.position.y) * ease;
    pivot.position.z += (z - pivot.position.z) * ease;
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

function normalizeAssetPath(value) {
  let path = String(value || "").split(/[?#]/, 1)[0].replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  try { path = decodeURIComponent(path); } catch (_) { /* retain malformed literal paths */ }
  return path.toLowerCase();
}

function findObjMaterialLibrary(objectText, files) {
  const references = [];
  for (const match of objectText.matchAll(/^\s*mtllib\s+(.+?)\s*$/gim)) {
    const reference = match[1].trim();
    if (!reference) continue;
    references.push(reference, ...reference.split(/\s+/));
  }

  for (const reference of references) {
    const path = normalizeAssetPath(reference);
    const baseName = path.split("/").pop();
    const file = files.find((candidate) => {
      if (!/\.mtl$/i.test(candidate.name)) return false;
      const candidatePath = normalizeAssetPath(candidate.webkitRelativePath || candidate.name);
      return candidatePath === path || candidatePath.split("/").pop() === baseName;
    });
    if (file) return file;
  }
  return null;
}

function say(node, text) {
  node.textContent = text;
}
