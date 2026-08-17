/* DSH 手机遥控 —— 前端逻辑（原生 JS，无构建步骤） */
(() => {
  'use strict';

  // ================================================================ 工具
  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ================================================================ API
  async function api(method, payload) {
    const res = await fetch('/m/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload: payload ?? {} }),
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('未登录');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const msg = await res.json();
    if (msg.type !== 'server-response') throw new Error('响应格式异常');
    if (!msg.result.ok) {
      const e = msg.result.error;
      throw new Error(e?.message || e?.code || 'RPC 错误');
    }
    return msg.result.value;
  }

  async function respond(rpcId, value) {
    const res = await fetch('/m/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    });
    if (!res.ok) throw new Error('应答发送失败');
  }

  // ================================================================ Markdown 轻渲染
  function inline(s) {
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return s;
  }

  function md(text) {
    const lines = esc(text).split('\n');
    const out = [];
    let inCode = false;
    let listType = null;
    const closeList = () => {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    };
    for (const raw of lines) {
      if (/^```/.test(raw)) {
        if (!inCode) { closeList(); inCode = true; out.push('<pre><code>'); }
        else { inCode = false; out.push('</code></pre>'); }
        continue;
      }
      if (inCode) { out.push(raw); continue; }
      const h = raw.match(/^(#{1,6})\s+(.*)/);
      if (h) { closeList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
      const ul = raw.match(/^[-*]\s+(.*)/);
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${inline(ul[1])}</li>`); continue;
      }
      const ol = raw.match(/^\d+[.)]\s+(.*)/);
      if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${inline(ol[1])}</li>`); continue;
      }
      closeList();
      if (/^&gt;\s?/.test(raw)) { out.push(`<blockquote>${inline(raw.replace(/^&gt;\s?/, ''))}</blockquote>`); continue; }
      if (/^-{3,}$/.test(raw.trim())) { out.push('<hr>'); continue; }
      if (raw.trim() === '') { continue; }
      out.push(`<p>${inline(raw)}</p>`);
    }
    closeList();
    if (inCode) out.push('</code></pre>');
    return out.join('');
  }

  // ================================================================ 状态
  const state = {
    authed: false,
    sessions: [],
    activeId: null,
    activeTitle: '',
    items: [],        // 渲染项
    seenSeqs: new Set(),
    running: false,
    jobs: [],
    todos: [],
    pendingApprovals: new Map(), // approvalId -> frame
    pendingQuestions: new Map(), // rpcId -> frame
    retry: 0,
    replaying: false, // 历史重放中：先不逐条渲染，结束后一次性渲染
  };

  // ================================================================ 消息渲染
  const MAX_BLOCK_TEXT = 4000; // 单块文本上限
  function blocksText(blocks) {
    return (blocks || [])
      .map((b) => {
        switch (b?.type) {
          case 'text': return String(b.text ?? '').slice(0, MAX_BLOCK_TEXT);
          case 'reasoning': return '';
          case 'image': return '[图片]';
          case 'tool-call': return '';
          case 'tool-result': return blocksText(b.content);
          default: return '';
        }
      })
      .filter(Boolean)
      .join('\n');
  }

  function addItem(item) {
    state.items.push(item);
    if (!state.replaying) renderMessages();
  }

  // 渲染入口：历史重放期间跳过逐条渲染，结束后统一渲染
  function rerender() {
    if (!state.replaying) renderMessages();
  }

  function renderMessages() {
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = '';
    let lastWho = '';
    for (const it of state.items) {
      let el;
      if (it.kind === 'user') {
        el = document.createElement('div');
        el.className = 'msg user';
        const who = it.optimistic ? '发送中…' : '你';
        el.innerHTML = `<div class="who">${esc(who)} · ${fmtTime(it.time)}</div><div class="bubble">${esc(it.text)}</div>`;
      } else if (it.kind === 'assistant') {
        el = document.createElement('div');
        el.className = 'msg assistant';
        el.dataset.key = it.key;
        if (it.streaming) {
          const parts = [];
          if (it.thinking) parts.push(`<details class="thinking"><summary>思考中…</summary><div class="thinking-body">${esc(it.thinking)}</div></details>`);
          parts.push(`<div class="bubble">${esc(it.text) || '…'}</div>`);
          el.innerHTML = parts.join('');
        } else {
          const parts = [];
          if (it.thinking) parts.push(`<details class="thinking" open><summary>思考过程</summary><div class="thinking-body">${md(it.thinking)}</div></details>`);
          parts.push(`<div class="bubble">${md(it.text)}</div>`);
          el.innerHTML = parts.join('');
        }
        lastWho = 'assistant';
      } else if (it.kind === 'tool') {
        el = document.createElement('div');
        el.className = `tool-card ${it.state === 'running' ? 'waiting' : it.state === 'err' ? 'err' : 'ok'}`;
        el.dataset.key = it.key;
        const stateIcon = it.state === 'running' ? '<span class="spinner"></span>' : it.state === 'err' ? '❌' : '✅';
        el.innerHTML =
          `<div class="t-name">${stateIcon} <span>${esc(it.name)}</span></div>` +
          (it.argsText ? `<div class="t-args">${esc(it.argsText)}</div>` : '') +
          (it.preview ? `<div class="t-result">${esc(it.preview)}</div>` : '');
      } else if (it.kind === 'note') {
        el = document.createElement('div');
        el.className = `note ${it.err ? 'err' : ''}`;
        el.textContent = it.text;
      } else if (it.kind === 'typing') {
        el = document.createElement('div');
        el.className = 'typing';
        el.innerHTML = '<i></i><i></i><i></i>';
      }
      if (el) box.appendChild(el);
    }
    if (nearBottom || state.items.length <= 2) box.scrollTop = box.scrollHeight;
  }

  // 流式更新节流：chunk 事件可能非常多，合并 DOM 更新避免卡顿
  let streamTimer = null;
  let streamKeyPending = null;
  function scheduleStreamUpdate(key) {
    if (state.replaying) return;
    streamKeyPending = key;
    if (streamTimer) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      if (streamKeyPending) updateStreaming(streamKeyPending);
      streamKeyPending = null;
    }, 60);
  }

  function updateStreaming(key) {
    const el = document.querySelector(`.msg.assistant[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    const it = state.items.find((x) => x.key === key);
    if (!it) return;
    const parts = [];
    if (it.thinking) parts.push(`<details class="thinking"><summary>思考中…</summary><div class="thinking-body">${esc(it.thinking)}</div></details>`);
    parts.push(`<div class="bubble">${esc(it.text) || '…'}</div>`);
    el.innerHTML = parts.join('');
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 90) box.scrollTop = box.scrollHeight;
  }

  // ================================================================ 事件折叠
  function applyEvent(ev) {
    if (!ev || typeof ev.seq !== 'number') return;
    if (state.seenSeqs.has(ev.seq)) return;
    state.seenSeqs.add(ev.seq);
    // 重放历史时跳过流式分块：assistant/message 有最终全文，
    // chunk 只是过程数据（本会话一个回合就有上万个），跳过可避免卡顿
    if (state.replaying && ev.type === 'assistant/chunk') return;
    const d = ev.data || {};

    switch (ev.type) {
      case 'user/message': {
        // 事件 data 就是消息本体（含 content/source），不是 {message: ...}
        const text = blocksText(d.content);
        const src = d.source;
        const rpcId = src?.rpcId;
        if (rpcId) {
          const idx = state.items.findIndex((x) => x.optimisticRpcId === rpcId);
          if (idx >= 0) state.items.splice(idx, 1);
        }
        addItem({ kind: 'user', text: text || '(空消息)', time: ev.time });
        break;
      }
      case 'assistant/chunk': {
        const key = `a:${d.turn}:${d.step}`;
        let it = state.items.find((x) => x.key === key);
        if (!it) {
          it = { kind: 'assistant', key, text: '', thinking: '', streaming: true, time: ev.time };
          state.items.push(it);
          rerender();
        }
        const c = d.chunk || {};
        if (c.type === 'text-delta' && c.text) it.text = (it.text + c.text).slice(0, MAX_BLOCK_TEXT * 2);
        else if (c.type === 'reasoning-delta' && c.text) it.thinking = (it.thinking + c.text).slice(0, MAX_BLOCK_TEXT);
        else if (c.type === 'block-end') {
          // 累积到块结束：text 块直接取整块，避免只显示增量
          if (c.block?.type === 'text') it.text = String(c.block.text ?? '').slice(0, MAX_BLOCK_TEXT * 2);
          else if (c.block?.type === 'reasoning') it.thinking = String(c.block.text ?? '').slice(0, MAX_BLOCK_TEXT);
        }
        scheduleStreamUpdate(key);
        break;
      }
      case 'assistant/message': {
        const key = `a:${d.turn}:${d.step}`;
        const blocks = d.message?.content || [];
        let text = blocksText(blocks);
        if (text.length > 8000) text = text.slice(0, 8000) + '\n\n…（内容过长已截断，电脑端可看完整内容）';
        let thinking = blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text).filter(Boolean).join('\n');
        if (thinking.length > 4000) thinking = thinking.slice(0, 4000) + '\n…（思考过程过长已截断）';
        const it = state.items.find((x) => x.key === key);
        if (it) {
          it.text = text;
          it.thinking = thinking;
          it.streaming = false;
          it.time = ev.time;
        } else {
          state.items.push({ kind: 'assistant', key, text, thinking, streaming: false, time: ev.time });
        }
        rerender();
        break;
      }
      case 'tool/call': {
        let argsText = '';
        try {
          const parsed = JSON.parse(d.arguments);
          argsText = JSON.stringify(parsed, null, 1).slice(0, 400);
        } catch {
          argsText = String(d.arguments ?? '').slice(0, 400);
        }
        addItem({ kind: 'tool', key: `t:${d.callId}`, callId: d.callId, name: d.name, argsText, state: 'running', time: ev.time });
        break;
      }
      case 'tool/result': {
        const key = `t:${d.message?.toolCallId ?? d.callId}`;
        const it = state.items.find((x) => x.key === key);
        const isErr = !!(d.error || d.message?.content?.[0]?.isError);
        const preview = blocksText(d.message?.content).trim().slice(0, 400);
        if (it) {
          it.state = isErr ? 'err' : 'ok';
          it.preview = preview || (isErr ? `错误: ${d.error?.name ?? ''}` : '');
        } else {
          state.items.push({ kind: 'tool', key, name: '(工具)', state: isErr ? 'err' : 'ok', preview: preview.slice(0, 400), time: ev.time });
        }
        rerender();
        break;
      }
      case 'turn/start':
        state.running = true;
        state.items.push({ kind: 'typing' });
        rerender();
        renderTopbar();
        break;
      case 'turn/end': {
        state.running = false;
        const ti = state.items.findIndex((x) => x.kind === 'typing');
        if (ti >= 0) state.items.splice(ti, 1);
        const reason = d.reason;
        if (reason?.kind === 'error') {
          state.items.push({ kind: 'note', text: '⚠️ 执行出错: ' + (reason.error?.message ?? '未知错误'), err: true, time: ev.time });
        } else if (reason?.kind === 'aborted') {
          state.items.push({ kind: 'note', text: '⏹ 已停止', time: ev.time });
        }
        rerender();
        renderTopbar();
        break;
      }
      case 'todo/write':
        state.todos = d.todos || [];
        renderTodos();
        break;
      case 'session/title':
        if (d.title) {
          state.activeTitle = d.title;
          renderTopbar();
        }
        break;
      default:
        break;
    }
  }

  function applyFrame(method, payload) {
    if (method === 'session/event') {
      if (payload.sessionId === state.activeId) applyEvent(payload.event);
      return;
    }
    if (method === 'session/jobs') {
      if (payload.sessionId === state.activeId) {
        state.jobs = payload.jobs || [];
        renderJobs();
      }
      return;
    }
    if (method === 'approval/requested') {
      if (payload.sessionId === state.activeId) {
        state.pendingApprovals.set(payload.approvalId, { rpcId: frameRpcId, ...payload });
        showApprovalModal(state.pendingApprovals.get(payload.approvalId));
      }
      return;
    }
    if (method === 'approval/resolved') {
      state.pendingApprovals.delete(payload.approvalId);
      toast(payload.outcome === 'allowed-once' ? '✅ 已允许' : '🚫 已拒绝');
      return;
    }
    if (method === 'question/requested') {
      if (payload.sessionId === state.activeId) {
        state.pendingQuestions.set(frameRpcId, { rpcId: frameRpcId, ...payload });
        showQuestionsModal(state.pendingQuestions.get(frameRpcId));
      }
      return;
    }
    if (method === 'question/resolved') {
      state.pendingQuestions.delete(payload.questionRpcId);
      toast(payload.outcome === 'answered' ? '✅ 已回答' : '已取消');
      return;
    }
    if (method === 'stream/error') {
      toast('事件流错误: ' + (payload.error?.message ?? ''));
      return;
    }
  }

  // ================================================================ WebSocket 事件流
  let ws = null;

  function connectStream() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try {
      ws = new WebSocket(proto + location.host + '/m/events.mux');
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      state.retry = 0;
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.type !== 'server-request') return;
      frameRpcId = msg.rpcId;
      applyFrame(msg.method || msg.payload?.type, msg.payload);
    };
    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose 会随后触发 */ };
  }

  function scheduleReconnect() {
    if (!state.authed) return;
    state.retry = Math.min(state.retry + 1, 8);
    const delay = 1000 * state.retry;
    setTimeout(() => connectStream(), delay);
  }

  let frameRpcId = null;

  // ================================================================ 会话操作
  async function loadSessions() {
    try {
      const { items } = await api('session.list', {});
      state.sessions = items || [];
      renderSessions();
      return true;
    } catch (e) {
      $('#session-empty').textContent = '⚠️ 加载会话失败: ' + e.message;
      $('#session-empty').classList.remove('hidden');
      toast('加载会话失败: ' + e.message);
      return false;
    }
  }

  function sessionTitle(s) {
    const pv = s.projections?.values || {};
    return pv.title || pv['session/title'] || (s.cwd ? `📁 ${s.cwd}` : s.sessionId.slice(0, 8));
  }

  function renderSessions() {
    const ul = $('#session-list');
    ul.innerHTML = '';
    const list = state.sessions;
    $('#session-empty').classList.toggle('hidden', list.length > 0);
    for (const s of list) {
      const li = document.createElement('li');
      li.className = 'session-item';
      const meta = [
        s.running ? '<span class="badge running">● 运行中</span>' : '',
        s.blank ? '<span class="badge blank">空白</span>' : '',
        `<span class="badge">${s.sessionId.slice(0, 8)}</span>`,
      ].join('');
      li.innerHTML =
        `<div class="s-title">${esc(sessionTitle(s))}</div>` +
        `<div class="s-meta">${meta}</div>` +
        (s.cwd ? `<div class="s-cwd">${esc(s.cwd)}</div>` : '');
      li.addEventListener('click', () => openSession(s.sessionId));
      ul.appendChild(li);
    }
  }

  async function openSession(sessionId) {
    state.activeId = sessionId;
    state.activeTitle = '';
    state.items = [];
    state.seenSeqs = new Set();
    state.running = false;
    state.jobs = [];
    state.todos = [];
    const s = state.sessions.find((x) => x.sessionId === sessionId);
    if (s) state.activeTitle = sessionTitle(s);
    showChat();
    renderTopbar();
    // 批量重放历史：事件可能上万条，先静默折叠，最后一次性渲染
    state.replaying = true;
    try {
      const { events } = await api('session.history', { sessionId, maxMessages: 60 });
      // 重放时已跳过流式分块，剩下的事件很少；slice 仅作极端兜底
      for (const entry of (events || []).slice(-30000)) applyEvent(entry.event);
    } catch (e) {
      toast('加载历史失败: ' + e.message);
    } finally {
      state.replaying = false;
      renderMessages();
    }
    if (!ws) connectStream();
  }

  async function createSession(cwd) {
    try {
      const payload = {};
      if (cwd) payload.cwd = cwd;
      const { sessionId } = await api('session.create', payload);
      toast('会话已创建');
      await loadSessions();
      await openSession(sessionId);
    } catch (e) {
      toast('创建失败: ' + e.message);
    }
  }

  async function sendMessage() {
    const input = $('#input');
    const text = input.value.trim();
    if (!text || !state.activeId) return;
    input.value = '';
    input.style.height = 'auto';
    const rpcId = uuid();
    state.items.push({ kind: 'user', text, time: Date.now(), optimistic: true, optimisticRpcId: rpcId });
    renderMessages();
    try {
      await api('session.prompt', { sessionId: state.activeId, mode: 'queue', content: [{ type: 'text', text }] });
    } catch (e) {
      const idx = state.items.findIndex((x) => x.optimisticRpcId === rpcId);
      if (idx >= 0) state.items.splice(idx, 1);
      state.items.push({ kind: 'note', text: '⚠️ 发送失败: ' + e.message, err: true });
      renderMessages();
    }
  }

  async function stopSession() {
    if (!state.activeId) return;
    try {
      await api('session.cancel', { sessionId: state.activeId });
      toast('已发送停止指令');
    } catch (e) {
      toast('停止失败: ' + e.message);
    }
  }

  // ================================================================ 面板渲染
  function renderTopbar() {
    const title = $('#topbar-title');
    title.textContent = '';
    if (state.running) {
      const dot = document.createElement('span');
      dot.className = 'dot-running';
      title.appendChild(dot);
    }
    const text = state.activeId ? (state.activeTitle || state.activeId.slice(0, 8)) : '会话';
    title.appendChild(document.createTextNode(text));
    title.classList.toggle('chat', !!state.activeId);
    $('#btn-back').classList.toggle('hidden', !state.activeId);
    updateComposer();
  }

  // 发送按钮状态：空闲=发送图标；思考中=转圈（点击可打断）
  function updateComposer() {
    const btn = $('#btn-send');
    if (!btn) return;
    btn.classList.toggle('thinking', state.running);
    btn.title = state.running ? '停止生成（点击打断）' : '发送';
  }

  function renderJobs() {
    const bar = $('#jobs-bar');
    bar.innerHTML = '';
    if (!state.jobs.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    for (const j of state.jobs) {
      const chip = document.createElement('span');
      const done = j.status === 'completed' || j.status === 'killed' || j.status === 'failed';
      chip.className = 'job-chip' + (j.status === 'completed' ? ' done' : j.status === 'failed' ? ' fail' : '');
      const label = `${j.kind} · ${j.status}${j.detail ? ' ' + j.detail : ''}`;
      chip.innerHTML = `<span class="dot"></span><span class="j-label">${esc(j.label || label)}</span>`;
      if (done) {
        chip.title = label;
      } else {
        chip.title = label;
      }
      bar.appendChild(chip);
    }
  }

  function renderTodos() {
    const box = $('#todos');
    box.innerHTML = '';
    if (!state.todos.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const title = document.createElement('div');
    title.className = 'todo-title';
    title.textContent = '📋 任务清单';
    box.appendChild(title);
    for (const t of state.todos) {
      const div = document.createElement('div');
      div.className = `todo-item ${t.status}`;
      div.innerHTML = `<span class="t-dot"></span><span class="t-text">${esc(t.content)}</span>`;
      box.appendChild(div);
    }
  }

  // ================================================================ 视图切换
  function showLogin() {
    state.authed = false;
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
  }

  async function showApp() {
    state.authed = true;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    showSessions();
    const ok = await loadSessions();
    // 像电脑端一样：进来直接恢复最近的会话，看到历史对话
    if (ok) autoResume();
    connectStream();
  }

  // 自动打开最近更新且有内容的会话
  function autoResume() {
    const recents = state.sessions.filter((s) => !s.blank);
    if (!recents.length) return;
    recents.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    openSession(recents[0].sessionId);
  }

  function showSessions() {
    state.activeId = null;
    renderTopbar();
    $('#chat-view').classList.add('hidden');
    $('#sessions-view').classList.remove('hidden');
    $('#messages').innerHTML = '';
    renderJobs();
    renderTodos();
  }

  function showChat() {
    $('#sessions-view').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    $('#messages').innerHTML = '';
    $('#input').focus();
  }

  // ================================================================ 模态
  function modal(html) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal"><div class="modal-card">${html}</div></div>`;
    return root.querySelector('.modal');
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  function showApprovalModal(frame) {
    const m = modal(`
      <h3>🔐 需要你的批准</h3>
      <p class="m-sub">来自会话 ${esc(frame.sessionId.slice(0, 8))}</p>
      <div class="approval-tool">${esc(frame.toolName ?? '工具')}</div>
      ${frame.reason ? `<div class="approval-reason">${esc(frame.reason)}</div>` : ''}
      <p style="font-size:13px;color:var(--text-dim)">允许后本次操作会立即在你的电脑上执行。</p>
      <div class="m-actions">
        <button class="btn danger" id="ap-reject">拒绝</button>
        <button class="btn primary" id="ap-allow">允许一次</button>
      </div>
    `);
    m.querySelector('#ap-allow').addEventListener('click', async () => {
      closeModal();
      try {
        await respond(frame.rpcId, { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'allowed-once' });
      } catch (e) { toast('应答失败: ' + e.message); }
    });
    m.querySelector('#ap-reject').addEventListener('click', async () => {
      closeModal();
      try {
        await respond(frame.rpcId, { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'rejected' });
      } catch (e) { toast('应答失败: ' + e.message); }
    });
  }

  function showQuestionsModal(frame) {
    const questions = frame.questions || [];
    let html = `<h3>❓ 需要你回答</h3><p class="m-sub">来自会话 ${esc(frame.sessionId.slice(0, 8))}</p>`;
    const selections = {};
    questions.forEach((q, qi) => {
      selections[q.id] = { selected: new Set() };
      html += `<div class="q-item">`;
      if (q.header) html += `<div class="q-header">${esc(q.header)}</div>`;
      html += `<div class="q-text">${esc(q.question)}</div>`;
      if (q.detail) html += `<div class="q-detail">${esc(q.detail)}</div>`;
      for (const opt of q.options || []) {
        html += `<button class="opt" data-q="${esc(q.id)}" data-label="${esc(opt.label)}">${esc(opt.label)}${opt.description ? `<span class="opt-desc">${esc(opt.description)}</span>` : ''}</button>`;
      }
      if (q.multiSelect) {
        html += `<input class="q-custom" data-q="${esc(q.id)}" placeholder="自定义补充（可选）" />`;
      }
      html += `</div>`;
    });
    html += `<div class="m-actions"><button class="btn ghost" id="q-cancel">取消</button><button class="btn primary" id="q-ok">提交回答</button></div>`;
    const m = modal(html);

    // 单选：点击即选中该项；多选：切换
    m.querySelectorAll('.opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qid = btn.dataset.q;
        const sel = selections[qid].selected;
        if (questions.find((q) => q.id === qid)?.multiSelect) {
          if (sel.has(btn.dataset.label)) { sel.delete(btn.dataset.label); btn.style.opacity = '0.55'; }
          else { sel.add(btn.dataset.label); btn.style.opacity = '1'; }
        } else {
          sel.clear();
          sel.add(btn.dataset.label);
          m.querySelectorAll('.opt').forEach((b) => (b.style.opacity = b.dataset.q === qid && b.dataset.label === btn.dataset.label ? '1' : '0.55'));
        }
      });
    });

    m.querySelector('#q-cancel').addEventListener('click', async () => {
      closeModal();
      try {
        await respond(frame.rpcId, { sessionId: frame.sessionId, answer: { answers: [] } });
      } catch (e) { /* ignore */ }
    });
    m.querySelector('#q-ok').addEventListener('click', async () => {
      const answers = [];
      for (const q of questions) {
        const sel = selections[q.id];
        const customEl = m.querySelector(`.q-custom[data-q="${CSS.escape(q.id)}"]`);
        const item = { id: q.id, selected: [...sel.selected] };
        if (customEl && customEl.value.trim()) item.custom = customEl.value.trim();
        if (item.selected.length || item.custom) answers.push(item);
      }
      closeModal();
      try {
        await respond(frame.rpcId, { sessionId: frame.sessionId, answer: { answers } });
      } catch (e) { toast('应答失败: ' + e.message); }
    });
  }

  function showNewSessionModal() {
    const m = modal(`
      <h3>新建会话</h3>
      <p class="m-sub">DSH 会在你电脑上创建一个新的智能体会话</p>
      <input class="q-custom" id="ns-cwd" placeholder="工作目录（可选，留空用默认）" />
      <div class="m-actions">
        <button class="btn ghost" id="ns-cancel">取消</button>
        <button class="btn primary" id="ns-ok">创建</button>
      </div>
    `);
    m.querySelector('#ns-cancel').addEventListener('click', closeModal);
    m.querySelector('#ns-ok').addEventListener('click', () => {
      const cwd = m.querySelector('#ns-cwd').value.trim();
      closeModal();
      createSession(cwd);
    });
    setTimeout(() => m.querySelector('#ns-cwd').focus(), 50);
  }

  // ================================================================ 登录
  async function initAuth() {
    try {
      const res = await fetch('/m/api/auth');
      const data = await res.json();
      if (data.authed) showApp();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  // ================================================================ 事件绑定
  function bindUI() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-error');
      err.classList.add('hidden');
      try {
        const res = await fetch('/m/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: $('#login-password').value }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          $('#login-password').value = '';
          showApp();
        } else {
          err.textContent = data.error || '登录失败';
          err.classList.remove('hidden');
        }
      } catch (ex) {
        err.textContent = '网络错误: ' + ex.message;
        err.classList.remove('hidden');
      }
    });

    $('#btn-send').addEventListener('click', () => {
      if (state.running) stopSession();
      else sendMessage();
    });
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('#input').addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });

    $('#btn-back').addEventListener('click', showSessions);
    $('#btn-new-session').addEventListener('click', showNewSessionModal);

    $('#btn-menu').addEventListener('click', () => $('#menu-overlay').classList.remove('hidden'));
    $('#menu-close').addEventListener('click', () => $('#menu-overlay').classList.add('hidden'));
    $('#menu-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'menu-overlay') $('#menu-overlay').classList.add('hidden');
    });
    $('#menu-full').addEventListener('click', () => {
      $('#menu-overlay').classList.add('hidden');
      window.open('/?full=1', '_blank');
    });
    $('#menu-logout').addEventListener('click', async () => {
      $('#menu-overlay').classList.add('hidden');
      await fetch('/m/api/logout', { method: 'POST' });
      showLogin();
    });
  }

  // ================================================================ 启动
  bindUI();
  initAuth();
})();
