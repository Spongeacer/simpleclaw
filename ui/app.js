/**
 * SimpleClaw Web Console — Hermes-style agent UI
 * Pure vanilla JS. No build step.
 */

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  ws: null,
  rpcId: 1,
  pending: new Map(),
  streamCbs: new Map(),
  connected: false,
  connecting: false,
  currentSessionId: null,
  sessions: new Map(), // id -> { sessionId, agentId, turns, tokenCount, createdAt }
  agentId: 'default',
  tasks: [],
  activeThread: null,
};

// ─── Config (persisted) ───────────────────────────────────────────────────────

const cfg = {
  wsUrl: localStorage.getItem('sc_wsUrl') || 'ws://127.0.0.1:18789',
  token: localStorage.getItem('sc_token') || '',
  agentId: localStorage.getItem('sc_agentId') || 'default',
};

function saveCfg() {
  localStorage.setItem('sc_wsUrl', cfg.wsUrl);
  localStorage.setItem('sc_token', cfg.token);
  localStorage.setItem('sc_agentId', cfg.agentId);
}

// ─── DOM ──────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const dom = {
  overlay: $('overlay'),
  sidebar: $('sidebar'),
  main: $('main'),
  rightPanel: $('rightPanel'),
  sessionList: $('sessionList'),
  sessionCount: $('sessionCount'),
  connStatus: $('connStatus'),
  sessionName: $('sessionName'),
  sessionMeta: $('sessionMeta'),
  messages: $('messages'),
  welcome: $('welcome'),
  composer: $('composer'),
  messageInput: $('messageInput'),
  btnSend: $('btnSend'),
  btnNewSession: $('btnNewSession'),
  btnToggleSidebar: $('btnToggleSidebar'),
  btnToggleTasks: $('btnToggleTasks'),
  btnToggleRightPanel: $('btnToggleRightPanel'),
  btnSettings: $('btnSettings'),
  btnConnectWelcome: $('btnConnectWelcome'),
  btnNewSessionWelcome: $('btnNewSessionWelcome'),
  settingsModal: $('settingsModal'),
  settingsBackdrop: $('settingsBackdrop'),
  btnCloseSettings: $('btnCloseSettings'),
  wsUrl: $('wsUrl'),
  tokenInput: $('tokenInput'),
  agentIdInput: $('agentIdInput'),
  btnSaveConnect: $('btnSaveConnect'),
  btnDisconnect: $('btnDisconnect'),
  agentBadge: $('agentBadge'),
  tokenHint: $('tokenHint'),
  taskList: $('taskList'),
  btnRefreshTasks: $('btnRefreshTasks'),
  detailsBody: $('detailsBody'),
  taskModal: $('taskModal'),
  taskBackdrop: $('taskBackdrop'),
  btnCloseTask: $('btnCloseTask'),
  taskDetailBody: $('taskDetailBody'),
  questionModal: $('questionModal'),
  questionBackdrop: $('questionBackdrop'),
  questionBody: $('questionBody'),
  questionFooter: $('questionFooter'),
  btnSubmitAnswer: $('btnSubmitAnswer'),
};

// ─── Markdown renderer ────────────────────────────────────────────────────────

const markedOpts = {
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
};

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    const raw = marked.parse(text, markedOpts);
    // Wrap tables for scroll
    return raw.replace(/<table[\s\S]*?<\/table>/g, m => `<div style="overflow-x:auto">${m}</div>`);
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function highlightCode() {
  if (typeof hljs !== 'undefined') {
    requestAnimationFrame(() => {
      dom.messages.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
    });
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setConnStatus(status, detail) {
  const dot = dom.connStatus.querySelector('.dot');
  const label = dom.connStatus.querySelector('.label');
  dot.className = 'dot ' + status;
  label.textContent = detail || (status === 'online' ? 'Online' : status === 'connecting' ? 'Connecting…' : 'Offline');
  state.connected = status === 'online';
  state.connecting = status === 'connecting';
  updateInputState();
}

function updateInputState() {
  const ready = state.connected;
  dom.messageInput.disabled = !ready;
  dom.btnSend.disabled = !ready;
  dom.btnNewSession.disabled = !ready;
  dom.btnNewSessionWelcome.disabled = !ready;
  if (!ready) {
    dom.messageInput.placeholder = 'Connect to gateway to start…';
  } else if (!state.currentSessionId) {
    dom.messageInput.placeholder = 'Type a message (session auto-creates)…';
  } else {
    dom.messageInput.placeholder = 'Type a message…';
  }
}

function scrollToBottom() {
  const el = $('chatScroll');
  if (el) el.scrollTop = el.scrollHeight;
}

function hideWelcome() {
  dom.welcome.classList.add('hidden');
}

function showWelcome() {
  if (dom.messages.children.length === 0) {
    dom.welcome.classList.remove('hidden');
  }
}

// ─── Sidebar / Panels ─────────────────────────────────────────────────────────

function toggleSidebar(show) {
  dom.sidebar.classList.toggle('open', show);
  dom.overlay.classList.toggle('show', show);
}

function toggleRightPanel(show) {
  if (window.innerWidth <= 900) {
    dom.rightPanel.classList.toggle('open', show);
    dom.overlay.classList.toggle('show', show);
  }
}

dom.overlay.onclick = () => {
  toggleSidebar(false);
  toggleRightPanel(false);
};

dom.btnToggleSidebar.onclick = () => toggleSidebar(!dom.sidebar.classList.contains('open'));
dom.btnToggleRightPanel.onclick = () => toggleRightPanel(!dom.rightPanel.classList.contains('open'));
dom.btnToggleTasks.onclick = () => {
  // open right panel and switch to tasks tab
  if (window.innerWidth <= 900) toggleRightPanel(true);
  switchTab('tasks');
};

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
  };
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tasksPane').classList.toggle('active', tab === 'tasks');
  document.getElementById('detailsPane').classList.toggle('active', tab === 'details');
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(modal) { modal.classList.add('show'); }
function closeModal(modal) { modal.classList.remove('show'); }

dom.btnSettings.onclick = () => {
  dom.wsUrl.value = cfg.wsUrl;
  dom.tokenInput.value = cfg.token;
  dom.agentIdInput.value = cfg.agentId;
  openModal(dom.settingsModal);
};

dom.btnCloseSettings.onclick = () => closeModal(dom.settingsModal);
dom.settingsBackdrop.onclick = () => closeModal(dom.settingsModal);

dom.btnCloseTask.onclick = () => closeModal(dom.taskModal);
dom.taskBackdrop.onclick = () => closeModal(dom.taskModal);

// ─── JSON-RPC ─────────────────────────────────────────────────────────────────

function sendReq(method, params) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected'));
      return;
    }
    const id = state.rpcId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify(frame));
  });
}

function sendStream(method, params, onEvent) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected'));
      return;
    }
    const id = state.rpcId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    state.pending.set(id, { resolve, reject });
    state.streamCbs.set(id, onEvent);
    state.ws.send(JSON.stringify(frame));
  });
}

function handleFrame(frame) {
  // Streaming event
  if ('id' in frame && 'result' in frame) {
    const cb = state.streamCbs.get(frame.id);
    if (cb) {
      cb(frame.result);
      if (frame.result?.type === 'done' || frame.result?.type === 'error') {
        state.streamCbs.delete(frame.id);
        const h = state.pending.get(frame.id);
        if (h) { state.pending.delete(frame.id); h.resolve(frame.result); }
      }
      return;
    }
    const h = state.pending.get(frame.id);
    if (h) {
      state.pending.delete(frame.id);
      if (frame.error) h.reject(new Error(frame.error.message));
      else h.resolve(frame.result);
      return;
    }
  }
  // Error response
  if ('id' in frame && 'error' in frame) {
    const h = state.pending.get(frame.id);
    if (h) { state.pending.delete(frame.id); h.reject(new Error(frame.error.message)); }
  }
}

// ─── Connection ───────────────────────────────────────────────────────────────

async function doConnect() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }

  cfg.wsUrl = dom.wsUrl.value.trim();
  cfg.token = dom.tokenInput.value.trim();
  cfg.agentId = dom.agentIdInput.value.trim() || 'default';
  saveCfg();

  state.agentId = cfg.agentId;
  dom.agentBadge.textContent = state.agentId;

  setConnStatus('connecting', 'Connecting…');
  closeModal(dom.settingsModal);

  return new Promise((resolve) => {
    const ws = new WebSocket(cfg.wsUrl);
    state.ws = ws;

    ws.onopen = async () => {
      try {
        await sendReq('connect', {
          token: cfg.token || undefined,
          role: 'client',
          clientInfo: { name: 'simpleclaw-web', version: '0.2.0' }
        });
        setConnStatus('online', 'Online');
        addSystem('Connected to gateway');
        hideWelcome();
        refreshTasks();
        resolve(true);
      } catch (e) {
        setConnStatus('offline', 'Auth failed');
        addSystem('Auth failed: ' + e.message);
        ws.close();
        resolve(false);
      }
    };

    ws.onmessage = (ev) => {
      try { handleFrame(JSON.parse(ev.data)); }
      catch (e) { console.error('Frame parse error', e, ev.data); }
    };

    ws.onclose = () => {
      setConnStatus('offline', 'Offline');
      state.ws = null;
      state.currentSessionId = null;
      state.sessions.clear();
      refreshSessionList();
      updateSessionInfo();
      addSystem('Disconnected from gateway');
      showWelcome();
      resolve(false);
    };

    ws.onerror = () => {
      setConnStatus('offline', 'Error');
      addSystem('Connection error');
      resolve(false);
    };
  });
}

function doDisconnect() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  setConnStatus('offline', 'Offline');
  closeModal(dom.settingsModal);
}

dom.btnSaveConnect.onclick = doConnect;
dom.btnDisconnect.onclick = doDisconnect;
dom.btnConnectWelcome.onclick = () => dom.btnSettings.click();

// ─── Sessions ─────────────────────────────────────────────────────────────────

async function createSession(initialMessage) {
  if (!state.connected) return;
  try {
    const res = await sendReq('sessions.create', {
      agentId: state.agentId,
      initialMessage: initialMessage || undefined,
    });
    const sess = {
      sessionId: res.sessionId,
      agentId: res.agentId,
      turns: [],
      tokenCount: 0,
      createdAt: Date.now(),
    };
    state.sessions.set(res.sessionId, sess);
    state.currentSessionId = res.sessionId;
    refreshSessionList();
    updateSessionInfo();
    if (!initialMessage) addSystem(`Session ${res.sessionId.slice(0, 8)} created`);
    // If initialMessage was provided, it fires as a background task; switch to details
    switchTab('details');
    loadSessionDetails(res.sessionId);
    return res.sessionId;
  } catch (e) {
    addSystem('Failed to create session: ' + e.message);
    throw e;
  }
}

async function switchSession(sessionId) {
  if (!state.sessions.has(sessionId)) return;
  state.currentSessionId = sessionId;
  refreshSessionList();
  updateSessionInfo();
  dom.messages.innerHTML = '';
  hideWelcome();
  // Load turns from server
  try {
    const s = await sendReq('sessions.get', { sessionId });
    const sess = state.sessions.get(sessionId);
    if (sess) {
      sess.turns = s.turns || [];
      sess.tokenCount = s.tokenCount || 0;
    }
    renderTurns(s.turns || []);
    loadSessionDetails(sessionId);
  } catch (e) {
    addSystem('Failed to load session: ' + e.message);
  }
}

async function loadSessionDetails(sessionId) {
  const sess = state.sessions.get(sessionId);
  if (!sess) {
    dom.detailsBody.innerHTML = '<div class="empty-state">Session not found</div>';
    return;
  }
  dom.detailsBody.innerHTML = `
    <div class="field"><label>Session ID</label><div class="value">${escapeHtml(sess.sessionId)}</div></div>
    <div class="field"><label>Agent</label><div class="value">${escapeHtml(sess.agentId)}</div></div>
    <div class="field"><label>Turns</label><div class="value">${(sess.turns || []).length}</div></div>
    <div class="field"><label>Tokens</label><div class="value">${sess.tokenCount || 0}</div></div>
    <div class="field"><label>Created</label><div class="value">${new Date(sess.createdAt).toLocaleString()}</div></div>
  `;
}

function updateSessionInfo() {
  const sid = state.currentSessionId;
  if (!sid) {
    dom.sessionName.textContent = 'No session';
    dom.sessionMeta.textContent = state.connected ? 'Create or select a session' : 'Not connected';
    return;
  }
  const sess = state.sessions.get(sid);
  dom.sessionName.textContent = sid.slice(0, 8);
  dom.sessionMeta.textContent = sess
    ? `${sess.agentId} · ${(sess.turns || []).length} turns`
    : '—';
}

function refreshSessionList() {
  dom.sessionList.innerHTML = '';
  const items = Array.from(state.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
  dom.sessionCount.textContent = String(items.length);

  if (items.length === 0) {
    dom.sessionList.innerHTML = '<div class="empty-state">No sessions yet</div>';
    return;
  }

  for (const s of items) {
    const el = document.createElement('div');
    el.className = 'session-item' + (s.sessionId === state.currentSessionId ? ' active' : '');
    const firstUser = (s.turns || []).find(t => t.role === 'user');
    const preview = firstUser ? firstUser.content.slice(0, 40) : 'New session';
    el.innerHTML = `
      <div class="avatar">💬</div>
      <div class="info">
        <div class="name">${escapeHtml(s.sessionId.slice(0, 8))}</div>
        <div class="sub">${escapeHtml(preview)}${preview.length >= 40 ? '…' : ''}</div>
      </div>
      <button class="delete-btn" title="Forget">×</button>
    `;
    el.onclick = (e) => {
      if (e.target.closest('.delete-btn')) {
        e.stopPropagation();
        state.sessions.delete(s.sessionId);
        if (state.currentSessionId === s.sessionId) {
          state.currentSessionId = null;
          dom.messages.innerHTML = '';
          showWelcome();
        }
        refreshSessionList();
        updateSessionInfo();
      } else {
        switchSession(s.sessionId);
        if (window.innerWidth <= 680) toggleSidebar(false);
      }
    };
    dom.sessionList.appendChild(el);
  }
}

dom.btnNewSession.onclick = () => createSession();
dom.btnNewSessionWelcome.onclick = () => createSession();

// ─── Chat rendering ───────────────────────────────────────────────────────────

function addUserMessage(text) {
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'msg user';
  msg.innerHTML = `
    <div class="msg-avatar">👤</div>
    <div class="msg-body">
      <div class="msg-user-label">You</div>
      <div class="msg-bubble">${escapeHtml(text)}</div>
    </div>
  `;
  dom.messages.appendChild(msg);
  scrollToBottom();
}

function addSystem(text) {
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'msg system';
  msg.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  dom.messages.appendChild(msg);
  scrollToBottom();
}

function createAssistantThread() {
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.innerHTML = `
    <div class="msg-avatar">🦞</div>
    <div class="msg-body">
      <div class="status-pill">🔄 Waiting…</div>
      <div class="think-chain" style="display:none"></div>
      <div class="tool-chain"></div>
      <div class="answer-body"></div>
    </div>
  `;
  dom.messages.appendChild(msg);
  scrollToBottom();

  const pill = msg.querySelector('.status-pill');
  const thinkChain = msg.querySelector('.think-chain');
  const toolChain = msg.querySelector('.tool-chain');
  const answerBody = msg.querySelector('.answer-body');

  return {
    el: msg,
    setStatus(status, detail) {
      const map = {
        waiting: '🔄 Waiting…',
        thinking: '🧠 Thinking…',
        tool: '🔧 Using tool…',
        result: '📄 Processing…',
        text: '✏️ Answering…',
        done: '✅ Done',
        error: '❌ Error',
      };
      pill.textContent = (map[status] || status) + (detail ? ` · ${detail}` : '');
      if (status === 'done') pill.classList.add('done');
      if (status === 'error') pill.classList.add('error');
    },
    addThinking(text) {
      thinkChain.style.display = '';
      const item = document.createElement('div');
      item.className = 'think-item';
      item.textContent = text;
      thinkChain.appendChild(item);
      scrollToBottom();
    },
    addToolCall(name, args) {
      const item = document.createElement('div');
      item.className = 'tool-call';
      item.innerHTML = `<span class="tool-name">${escapeHtml(name)}</span><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
      toolChain.appendChild(item);
      scrollToBottom();
    },
    addToolResult(output) {
      const item = document.createElement('div');
      item.className = 'tool-result';
      item.innerHTML = `<span>📄</span><pre>${escapeHtml(String(output).slice(0, 600))}</pre>`;
      toolChain.appendChild(item);
      scrollToBottom();
    },
    appendText(text) {
      // Accumulate raw text, render markdown on done
      const raw = (answerBody.dataset.raw || '') + text;
      answerBody.dataset.raw = raw;
      answerBody.innerHTML = renderMarkdown(raw);
      highlightCode();
      scrollToBottom();
    },
    finalize() {
      pill.classList.add('done');
    },
  };
}

function renderTurns(turns) {
  for (const t of turns) {
    if (t.role === 'user') {
      addUserMessage(t.content);
    } else if (t.role === 'assistant') {
      const thread = createAssistantThread();
      thread.setStatus('done');
      thread.finalize();
      thread.el.querySelector('.answer-body').innerHTML = renderMarkdown(t.content);
    }
  }
  highlightCode();
  scrollToBottom();
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function ensureSession() {
  if (state.currentSessionId) return;
  await createSession();
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  if (!state.connected) { addSystem('Not connected'); return; }

  try { await ensureSession(); }
  catch (e) { addSystem(e.message); return; }

  addUserMessage(text);
  dom.messageInput.value = '';
  state.activeThread = null;

  // Track token count hint if available
  const sess = state.sessions.get(state.currentSessionId);
  if (sess) {
    sess.turns = sess.turns || [];
    sess.turns.push({ role: 'user', content: text });
  }

  sendStream('chat.send', {
    sessionId: state.currentSessionId,
    agentId: state.agentId,
    message: text,
  }, (ev) => {
    switch (ev.type) {
      case 'thinking': {
        if (!state.activeThread) state.activeThread = createAssistantThread();
        state.activeThread.setStatus('thinking');
        state.activeThread.addThinking(ev.text);
        break;
      }
      case 'tool_call': {
        if (!state.activeThread) state.activeThread = createAssistantThread();
        state.activeThread.setStatus('tool', ev.call?.name);
        state.activeThread.addToolCall(ev.call?.name || 'tool', ev.call?.arguments || {});
        break;
      }
      case 'tool_result': {
        if (!state.activeThread) state.activeThread = createAssistantThread();
        state.activeThread.setStatus('result');
        state.activeThread.addToolResult(ev.result?.output ?? ev.result);
        break;
      }
      case 'text': {
        if (!state.activeThread) state.activeThread = createAssistantThread();
        state.activeThread.setStatus('text');
        state.activeThread.appendText(ev.text);
        break;
      }
      case 'done': {
        if (state.activeThread) {
          state.activeThread.setStatus('done');
          state.activeThread.finalize();
        }
        state.activeThread = null;
        // Update session meta
        if (sess) {
          const ans = dom.messages.querySelectorAll('.msg.assistant');
          const last = ans[ans.length - 1];
          const raw = last?.querySelector('.answer-body')?.dataset?.raw || '';
          sess.turns.push({ role: 'assistant', content: raw });
        }
        updateSessionInfo();
        refreshSessionList();
        break;
      }
      case 'question': {
        if (!state.activeThread) state.activeThread = createAssistantThread();
        state.activeThread.setStatus('waiting', 'Waiting for your answer…');
        showQuestionModal(ev.questionId, ev.questions);
        break;
      }
      case 'error': {
        if (state.activeThread) {
          state.activeThread.setStatus('error', ev.message);
          state.activeThread.finalize();
        }
        state.activeThread = null;
        addSystem('Error: ' + ev.message);
        break;
      }
    }
    scrollToBottom();
  }).catch(e => {
    addSystem('Chat error: ' + e.message);
    state.activeThread = null;
  });
}

dom.btnSend.onclick = () => sendChat(dom.messageInput.value);
dom.messageInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat(dom.messageInput.value);
  }
};

// Auto-resize textarea
dom.messageInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

async function refreshTasks() {
  if (!state.connected) {
    dom.taskList.innerHTML = '<div class="empty-state">Offline</div>';
    return;
  }
  try {
    const list = await sendReq('tasks.list', { sessionId: state.currentSessionId });
    state.tasks = list || [];
    renderTaskList();
  } catch (e) {
    dom.taskList.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

function renderTaskList() {
  dom.taskList.innerHTML = '';
  const tasks = state.tasks;
  if (!tasks.length) {
    dom.taskList.innerHTML = '<div class="empty-state">No tasks</div>';
    return;
  }
  for (const t of tasks) {
    const card = document.createElement('div');
    card.className = 'task-card';
    const msg = t.message || t.params?.message || '—';
    const date = t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : '';
    card.innerHTML = `
      <div class="task-id">${escapeHtml(String(t.taskId).slice(0, 16))}</div>
      <div class="task-msg">${escapeHtml(msg)}</div>
      <div class="task-meta">
        <span class="task-status ${t.status}">${t.status}</span>
        <span class="task-time">${escapeHtml(date)}</span>
      </div>
    `;
    card.onclick = () => showTaskDetail(t.taskId);
    dom.taskList.appendChild(card);
  }
}

async function showTaskDetail(taskId) {
  openModal(dom.taskModal);
  dom.taskDetailBody.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const t = await sendReq('tasks.get', { taskId });
    dom.taskDetailBody.innerHTML = `
      <div class="field"><label>Task ID</label><div class="value">${escapeHtml(t.taskId)}</div></div>
      <div class="field"><label>Status</label><div class="value">${escapeHtml(t.status)}</div></div>
      <div class="field"><label>Created</label><div class="value">${t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}</div></div>
      <div class="field"><label>Started</label><div class="value">${t.startedAt ? new Date(t.startedAt).toLocaleString() : '—'}</div></div>
      <div class="field"><label>Completed</label><div class="value">${t.completedAt ? new Date(t.completedAt).toLocaleString() : '—'}</div></div>
      <div class="field"><label>Result</label><div class="value">${t.result ? escapeHtml(JSON.stringify(t.result, null, 2)) : '—'}</div></div>
      <div class="field"><label>Error</label><div class="value" style="color:${t.error ? 'var(--danger)' : 'inherit'}">${t.error ? escapeHtml(t.error) : '—'}</div></div>
      <div class="field"><label>Events</label><pre style="background:var(--bg-secondary);padding:10px;border-radius:6px;font-size:11px;max-height:300px;overflow:auto">${escapeHtml(JSON.stringify(t.events || [], null, 2))}</pre></div>
    `;
  } catch (e) {
    dom.taskDetailBody.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

dom.btnRefreshTasks.onclick = refreshTasks;

// Poll tasks every 5s when connected
setInterval(() => {
  if (state.connected) refreshTasks();
}, 5000);

// ─── Question Modal ───────────────────────────────────────────────────────────

let currentQuestionId = null;
let currentQuestionSelections = new Map(); // questionIndex -> Set of option indices

function showQuestionModal(questionId, questions) {
  currentQuestionId = questionId;
  currentQuestionSelections.clear();
  dom.questionBody.innerHTML = '';

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const qWrap = document.createElement('div');
    qWrap.className = 'question-block';
    qWrap.style.marginBottom = '16px';

    const qTitle = document.createElement('div');
    qTitle.className = 'question-title';
    qTitle.style.fontWeight = '600';
    qTitle.style.marginBottom = '8px';
    qTitle.textContent = `${qi + 1}. ${q.question}`;
    qWrap.appendChild(qTitle);

    const multi = !!q.multiSelect;
    // Clone + append implicit "Other" option so we don't mutate the API array
    const opts = [...(q.options || []), { label: 'Other', description: 'Provide your own answer' }];

    currentQuestionSelections.set(qi, multi ? new Set() : null);

    for (let oi = 0; oi < opts.length; oi++) {
      const opt = opts[oi];
      const btn = document.createElement('button');
      btn.className = 'question-option';
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.textAlign = 'left';
      btn.style.padding = '8px 12px';
      btn.style.marginBottom = '6px';
      btn.style.border = '1px solid var(--border)';
      btn.style.borderRadius = '6px';
      btn.style.background = 'var(--bg-secondary)';
      btn.style.cursor = 'pointer';
      btn.style.fontSize = '13px';

      const labelSpan = document.createElement('span');
      labelSpan.style.fontWeight = '500';
      labelSpan.textContent = opt.label;
      btn.appendChild(labelSpan);

      if (opt.description) {
        const descSpan = document.createElement('span');
        descSpan.style.display = 'block';
        descSpan.style.color = 'var(--text-secondary)';
        descSpan.style.fontSize = '12px';
        descSpan.style.marginTop = '2px';
        descSpan.textContent = opt.description;
        btn.appendChild(descSpan);
      }

      btn.onclick = () => {
        if (multi) {
          const sel = currentQuestionSelections.get(qi);
          if (sel.has(oi)) {
            sel.delete(oi);
            btn.style.borderColor = 'var(--border)';
            btn.style.background = 'var(--bg-secondary)';
          } else {
            sel.add(oi);
            btn.style.borderColor = 'var(--accent)';
            btn.style.background = 'rgba(59,130,246,0.08)';
          }
        } else {
          // Single-select: clear others in same question
          const siblings = qWrap.querySelectorAll('.question-option');
          siblings.forEach((s, idx) => {
            s.style.borderColor = 'var(--border)';
            s.style.background = 'var(--bg-secondary)';
          });
          btn.style.borderColor = 'var(--accent)';
          btn.style.background = 'rgba(59,130,246,0.08)';
          currentQuestionSelections.set(qi, oi);
        }
      };

      qWrap.appendChild(btn);
    }

    dom.questionBody.appendChild(qWrap);
  }

  dom.questionFooter.style.display = '';
  openModal(dom.questionModal);
}

dom.questionBackdrop.onclick = () => {
  // Prevent closing by backdrop — user must answer or the agent is stuck
};

dom.btnSubmitAnswer.onclick = async () => {
  if (!currentQuestionId) return;

  // Build answer string
  const parts = [];
  const questions = dom.questionBody.querySelectorAll('.question-block');
  questions.forEach((qWrap, qi) => {
    const sel = currentQuestionSelections.get(qi);
    const btns = qWrap.querySelectorAll('.question-option');
    const selectedLabels = [];

    if (sel instanceof Set) {
      sel.forEach((oi) => {
        if (btns[oi]) selectedLabels.push(btns[oi].querySelector('span').textContent);
      });
    } else if (typeof sel === 'number' && btns[sel]) {
      selectedLabels.push(btns[sel].querySelector('span').textContent);
    }

    if (selectedLabels.length === 0) {
      selectedLabels.push('(no selection)');
    }
    parts.push(`Q${qi + 1}: ${selectedLabels.join(', ')}`);
  });

  const answerText = parts.join('; ');

  try {
    await sendReq('question.answer', { questionId: currentQuestionId, answer: answerText });
    closeModal(dom.questionModal);
    currentQuestionId = null;
  } catch (e) {
    addSystem('Failed to submit answer: ' + e.message);
  }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  dom.wsUrl.value = cfg.wsUrl;
  dom.tokenInput.value = cfg.token;
  dom.agentIdInput.value = cfg.agentId;
  dom.agentBadge.textContent = cfg.agentId;
  updateInputState();
  showWelcome();

  // Try auto-connect if configured
  if (cfg.wsUrl) {
    // Optional: auto-connect on load (disabled to avoid noise; user clicks Connect)
  }
}

init();
