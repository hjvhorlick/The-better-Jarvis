/* The environments, in the order you slide through them.
 *
 * Each one is its own world with its own job. Coding is for writing and
 * reading code with Jarvis on hand. Design is the 3D room where you bring in
 * what you made in Blender and move it with your hand. Files is for looking at
 * what is on this computer.
 *
 * Nothing here downloads an environment's code — that happens the first time
 * you open it, so the app starts fast no matter how heavy the 3D room is.
 */
window.Shell.register({
  id: "coding",
  name: "Coding",
  hint: "Read code, and ask Jarvis about the file you have open",
  tools: [
    { id: "ask", name: "Ask Jarvis", hint: "Ask about the file you have open" },
    { id: "top", name: "Top of tree", hint: "Back to the top of the file tree" },
  ],
  mount: null,   // supplied by environments/coding.js when first opened
});

window.Shell.register({
  id: "design",
  name: "Design",
  hint: "The 3D room: bring in a Blender model and move it with your hand",
  tools: [
    { id: "import", name: "Import", hint: "Bring in a model you made" },
    { id: "frame", name: "Frame", hint: "Fit the model to the window" },
    { id: "wireframe", name: "Wireframe", hint: "Show the mesh instead of the surfaces" },
    { id: "opacity", name: "See-through", control: true,
      hint: "How much of your hand shows through the model" },
  ],
});

window.Shell.register({
  id: "flat",
  name: "Flat",
  hint: "The 2D room: draw on images and video frames, layer by layer",
  tools: [],
  mount: null,   // supplied by environments/flat.js when first opened
});

window.Shell.register({
  id: "studio",
  name: "Studio",
  hint: "Jarvis writes the script and the pictures; Scenering makes the video",
  tools: [],
  mount: null,   // supplied by environments/studio.js when first opened
});

window.Shell.register({
  id: "email",
  name: "Email",
  hint: "Prepare, save and review email drafts; sending stays in your chosen mail app",
  tools: [],
  mount: null,   // supplied by environments/email.js when first opened
});

window.Shell.register({
  id: "files",
  name: "Files",
  hint: "Browse and read files on this computer",
  tools: [
    { id: "up", name: "Up", hint: "Back up one folder" },
  ],
});

// Start on Coding: it is the lightest room, so the app is usable immediately.
window.Shell.open("coding");
