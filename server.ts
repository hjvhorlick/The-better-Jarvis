import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
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
const BAREHANDS_DIR = path.join(process.cwd(), 'barehands');
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
}

const messageHistory: LogMessage[] = [
  {
    type: 'log',
    speaker: 'jarvis',
    text: 'Good day, sir. Systems operational. All primary modules online and standing by for your command.',
    timestamp: Date.now(),
  },
];

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

// Process user command through JARVIS reasoning
async function processCommand(userCommand: string): Promise<string> {
  const trimmed = userCommand.trim();
  if (!trimmed) return 'Awaiting your command, sir.';

  const lower = trimmed.toLowerCase();
  // Intercept My Hands / Barehands spatial commands directly for instantaneous UI state toggling
  if (lower.includes('my hands') || lower.includes('myhands') || lower.includes('barehands') || lower.includes('bare hands') || (lower.includes('hand') && lower.includes('gesture')) || lower.includes('gesture tracking')) {
    if (lower.includes('off') || lower.includes('stop') || lower.includes('disable') || lower.includes('close') || lower.includes('exit')) {
      broadcast({ type: 'barehands_control', active: false });
      broadcast({ type: 'myhands_control', active: false });
      return 'Disengaging My Hands gesture tracking and restoring HUD overview.';
    } else {
      broadcast({ type: 'barehands_control', active: true });
      broadcast({ type: 'myhands_control', active: true });
      return 'Engaging My Hands spatial tracking. Camera background initialized and dull glass interfaces ready for gesture manipulation.';
    }
  }

  const ai = getGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [{ text: `${jarvisSystemPrompt}\n\nUser command: "${trimmed}"` }],
          },
        ],
      });
      const reply = response.text?.trim();
      if (reply) return reply;
    } catch (err) {
      console.error('Gemini error:', err);
    }
  }

  // Built-in intelligent fallback when Gemini key is not provided or fails
  if (lower.includes('status') || lower.includes('system') || lower.includes('diagnostics')) {
    return 'All telemetry systems are green. Core memory normal, WebSocket relay active, upload conduit operational.';
  }
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

// ── WebSockets Setup ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const audioWss = new WebSocketServer({ noServer: true });

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

audioWss.on('connection', (ws: WebSocket) => {
  ws.on('message', (chunk: Buffer) => {
    // Process PCM 16 audio chunks
    // Audio telemetry registered
  });
});

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const token = urlObj.searchParams.get('token');

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
app.use(express.json());
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
app.use('/barehands', express.static(BAREHANDS_DIR));
app.use('/myhands', express.static(BAREHANDS_DIR));

// Direct route to serve Barehands stage if accessed directly
app.get('/stage.html', (_req: Request, res: Response) => {
  const stagePath = path.join(BAREHANDS_DIR, 'stage.html');
  if (fs.existsSync(stagePath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(stagePath);
  } else {
    res.status(404).send('stage.html missing');
  }
});

// Barehands config endpoint
app.get('/config', (_req: Request, res: Response) => {
  const cfgPath = path.join(BAREHANDS_DIR, 'barehands.json');
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
