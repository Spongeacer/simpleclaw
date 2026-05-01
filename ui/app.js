/**
 * SimpleClaw Chat UI — with real-time status tracking
 */

// ─── State ────────────────────────────────────────────────────────────────────

let ws = null;
let rpcId = 1;
let pending = new Map();
let streamCbs = new Map();
let sessionId = null;
let agentId = 'default';
let isConnected = false;

// ─── DOM ──────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const connBadge = $('connBadge');
const sessBadge = $('sessBadge');
const wsUrl = $('wsUrl');
const tokenInput = $('tokenInput');
const btnConnect = $('btnConnect');
const btnDisconnect = $('btnDisconnect');
const chatLog = $('chatLog');
const messageInput = $('messageInput');
const btnSend = $('btnSend');
const rawEvents = $('rawEvents');
const autoScrollCheck = $('autoScroll');
const eventsPanel = $('eventsPanel');
const eventsHeader = $('eventsHeader');

// ─── Events Log ───────────────────────────────────────────────────────────────

function logEvent(dir, data) {
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'event-line';
  const cls = dir === '→' ? 'dir-out' : dir === '←' ? 'dir-in' : 'err';
  line.innerHTML = `<span class="ts">${ts}</span><span class="${cls}">${dir}</span> ${JSON.stringify(data)}`;
  rawEvents.appendChild(line);
  if (autoScrollCheck.checked) rawEvents.scrollTop = rawEvents.scrollHeight;
}

$('btnClearEvents').onclick = () => { rawEvents.innerHTML = ''; };

let eventsCollapsed = true;
eventsPanel.classList.add('collapsed');
eventsHeader.querySelector('h3').textContent = '▶ Raw Events';
eventsHeader.onclick = (e) => {
  if (e.target.closest('button, input, label')) return;
  eventsCollapsed = !eventsCollapsed;
  eventsPanel.classList.toggle('collapsed', eventsCollapsed);
  eventsHeader.querySelector('h3').textContent = eventsCollapsed ? '▶ Raw Events' : '▼ Raw Events';
};

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setConnected(v) {
  isConnected = v;
  connBadge.textContent = v ? 'Online' : 'Offline';
  connBadge.className = 'badge ' + (v ? 'connected' : 'disconnected');
  btnConnect.disabled = v;
  btnDisconnect.disabled = !v;
  updateInputState();
}

function setSession(id) {
  sessionId = id || null;
  if (sessionId) {
    sessBadge.textContent = id.slice(0, 8);
    sessBadge.style.display = '';
  } else {
    sessBadge.style.display = 'none';
  }
  updateInputState();
}

function updateInputState() {
  messageInput.disabled = !isConnected;
  btnSend.disabled = !isConnected;
  if (!isConnected) {
    messageInput.placeholder = 'Connect to gateway to start...';
  } else if (!sessionId) {
    messageInput.placeholder = 'Type a message (session will auto-create)...';
  } else {
    messageInput.placeholder = 'Type a message...';
  }
}

function addMessage(html, role) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function addUser(text) {
  addMessage(`<div class="meta">You</div>${escapeHtml(text)}`, 'user');
}

function addSystem(text) {
  addMessage(escapeHtml(text), 'system');
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ─── Assistant Thread Builder ─────────────────────────────────────────────────

/**
 * Creates a rich assistant message container with:
 *   - status indicator (Waiting → Thinking → Tool → Done)
 *   - collapsible thinking chain
 *   - tool call / result log
 *   - streaming answer text
 */
function createAssistantThread() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `
    <div class="meta">Assistant</div>
    <div class="status-indicator">🔄 Waiting for API…</div>
    <div class="thinking-chain" style="display:none"></div>
    <div class="tool-chain"></div>
    <div class="answer-text"></div>
  `;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;

  const indicator = div.querySelector('.status-indicator');
  const thinkingChain = div.querySelector('.thinking-chain');
  const toolChain = div.querySelector('.tool-chain');
  const answerText = div.querySelector('.answer-text');

  return {
    div,
    indicator,
    thinkingChain,
    toolChain,
    answerText,
    setStatus(status, detail) {
      const map = {
        waiting:  '🔄 Waiting for API…',
        thinking: '🧠 Thinking…',
        tool:     '🔧 Calling tool…',
        result:   '📄 Processing result…',
        text:     '✏️ Generating answer…',
        done:     '✅ Done',
        error:    '❌ Error',
      };
      indicator.textContent = map[status] || status;
      if (detail) indicator.title = detail;
    },
    addThinking(text) {
      thinkingChain.style.display = '';
      const item = document.createElement('div');
      item.className = 'thinking-item';
      item.innerHTML = `<span class="thinking-icon">💭</span><span class="thinking-text">${escapeHtml(text)}</span>`;
      thinkingChain.appendChild(item);
      chatLog.scrollTop = chatLog.scrollHeight;
    },
    addToolCall(name, args) {
      const item = document.createElement('div');
      item.className = 'tool-call-item';
      item.innerHTML = `<span class="tool-icon">🔧</span><span class="tool-name">${escapeHtml(name)}</span><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
      toolChain.appendChild(item);
      chatLog.scrollTop = chatLog.scrollHeight;
    },
    addToolResult(output) {
      const item = document.createElement('div');
      item.className = 'tool-result-item';
      item.innerHTML = `<span class="tool-icon">📄</span><pre>${escapeHtml(String(output).slice(0, 800))}</pre>`;
      toolChain.appendChild(item);
      chatLog.scrollTop = chatLog.scrollHeight;
    },
    appendText(text) {
      answerText.textContent += text;
      chatLog.scrollTop = chatLog.scrollHeight;
    },
    finalize() {
      indicator.classList.add('done');
    },
  };
}

// ─── JSON-RPC ─────────────────────────────────────────────────────────────────

function sendReq(method, params) {
  return new Promise((resolve, reject) => {
    if (!isConnected) {
      reject(new Error('Not connected'));
      return;
    }
    const id = rpcId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(frame));
    logEvent('→', frame);
  });
}

function sendStream(method, params, onEvent) {
  return new Promise((resolve, reject) => {
    if (!isConnected) {
      reject(new Error('Not connected'));
      return;
    }
    const id = rpcId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    pending.set(id, { resolve, reject });
    streamCbs.set(id, onEvent);
    ws.send(JSON.stringify(frame));
    logEvent('→', frame);
  });
}

function handleFrame(frame) {
  logEvent('←', frame);

  // Streaming response
  if ('id' in frame && 'result' in frame) {
    const cb = streamCbs.get(frame.id);
    if (cb) {
      cb(frame.result);
      if (frame.result?.type === 'done') {
        streamCbs.delete(frame.id);
        const h = pending.get(frame.id);
        if (h) { pending.delete(frame.id); h.resolve(frame.result); }
      }
      return;
    }
    // Regular response
    const h = pending.get(frame.id);
    if (h) {
      pending.delete(frame.id);
      if (frame.error) h.reject(new Error(frame.error.message));
      else h.resolve(frame.result);
      return;
    }
  }

  // Error response
  if ('id' in frame && 'error' in frame) {
    const h = pending.get(frame.id);
    if (h) { pending.delete(frame.id); h.reject(new Error(frame.error.message)); }
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

btnConnect.onclick = () => {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const url = wsUrl.value.trim();
  ws = new WebSocket(url);

  ws.onopen = async () => {
    setConnected(true);
    try {
      const token = tokenInput.value.trim() || undefined;
      await sendReq('connect', { token, role: 'client', clientInfo: { name: 'web-ui', version: '0.1.0' } });
      addSystem('Connected to gateway');
    } catch (e) {
      addSystem('Auth error: ' + e.message);
    }
  };

  ws.onmessage = (ev) => {
    try { handleFrame(JSON.parse(ev.data)); }
    catch (e) { logEvent('✖', { parseError: String(e), raw: ev.data }); }
  };

  ws.onclose = () => {
    setConnected(false);
    setSession(null);
    addSystem('Disconnected');
  };

  ws.onerror = () => {
    addSystem('Connection error');
  };
};

btnDisconnect.onclick = () => { if (ws) ws.close(); };

// ─── Chat ─────────────────────────────────────────────────────────────────────

async function ensureSession() {
  if (sessionId) return;
  try {
    const res = await sendReq('sessions.create', { agentId });
    setSession(res.sessionId);
    addSystem(`Session ${res.sessionId.slice(0, 8)} created`);
  } catch (e) {
    throw new Error('Failed to create session: ' + e.message);
  }
}

async function doSend(text) {
  text = text.trim();
  if (!text) return;
  if (!isConnected) {
    addSystem('Not connected');
    return;
  }

  try { await ensureSession(); }
  catch (e) { addSystem(e.message); return; }

  addUser(text);
  messageInput.value = '';

  let thread = null;

  sendStream('chat.send', { sessionId, agentId, message: text }, (ev) => {
    switch (ev.type) {
      case 'thinking':
        if (!thread) thread = createAssistantThread();
        thread.setStatus('thinking');
        thread.addThinking(ev.text);
        break;
      case 'tool_call':
        if (!thread) thread = createAssistantThread();
        thread.setStatus('tool', ev.call.name);
        thread.addToolCall(ev.call.name, ev.call.arguments);
        break;
      case 'tool_result':
        if (!thread) thread = createAssistantThread();
        thread.setStatus('result');
        thread.addToolResult(ev.result.output);
        break;
      case 'text':
        if (!thread) thread = createAssistantThread();
        thread.setStatus('text');
        thread.appendText(ev.text);
        break;
      case 'done':
        if (thread) {
          thread.setStatus('done');
          thread.finalize();
        }
        thread = null;
        break;
      case 'error':
        if (thread) {
          thread.setStatus('error', ev.message);
          thread.finalize();
        }
        addSystem('Error: ' + ev.message);
        thread = null;
        break;
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }).catch(e => {
    addSystem('Chat error: ' + e.message);
  });
}

btnSend.onclick = () => doSend(messageInput.value);
messageInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend(messageInput.value);
  }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

updateInputState();
