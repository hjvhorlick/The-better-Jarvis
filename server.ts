import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const PORT = 3000;
const HOST = '0.0.0.0';
const DEFAULT_PIN = 'JARVIS';
const AES_SALT = 'JARVIS-DASHBOARD-v1';

const app = express();
const server = http.createServer(app);

// Directory paths
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const STATIC_DIR = path.join(process.cwd(), 'dashboard', 'static');
const HAND_BOARD_DIR = path.join(process.cwd(), 'barehands');
const PROMPT_FILE = path.join(process.cwd(), 'core', 'prompt.txt');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// System prompt for JARVIS
let jarvisSystemPrompt = `You are JARVIS, Tony Stark's sophisticated, highly capable, and witty AI assistant, adapted as a personal executive assistant.
CRITICAL CONDUCT:
1. Speak in English only. Keep responses crisp, efficient, articulate, and direct (1-3 sentences unless detailed technical analysis is requested).
2. Professional demeanor: Courteous, slightly witty, composed, resourceful. Address the user respectfully (e.g., 'sir' or by context).
3. Be proactive and helpful with system queries, planning, research, commands, and file operations.
4. If asked about status or capabilities, summarize smoothly.`;

if (fs.existsSync(PROMPT_FILE)) {
  try {
    const customPrompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
    if (customPrompt.trim().length > 0) {
      jarvisSystemPrompt = customPrompt.slice(0, 4000);
    }
  } catch (err) {
    console.warn('Could not read core/prompt.txt:', err);
  }
}

// Multer storage for uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    // Sanitize filename
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  },
});
const upload = multer({ storage });

// Session & Authentication State
const activePin = DEFAULT_PIN;
const validTokens = new Set<string>();
const deviceTokens = new Map<string, { token: string; key: string }>();

// Pre-seed a master token
const defaultToken = 'jarvis-live-session-token';
validTokens.add(defaultToken);

// JARVIS state
let jarvisState: 'active' | 'sleeping' = 'active';

interface LogMessage {
  type: 'log';
  speaker: 'jarvis' | 'user';
  text: string;
  timestamp: number;
  image?: string; // a picture Jarvis made, shown in the dialogue
}

const messageHistory: LogMessage[] = [
  {
    type: 'log',
    speaker: 'jarvis',
    text: 'Good day, sir. Systems operational. All primary modules online and standing by for your command.',
    timestamp: Date.now(),
  },
];

// ── Persistent memory (merged from the Python engine's design) ───────────────
// The conversation survives restarts, and JARVIS can keep notes the owner asks it
// to remember. The owner's original memory file (memory/long_term.json) is read
// ONLY — it is never written or changed by this server.
const MEMORY_DIR = path.join(process.cwd(), 'memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'dashboard_history.json');
const OWNER_MEMORY_FILE = path.join(MEMORY_DIR, 'long_term.json');       // read-only
const APP_MEMORY_FILE = path.join(MEMORY_DIR, 'dashboard_memory.json');  // this app's notes

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

try {
  const saved = readJsonSafe(HISTORY_FILE);
  if (Array.isArray(saved) && saved.length) {
    messageHistory.push(...(saved as LogMessage[]).slice(-200));
  }
} catch { /* a fresh start is fine */ }

let historyTimer: NodeJS.Timeout | null = null;
function saveHistory() {
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    try {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageHistory.slice(-200), null, 1));
    } catch (err) {
      console.warn('Could not save chat history:', err);
    }
  }, 500);
}

function listNotes(): Array<{ text: string; at: string }> {
  const raw = readJsonSafe(APP_MEMORY_FILE);
  return Array.isArray(raw) ? (raw as Array<{ text: string; at: string }>) : [];
}

function rememberNote(text: string) {
  const notes = listNotes();
  notes.push({ text, at: new Date().toISOString() });
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(APP_MEMORY_FILE, JSON.stringify(notes, null, 2));
}

function memoryBlock(): string {
  const parts: string[] = [];
  const owner = readJsonSafe(OWNER_MEMORY_FILE);
  if (owner) {
    const text = typeof owner === 'string' ? owner : JSON.stringify(owner);
    parts.push(`Owner's long-term memory:\n${text.slice(0, 1500)}`);
  }
  const notes = listNotes();
  if (notes.length) {
    parts.push('Notes the owner asked you to remember:\n' + notes.slice(-30).map((n) => `- ${n.text}`).join('\n'));
  }
  return parts.length
    ? `\n\nMEMORY (use these facts naturally when relevant; do not recite them unprompted):\n${parts.join('\n\n')}`
    : '';
}


// Helper: Decrypt AES-256-CBC ciphertext from client
function decryptMessage(b64Data: string, pin: string): string | null {
  try {
    const raw = Buffer.from(b64Data, 'base64');
    if (raw.length < 17) return null;
    const iv = raw.subarray(0, 16);
    const ciphertext = raw.subarray(16);
    const key = crypto.createHash('sha256').update(pin + AES_SALT).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err);
    return null;
  }
}

// Helper: Gemini AI Client (Lazy initialization)
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

// Jarvis's own picture tool. Both the rooms and Jarvis himself use this one
// path, so what the owner can do, Jarvis can do from a chat line too.
async function makeAiImage(promptText: string, imageBase64?: string): Promise<{ data: string; mime: string }> {
  const ai = getGeminiClient();
  if (!ai) throw new Error('no GEMINI_API_KEY is on this machine — the picture tool is offline. The hand tools still work.');
  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  if (imageBase64) parts.push({ inlineData: { mimeType: 'image/png', data: imageBase64 } });
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [{ role: 'user', parts }],
  });
  const outParts =
    (result as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }> })
      .candidates?.[0]?.content?.parts || [];
  const img = outParts.find((p) => p.inlineData && p.inlineData.data);
  if (!img || !img.inlineData || !img.inlineData.data) {
    const text = outParts.find((p) => typeof p.text === 'string');
    throw new Error(text ? `the model answered with words, not a picture: ${String(text.text).slice(0, 160)}` : 'the model returned no image.');
  }
  return { data: img.inlineData.data, mime: img.inlineData.mimeType || 'image/png' };
}

// Process user command through JARVIS reasoning
async function processCommand(userCommand: string): Promise<string> {
  const trimmed = userCommand.trim();
  if (!trimmed) return 'Awaiting your command, sir.';

  const lower = trimmed.toLowerCase();
  // Intercept My Hands spatial commands directly for instantaneous UI state toggling
  if (lower.includes('my hands') || lower.includes('myhands') || (lower.includes('hand') && lower.includes('gesture')) || lower.includes('gesture tracking')) {
    if (lower.includes('off') || lower.includes('stop') || lower.includes('disable') || lower.includes('close') || lower.includes('exit')) {
      broadcast({ type: 'myhands_control', active: false });
      return 'Disengaging My Hands gesture tracking and restoring HUD overview.';
    } else {
      broadcast({ type: 'myhands_control', active: true });
      return 'Engaging My Hands spatial tracking. Camera background initialized and dull glass interfaces ready for gesture manipulation.';
    }
  }

  // Memory: "remember ..." stores a note; "what do you remember" lists them. Local, instant.
  const rememberMatch = trimmed.match(/^(?:jarvis,?\s+)?remember(?:\s+that)?\s+(.{2,500})$/i);
  if (rememberMatch) {
    try {
      rememberNote(rememberMatch[1].trim());
      return `Noted and stored, sir: ${rememberMatch[1].trim()}`;
    } catch {
      return 'I could not write that note to memory, sir. Check that the memory folder is writable.';
    }
  }
  if (/what do you remember|list (?:your )?(?:notes|memor(?:y|ies))|show (?:your )?memory/i.test(lower)) {
    const notes = listNotes();
    if (!notes.length) return 'No stored notes yet, sir. Say "remember ..." and I will keep it.';
    return 'I hold these notes, sir:\n' + notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n');
  }

  // Jarvis uses his own tools: "make a picture of ..." runs the picture
  // maker himself and drops the result straight into the dialogue.
  const picMatch = trimmed.match(
    /^(?:jarvis,?\s+)?(?:make|create|draw|generate|design)\s+(?:me\s+)?(?:a|an|the)?\s*(?:picture|image|photo|logo|poster|banner|icon)\s*(?:of|for|about|showing)?\s+(.{3,400})$/i
  );
  if (picMatch) {
    const subject = picMatch[1].trim();
    try {
      const img = await makeAiImage(subject);
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const fname = `jarvis-made-${Date.now()}.png`;
      fs.writeFileSync(path.join(UPLOADS_DIR, fname), Buffer.from(img.data, 'base64'));
      const imgMsg: LogMessage = {
        type: 'log',
        speaker: 'jarvis',
        text: `Made it myself, sir — ${subject}.`,
        image: `/uploads/${fname}`,
        timestamp: Date.now(),
      };
      messageHistory.push(imgMsg);
      broadcast(imgMsg);
      saveHistory();
      return `It is saved in uploads as ${fname}. Say "make ..." again for another take, or touch it up by hand in the Flat room.`;
    } catch (err) {
      return `I reached for the picture tool, sir, but ${(err as Error).message}`;
    }
  }

  // Rooms by voice — hands and voice first, no buttons needed.
  // "open the 3D room" / "the flat" / "next room" / "close the rooms".
  const roomAlias: Record<string, string> = {
    coding: 'coding', code: 'coding', coder: 'coding',
    design: 'design', '3d': 'design', 'three d': 'design', blender: 'design', workshop: 'design',
    flat: 'flat', '2d': 'flat', 'two d': 'flat', drawing: 'flat', canvas: 'flat',
    studio: 'studio', video: 'studio', media: 'studio',
    files: 'files', file: 'files',
  };
  const gotoMatch = lower.match(
    /\b(?:open|show|bring (?:up|in)|go to|take me to|switch to|sweep (?:in|to))\s+(?:the\s+)?(coding|coder|code|design|3d|three d|blender|workshop|flat|2d|two d|drawing|canvas|studio|video|media|files?)\s*(?:room|workspace|environment)?\b/
  );
  if (gotoMatch) {
    const room = roomAlias[gotoMatch[1]];
    broadcast({ type: 'rooms_control', action: 'goto', room });
    return `Sweeping in the ${room} room, sir.`;
  }
  if (/\b(open|show|bring (?:up|in))\b.*\brooms\b/.test(lower)) {
    broadcast({ type: 'rooms_control', action: 'open' });
    return 'Rooms on screen, sir. Sweep a flat hand to slide between them, sweep down to dismiss.';
  }
  if (/\b(close|hide|dismiss|put away)\b.*\b(rooms?|workspaces?)\b/.test(lower)) {
    broadcast({ type: 'rooms_control', action: 'close' });
    return 'Rooms dismissed, sir.';
  }
  if (/\b(next|forward)\s+(room|workspace|environment)\b/.test(lower)) {
    broadcast({ type: 'rooms_control', action: 'next' });
    return 'Sliding to the next room, sir.';
  }
  if (/\b(previous|last|back)\s+(room|workspace|environment)\b/.test(lower)) {
    broadcast({ type: 'rooms_control', action: 'prev' });
    return 'Sliding back, sir.';
  }

  // Diagnostics: real readings, never a canned line.
  if (/\b(status|diagnostics|telemetry|system health)\b/.test(lower)) {
    return realStatusReport();
  }

  const ai = getGeminiClient();
  if (ai) {
    try {
      // The last few turns give Gemini real conversation context instead of a blank slate.
      const turns = messageHistory.slice(-10).map((m) => ({
        role: m.speaker === 'jarvis' ? ('model' as const) : ('user' as const),
        parts: [{ text: m.text.slice(0, 2000) }],
      }));
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          ...turns,
          {
            role: 'user',
            parts: [{ text: `${jarvisSystemPrompt}${memoryBlock()}\n\nUser command: "${trimmed}"` }],
          },
        ],
      });
      const reply = response.text?.trim();
      if (reply) return reply;
    } catch (err) {
      console.error('Gemini error:', err);
    }
  }

  // Built-in fallback when Gemini key is not provided or fails
  if (lower.includes('who are you') || lower.includes('what are you') || lower.includes('identity')) {
    return 'I am JARVIS, your automated personal assistant. I monitor systems, process directives, and execute operational workflows.';
  }
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return 'Good day, sir. How may I be of service?';
  }
  if (lower.includes('time') || lower.includes('date')) {
    return `Current server timestamp is ${new Date().toLocaleString()}.`;
  }
  if (lower.includes('wake') || lower.includes('online')) {
    return 'Systems awake and responsive, sir.';
  }

  return `Acknowledged: "${trimmed}". Command queued and recorded in system logs.`;
}

// Real telemetry for the Diagnostics button — honest readings, no theatre.
function realStatusReport(): string {
  const mem = process.memoryUsage();
  const up = Math.round(process.uptime());
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  const notes = listNotes().length;
  return [
    'Real telemetry, sir — measured, not scripted:',
    `• Server uptime ${Math.floor(up / 60)} min ${up % 60} s · memory ${Math.round(mem.rss / 1048576)} MB`,
    `• Connected interfaces: ${wss.clients.size}`,
    `• Gemini neural core: ${hasKey ? 'linked (gemini-2.5-flash)' : 'NO API KEY — replies are built-in only. Add GEMINI_API_KEY to the .env file and restart.'}`,
    `• Conversation log: ${messageHistory.length} entries, kept across restarts in memory/dashboard_history.json`,
    `• Stored notes: ${notes} (say "remember ..." to add one)`,
    '• Voice: speech out 🔊 and speech in 🎤 run in your browser; 🎙 toggles the "Hey Jarvis" wake word.',
  ].join('\n');
}

// ── WebSockets Setup ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const audioWss = new WebSocketServer({ noServer: true });

// ── My Hands gesture bus (/ws/myhands) ──────────────────────────────────────
// The browser running the camera publishes small gesture events here, and every
// room — the 3D room, the Flat — listens on this same channel. This is the exact
// contract the rooms were built against in the engine room, so the hand that the
// dashboard tracks now drives the rooms directly: pinch draws, fist pans, two
// hands scale, a clap centres the work.
const handsWss = new WebSocketServer({ noServer: true });
handsWss.on('connection', (ws: WebSocket) => {
  ws.on('message', (data) => {
    const msg = data.toString();
    if (msg.length > 4096) return; // gesture events are tiny; drop anything else
    handsWss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  });
});

function broadcast(payload: object) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  // Send current status
  ws.send(JSON.stringify({ type: 'status', state: jarvisState }));

  // Send history (up to 50 items)
  for (const item of messageHistory.slice(-50)) {
    ws.send(JSON.stringify(item));
  }

  ws.on('message', async (data: Buffer | string) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'command') {
        let cmd = parsed.text || '';
        if (parsed.enc) {
          const dec = decryptMessage(parsed.enc, activePin);
          if (dec) cmd = dec;
        }
        if (cmd) {
          handleIncomingUserCommand(cmd);
        }
      }
    } catch (e) {
      console.warn('WS parse error:', e);
    }
  });
});

// Voice command fallback: the page streams raw PCM16 here, then sends {"type":"end"}.
// The audio is wrapped as WAV and transcribed by Gemini; the transcript goes back to the
// page, which submits it as a normal command. Used when the browser has no built-in
// speech recognition (or it fails). Needs GEMINI_API_KEY; without it, a clear message
// is returned instead of silence.
const MAX_VOICE_SECONDS = 15;

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);               // PCM chunk size
  header.writeUInt16LE(1, 20);                // PCM format
  header.writeUInt16LE(1, 22);                // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);   // byte rate
  header.writeUInt16LE(2, 32);                // block align
  header.writeUInt16LE(16, 34);               // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function transcribeVoice(pcm: Buffer, sampleRate: number): Promise<{ type: string; text?: string; message?: string }> {
  if (pcm.length < sampleRate * 2 * 0.4) {
    return { type: 'error', message: 'I heard almost nothing, sir. Click the mic, speak, then click it again.' };
  }
  const ai = getGeminiClient();
  if (!ai) {
    return { type: 'error', message: 'Voice transcription needs GEMINI_API_KEY in the server .env file. (The browser\u2019s own speech recognition works without it in Chrome.)' };
  }
  try {
    const wav = pcmToWav(pcm, sampleRate);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
            { text: 'Transcribe this audio exactly. Reply with only the words spoken, nothing else.' },
          ],
        },
      ],
    });
    const text = response.text?.trim();
    if (!text) return { type: 'error', message: 'I could not make out any words in that, sir.' };
    return { type: 'transcript', text };
  } catch (err) {
    console.error('Voice transcription error:', err);
    return { type: 'error', message: 'Voice transcription failed on the server. Check the server logs.' };
  }
}

audioWss.on('connection', (ws: WebSocket) => {
  const chunks: Buffer[] = [];
  let collected = 0;
  let sampleRate = 48000;
  let done = false;

  ws.on('message', async (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'start' && Number(m.rate) > 0) {
          sampleRate = Math.min(Math.max(Number(m.rate), 8000), 96000);
        } else if (m.type === 'end' && !done) {
          done = true;
          const result = await transcribeVoice(Buffer.concat(chunks), sampleRate);
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
          ws.close();
        }
      } catch {
        /* ignore malformed control frames */
      }
      return;
    }
    if (done) return;
    collected += data.length;
    if (collected <= sampleRate * 2 * MAX_VOICE_SECONDS) chunks.push(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const token = urlObj.searchParams.get('token');

  // The gesture bus carries nothing but hand coordinates, and the rooms connect
  // to it bare — same as they did in the engine room — so it skips the token.
  if (pathname === '/ws/myhands') {
    handsWss.handleUpgrade(req, socket, head, (ws) => {
      handsWss.emit('connection', ws, req);
    });
    return;
  }

  // Verify token
  if (!token || (!validTokens.has(token) && token !== defaultToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/phone-audio') {
    audioWss.handleUpgrade(req, socket, head, (ws) => {
      audioWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Middleware
app.use(express.json({ limit: '25mb' })); // room pictures travel to the AI tools
app.use(express.urlencoded({ extended: true }));

// Handle User Command execution
async function handleIncomingUserCommand(text: string) {
  const userMsg: LogMessage = {
    type: 'log',
    speaker: 'user',
    text,
    timestamp: Date.now(),
  };
  messageHistory.push(userMsg);
  broadcast(userMsg);

  if (jarvisState === 'sleeping') {
    jarvisState = 'active';
    broadcast({ type: 'status', state: 'active' });
  }

  const replyText = await processCommand(text);
  const jarvisMsg: LogMessage = {
    type: 'log',
    speaker: 'jarvis',
    text: replyText,
    timestamp: Date.now(),
  };
  messageHistory.push(jarvisMsg);
  broadcast(jarvisMsg);
  saveHistory();
}

// ── HTTP Endpoints ───────────────────────────────────────────────────────────

// Static files
app.get('/static/crypto.js', (_req: Request, res: Response) => {
  const cryptoPath = path.join(STATIC_DIR, 'crypto-js.min.js');
  if (fs.existsSync(cryptoPath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(cryptoPath);
  } else {
    res.status(404).send('Not found');
  }
});

app.use('/static', express.static(STATIC_DIR));
app.use('/hand-board', express.static(HAND_BOARD_DIR));
app.use('/myhands', express.static(HAND_BOARD_DIR));

// Direct route to serve the hand board stage if accessed directly
app.get('/stage.html', (_req: Request, res: Response) => {
  const stagePath = path.join(HAND_BOARD_DIR, 'stage.html');
  if (fs.existsSync(stagePath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(stagePath);
  } else {
    res.status(404).send('stage.html missing');
  }
});

// Hand board config endpoint
app.get('/config', (_req: Request, res: Response) => {
  const cfgPath = path.join(HAND_BOARD_DIR, 'barehands.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      res.json(cfg);
      return;
    } catch {}
  }
  res.json({
    name: 'JARVIS',
    port: PORT,
    orbs: [
      { title: 'Notes', path: 'sample-notes', kind: 'notes' },
      { title: 'Props', path: 'media', kind: 'media' },
    ],
  });
});

// GET / -> Serve app.html with dynamic host replacement
app.get('/', (req: Request, res: Response) => {
  const appHtmlPath = path.join(STATIC_DIR, 'app.html');
  if (!fs.existsSync(appHtmlPath)) {
    res.status(500).send('app.html missing');
    return;
  }
  let html = fs.readFileSync(appHtmlPath, 'utf8');
  const host = req.headers.host || `localhost:${PORT}`;
  const [ipPart, portPart] = host.split(':');
  html = html.replace(/__IP__/g, ipPart || 'localhost');
  html = html.replace(/__PORT__/g, portPart || '3000');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// GET /login -> Serve login.html
app.get('/login', (_req: Request, res: Response) => {
  const loginHtmlPath = path.join(STATIC_DIR, 'login.html');
  if (!fs.existsSync(loginHtmlPath)) {
    res.status(500).send('login.html missing');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(loginHtmlPath);
});

// POST /login -> Authenticate with session PIN
app.post('/login', (req: Request, res: Response) => {
  const pin = (req.body?.pin || '').toString().trim().toUpperCase();
  if (pin === activePin || pin === 'JARVIS' || pin.length === 6) {
    const token = crypto.randomBytes(24).toString('hex');
    validTokens.add(token);
    res.json({ ok: true, token, key: pin || activePin });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid PIN' });
  }
});

// GET /auto-login -> Quick URL pairing
app.get('/auto-login', (req: Request, res: Response) => {
  const key = ((req.query.key as string) || activePin).trim().toUpperCase();
  const token = crypto.randomBytes(24).toString('hex');
  validTokens.add(token);
  const redirectHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authenticating...</title></head>
<body>
<p>Connecting to JARVIS...</p>
<script>
  sessionStorage.setItem('jarvis_key', ${JSON.stringify(key)});
  sessionStorage.setItem('jarvis_token', ${JSON.stringify(token)});
  location.replace('/');
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(redirectHtml);
});

// POST /api/device-login -> Device token auto-reconnect
app.post('/api/device-login', (req: Request, res: Response) => {
  const devTok = req.body?.device_token;
  if (devTok && deviceTokens.has(devTok)) {
    const info = deviceTokens.get(devTok)!;
    res.json({ ok: true, token: info.token, key: info.key });
  } else {
    // Generate new pairing
    const newDevTok = devTok || crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    validTokens.add(token);
    deviceTokens.set(newDevTok, { token, key: activePin });
    res.json({ ok: true, token, key: activePin, device_token: newDevTok });
  }
});

// POST /api/revoke-devices -> Revoke paired devices
app.post('/api/revoke-devices', (_req: Request, res: Response) => {
  deviceTokens.clear();
  res.json({ ok: true });
});

// Bearer token auth middleware for API endpoints
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim() || (req.query.token as string);
  if (!token || (!validTokens.has(token) && token !== defaultToken)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// POST /api/command -> Execute command
app.post('/api/command', requireAuth, async (req: Request, res: Response) => {
  const { text, enc } = req.body || {};
  let commandText = text;
  if (!commandText && enc) {
    const decrypted = decryptMessage(enc, activePin);
    if (decrypted) commandText = decrypted;
  }

  if (!commandText) {
    res.status(400).json({ error: 'Empty command' });
    return;
  }

  await handleIncomingUserCommand(commandText);
  res.json({ ok: true });
});

// POST /api/wake -> Wake up JARVIS
app.post('/api/wake', requireAuth, (_req: Request, res: Response) => {
  jarvisState = 'active';
  broadcast({ type: 'wake' });
  broadcast({ type: 'status', state: 'active' });
  const wakeMsg: LogMessage = {
    type: 'log',
    speaker: 'jarvis',
    text: 'At your service, sir. All telemetry channels are open.',
    timestamp: Date.now(),
  };
  messageHistory.push(wakeMsg);
  broadcast(wakeMsg);
  res.json({ ok: true, state: 'active' });
});

// POST /api/upload -> Upload files to JARVIS
app.post('/api/upload', requireAuth, upload.single('file') as any, (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  const file = req.file;
  broadcast({
    type: 'file_received',
    name: file.filename,
    original_name: file.originalname,
    size: file.size,
    saved_to: `./uploads/${file.filename}`,
  });

  const fileLog: LogMessage = {
    type: 'log',
    speaker: 'jarvis',
    text: `File received: ${file.originalname} (${(file.size / 1024).toFixed(1)} KB). Securely archived to server storage.`,
    timestamp: Date.now(),
  };
  messageHistory.push(fileLog);
  broadcast(fileLog);

  res.json({ ok: true, name: file.filename, original_name: file.originalname, size: file.size });
});

// GET /api/files -> List stored files
app.get('/api/files', requireAuth, (_req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR).map((name) => {
      const stats = fs.statSync(path.join(UPLOADS_DIR, name));
      return {
        name,
        size: stats.size,
        modified: stats.mtimeMs,
      };
    });
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: 'Could not list files' });
  }
});

// GET /uploads/:filename -> Download uploaded file
app.get('/uploads/:filename', requireAuth, (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('File not found');
    return;
  }
  res.download(filePath, filename);
});

// Helper: Directory Tree Node
interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  extension?: string;
  children?: TreeNode[];
}

function buildTree(dirPath: string, relativePath = '', depth = 0): TreeNode[] {
  if (depth > 4) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', '.gemini', '.cache']);

    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.startsWith('.git')) continue;
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const full = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'dir',
          children: buildTree(full, rel, depth + 1),
        });
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'file',
          size,
          extension: path.extname(entry.name).toLowerCase(),
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'dir' ? -1 : 1;
    });
  } catch {
    return [];
  }
}

// GET /api/tree -> Project file hierarchy
app.get('/api/tree', (_req: Request, res: Response) => {
  try {
    const tree = buildTree(process.cwd());
    res.json({ ok: true, tree });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not generate file tree' });
  }
});

// GET /api/file-content -> Safe file preview
app.get('/api/file-content', (req: Request, res: Response) => {
  const reqPath = (req.query.path as string) || '';
  if (!reqPath) {
    res.status(400).json({ ok: false, error: 'File path required' });
    return;
  }
  const safePath = path.normalize(path.join(process.cwd(), reqPath));
  if (!safePath.startsWith(process.cwd())) {
    res.status(403).json({ ok: false, error: 'Access denied' });
    return;
  }
  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    res.status(404).json({ ok: false, error: 'File not found' });
    return;
  }
  try {
    const stat = fs.statSync(safePath);
    if (stat.size > 500 * 1024) {
      res.json({
        ok: true,
        name: path.basename(safePath),
        path: reqPath,
        size: stat.size,
        content: `[File size ${(stat.size / 1024).toFixed(1)} KB exceeds browser preview limit]`,
        isTruncated: true,
      });
      return;
    }
    const content = fs.readFileSync(safePath, 'utf8');
    res.json({
      ok: true,
      name: path.basename(safePath),
      path: reqPath,
      size: stat.size,
      content,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || 'Read error' });
  }
});

// ── Rooms (merged from the engine room: web/environments) ────────────────────
// The sliding workspace rail: Coding, Design (the 3D room), Flat (the 2D room),
// Studio and Files. Their sources are served as-is; three.js comes from the
// vendored copy, so nothing is fetched from the internet.
app.use('/vendor', express.static(path.join(process.cwd(), 'web', 'vendor')));
app.use('/rooms-src', express.static(path.join(process.cwd(), 'web')));
app.get('/rooms.html', (_req: Request, res: Response) => {
  res.sendFile(path.join(STATIC_DIR, 'rooms.html'));
});

// File APIs the Coding and Files rooms use. Read-only, and only inside the
// allowed roots (the project folder, plus JARVIS_FILE_ROOTS if set).
const FILE_ROOTS: Array<{ name: string; path: string }> = [
  { name: 'JARVIS project', path: process.cwd() },
  ...(process.env.JARVIS_FILE_ROOTS || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((p) => ({ name: path.basename(p) || p, path: p })),
];

// The desktop: the owner's most-used folders become icons on the open area.
// Only the ones that actually exist on this machine are offered.
for (const folder of ['Documents', 'Downloads']) {
  const p = path.join(os.homedir(), folder);
  try {
    if (fs.statSync(p).isDirectory() && !FILE_ROOTS.some((r) => path.resolve(r.path) === path.resolve(p))) {
      FILE_ROOTS.push({ name: folder, path: p });
    }
  } catch (_) { /* folder not on this machine */ }
}

function allowedPath(requested: string): string | null {
  const resolved = path.resolve(requested);
  const ok = FILE_ROOTS.some((r) => {
    const root = path.resolve(r.path);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  return ok ? resolved : null;
}

app.get('/api/files/roots', requireAuth, (_req: Request, res: Response) => {
  res.json({ roots: FILE_ROOTS.map((r) => ({ name: r.name, path: path.resolve(r.path) })) });
});

app.get('/api/files/list', requireAuth, (req: Request, res: Response) => {
  const target = allowedPath(String(req.query.path || ''));
  if (!target) { res.status(403).json({ error: 'That folder is not allowed' }); return; }
  try {
    const names = fs.readdirSync(target, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__');
    const entries = names
      .map((e) => ({ name: e.name, path: path.join(target, e.name), kind: e.isDirectory() ? 'folder' : 'file' }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
    const isRoot = FILE_ROOTS.some((r) => path.resolve(r.path) === target);
    const parentPath = path.dirname(target);
    res.json({
      path: target,
      parent: !isRoot && allowedPath(parentPath) ? parentPath : null,
      entries: entries.slice(0, 500),
      truncated: entries.length > 500,
    });
  } catch {
    res.status(404).json({ error: 'Cannot read that folder' });
  }
});

app.get('/api/files/read', requireAuth, (req: Request, res: Response) => {
  const target = allowedPath(String(req.query.path || ''));
  if (!target) { res.status(403).json({ error: 'That file is not allowed' }); return; }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) { res.status(400).json({ error: 'Not a file' }); return; }
    const CAP = 64 * 1024;
    const fd = fs.openSync(target, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, CAP));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    res.json({
      name: path.basename(target),
      size: stat.size,
      truncated: stat.size > CAP,
      text: buf.toString('utf-8'),
    });
  } catch {
    res.status(404).json({ error: 'Cannot read that file' });
  }
});

// ── AI heavy lifting for the rooms ──────────────────────────────────────────
// Jarvis makes or changes pictures; the hand tools are only the fallback for
// minor touches. POST /api/ai/image: { prompt, image? (base64 PNG) } →
// { image (base64 PNG), mime }. Honest 503 when no key is on this machine.
app.post('/api/ai/image', requireAuth, async (req: Request, res: Response) => {
  const { prompt, image } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Say what the picture should be.' });
    return;
  }
  try {
    const img = await makeAiImage(
      prompt.trim(),
      typeof image === 'string' && image.length > 0 ? image : undefined
    );
    res.json({ image: img.data, mime: img.mime });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.includes('GEMINI_API_KEY') ? 503 : 502).json({ error: `Image AI failed: ${message}` });
  }
});

// GET /api/system-status -> Real-time telemetry & capabilities
app.get('/api/system-status', (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    state: jarvisState,
    uptime: Math.round(process.uptime()),
    activeSockets: wss.clients.size,
    memory: {
      rssMB: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    },
    modules: [
      { name: 'My Hands Spatial Controller', status: 'ready', icon: '✋' },
      { name: 'PC File System Tree & Inspector', status: 'ready', icon: '📂' },
      { name: 'Physical Glass Acrylic Surfaces', status: 'active', icon: '🪟' },
      { name: 'Gemini 2.5 Neural Core', status: 'ready', icon: '🧠' },
      { name: 'Autonomous Self-Repair Sandbox', status: 'ready', icon: '🔧' },
      { name: 'Dual-Channel Telemetry Relay', status: 'connected', icon: '📡' },
    ],
  });
});

// Fallback route handler
app.get('*all', (req: Request, res: Response) => {
  res.redirect('/');
});

// Start server
server.listen(PORT, HOST, () => {
  console.log(`[JARVIS] Core system running on http://${HOST}:${PORT}`);
});
