const state = { status: 'offline', parameters: {}, controlState: 'idle', car: {}, tasks: [], nextPendingId: null, logs: [], mqtt: {} };

const modalButtons = document.querySelectorAll('[data-modal]');
const modals = document.querySelectorAll('.modal');
const toastEl = document.getElementById('toast');
let isEditingParams = false;
let lastLogCount = 0;
let lastTaskSignature = '';
const taskScrollPositions = {};

modalButtons.forEach((btn) => {
  btn.addEventListener('click', () => openModal(btn.dataset.modal));
});

modals.forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal') || e.target.classList.contains('close')) {
      modal.style.display = 'none';
    }
  });
});

function openModal(id) {
  document.getElementById(id).style.display = 'flex';
  if (id === 'task-modal') renderTasks();
  if (id === 'log-modal') renderLogs();
  if (id === 'control-modal') renderControl();
  if (id === 'params-modal') fillParams();
  if (id === 'mqtt-modal') { loadMqtt(); fillMqtt(); }
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2000);
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    Object.assign(state, data);
    updateStatus();
    updateCarStats();
    updateMqttBadge();
    if (document.getElementById('task-modal').style.display === 'flex') renderTasks();
    if (document.getElementById('log-modal').style.display === 'flex') renderLogs();
    if (document.getElementById('control-modal').style.display === 'flex') renderControl();
    if (document.getElementById('params-modal').style.display === 'flex') fillParams();
    if (document.getElementById('mqtt-modal').style.display === 'flex') fillMqtt();
  } catch (err) {
    console.error(err);
  }
}

function updateStatus() {
  const statusEl = document.getElementById('online-status');
  statusEl.textContent = `小车状态：${state.status === 'online' ? '在线' : '离线'}`;
  statusEl.classList.toggle('online', state.status === 'online');
  statusEl.classList.toggle('offline', state.status !== 'online');
}

function updateCarStats() {
  document.getElementById('car-speed').textContent = `${(state.car.spe || 0).toFixed ? state.car.spe.toFixed(1) : state.car.spe || 0} km/h`;
  document.getElementById('car-distance').textContent = state.car.disLabel || 'DK000+000.00';
  document.getElementById('car-uptime').textContent = state.car.uptime || '00时00分00秒';
  document.getElementById('car-dn').textContent = state.car.dn ?? 0;
  document.getElementById('car-sn').textContent = state.car.sn ?? 0;
}

function updateMqttBadge() {
  const pills = document.querySelectorAll('[data-mqtt-pill]');
  if (!pills.length) return;
  const connected = state.mqtt && state.mqtt.connected;
  pills.forEach((pill) => {
    pill.textContent = connected ? 'MQTT 已连接' : 'MQTT 未连接';
    pill.classList.toggle('online', connected);
    pill.classList.toggle('offline', !connected);
  });
}

function fillParams() {
  const sideInput = document.getElementById('input-side');
  const numInput = document.getElementById('input-num');
  const lockBtn = document.getElementById('lock-button');
  const locked = state.parameters.locked;

  if (!locked && !isEditingParams) {
    sideInput.value = state.parameters.side ?? '';
    numInput.value = state.parameters.num ?? '';
  }
  if (locked) {
    // 强制同步锁定态
    sideInput.value = state.parameters.side ?? '';
    numInput.value = state.parameters.num ?? '';
    isEditingParams = false;
  }
  if (state.parameters.locked) {
    sideInput.disabled = true;
    numInput.disabled = true;
    lockBtn.textContent = '解锁';
    lockBtn.classList.add('secondary');
  } else {
    sideInput.disabled = false;
    numInput.disabled = false;
    lockBtn.textContent = '锁定并发送';
    lockBtn.classList.remove('secondary');
  }
}

document.getElementById('lock-button').addEventListener('click', async () => {
  const lockBtn = document.getElementById('lock-button');
  if (state.parameters.locked) {
    const res = await postJSON('/api/parameters/unlock', {});
    if (res.error) return showToast(res.error);
  } else {
    if (state.status !== 'online') {
      return showToast('小车未在线，无法设置参数');
    }
    const side = Number(document.getElementById('input-side').value);
    const num = Number(document.getElementById('input-num').value);
    const res = await postJSON('/api/parameters/lock', { side, num });
    if (res.error) return showToast(res.error);
  }
  await fetchState();
});

['input-side', 'input-num'].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener('focus', () => {
    isEditingParams = true;
  });
  el.addEventListener('blur', () => {
    // 离开输入框时允许下一次轮询同步最新数据
    isEditingParams = false;
  });
});

document.getElementById('mqtt-save').addEventListener('click', async () => {
  const host = document.getElementById('mqtt-host').value.trim();
  const port = Number(document.getElementById('mqtt-port').value);
  const username = document.getElementById('mqtt-user').value;
  const password = document.getElementById('mqtt-pass').value;
  const topicsRaw = document.getElementById('mqtt-topics').value || '';
  const topics = topicsRaw.split(',').map((t) => t.trim()).filter(Boolean);
  const res = await postJSON('/api/mqtt', { host, port, username, password, topics });
  if (res.error) return showToast(res.error);
  Object.assign(state, res);
  updateMqttBadge();
  fillMqtt();
  showToast('MQTT 配置已保存，正在重连');
});

async function renderControl() {
  const container = document.getElementById('control-body');
  container.innerHTML = '';
  const statusRow = document.createElement('p');
  statusRow.textContent = `当前状态：${state.controlState === 'idle' ? '空闲/开始' : state.controlState === 'running' ? '运行中' : '暂停'}`;
  container.appendChild(statusRow);

  const actions = document.createElement('div');
  actions.className = 'control-actions';

  const buildButton = (text, cls, handler) => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.className = `primary ${cls || ''}`.trim();
    btn.onclick = handler;
    return btn;
  };

  if (state.controlState === 'idle') {
    actions.appendChild(buildButton('开始', '', async () => {
      const res = await postJSON('/api/control/start', {});
      if (res.error) return showToast(res.error);
      await fetchState();
    }));
  } else if (state.controlState === 'running') {
    actions.appendChild(buildButton('暂停', 'secondary', async () => {
      await postJSON('/api/control/stop', {});
      await fetchState();
    }));
  } else if (state.controlState === 'paused') {
    actions.appendChild(buildButton('继续', '', async () => {
      await postJSON('/api/control/continue', {});
      await fetchState();
    }));
    actions.appendChild(buildButton('结束', 'danger', async () => {
      await postJSON('/api/control/over', {});
      await fetchState();
    }));
  }
  container.appendChild(actions);
}

async function loadMqtt() {
  try {
    const res = await fetch('/api/mqtt');
    const data = await res.json();
    state.mqtt = { ...data.config, connected: data.connected };
    fillMqtt();
  } catch (err) {
    console.error(err);
  }
}

function fillMqtt() {
  document.getElementById('mqtt-host').value = state.mqtt.host || '';
  document.getElementById('mqtt-port').value = state.mqtt.port || '';
  document.getElementById('mqtt-user').value = state.mqtt.username || '';
  document.getElementById('mqtt-pass').value = state.mqtt.password || '';
  document.getElementById('mqtt-topics').value = Array.isArray(state.mqtt.topics) ? state.mqtt.topics.join(',') : 'status,car,task';
  updateMqttBadge();
}

function renderTasks() {
  const body = document.getElementById('task-body');
  const signature = JSON.stringify({
    tasks: state.tasks.map((t) => ({ id: t.id, span: t.span, delta: t.delta, positions: t.positions, error: t.error })),
    next: state.nextPendingId
  });

  if (signature === lastTaskSignature && body.querySelector('.task-card')) return;

  body.querySelectorAll('.scale-line').forEach((line) => {
    if (line.dataset.taskId) taskScrollPositions[line.dataset.taskId] = line.scrollLeft;
  });

  body.innerHTML = '';
  const hasTasks = Array.isArray(state.tasks) && state.tasks.length > 0;
  const hasPending = Boolean(state.nextPendingId);

  if (!hasTasks && !hasPending) {
    body.innerHTML = '<p>任务未开始</p>';
    lastTaskSignature = signature;
    return;
  }

  state.tasks.forEach((task) => {
    const card = document.createElement('div');
    card.className = 'task-card';
    const deltaLabel = task.delta ? `${task.delta.toFixed(2)}m` : '—';
    card.innerHTML = `
      <div class="task-header">跨${task.id}：<span class="task-sub">跨距：${task.span.toFixed(2)}m</span><span class="task-sub">中间吊弦距离：${deltaLabel}</span></div>
      <div class="task-sub">参数：侧距=${task.side ?? '—'}cm，总吊弦数=${task.num ?? '—'}</div>
    `;
    if (task.error) {
      const err = document.createElement('div');
      err.className = 'task-error';
      err.textContent = task.error;
      card.appendChild(err);
    } else {
      const line = document.createElement('div');
      line.className = 'scale-line';
      line.dataset.taskId = task.id;
      const ticks = document.createElement('div');
      ticks.className = 'ticks';
      task.positions.forEach((pos, idx) => {
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.innerHTML = `<span>${pos.toFixed(2)}</span>`;
        ticks.appendChild(tick);
      });
      line.appendChild(ticks);
      card.appendChild(line);
      if (taskScrollPositions[task.id] !== undefined) {
        line.scrollLeft = taskScrollPositions[task.id];
      }
    }
    body.appendChild(card);
  });

  if (hasPending) {
    const pending = document.createElement('div');
    pending.className = 'task-card';
    pending.innerHTML = `
      <div class="task-header">跨${String(state.nextPendingId)}：<span class="task-sub">跨距：测量中···</span><span class="task-sub">中间吊弦位置：测量中···</span></div>
      <div class="task-sub">等待测量后显示形象图</div>
    `;
    body.appendChild(pending);
  }

  const history = document.createElement('div');
  history.className = 'history';
  history.innerHTML = '<h3>历史任务数据</h3>';
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>跨号</th><th>跨距(m)</th><th>侧距(cm)</th><th>总吊弦数</th><th>中间吊弦距离(m)</th><th>时间</th></tr></thead>';
  const tbody = document.createElement('tbody');
  state.tasks.forEach((task) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${task.id}</td><td>${task.span.toFixed(2)}</td><td>${task.side ?? '—'}</td><td>${task.num ?? '—'}</td><td>${task.delta ? task.delta.toFixed(2) : '—'}</td><td>${new Date(task.createdAt).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  history.appendChild(table);
  body.appendChild(history);

  lastTaskSignature = signature;
}

function renderLogs() {
  const body = document.getElementById('log-body');
  if (!state.logs) return;
  const previousList = body.querySelector('.log-list');
  const prevScroll = previousList ? previousList.scrollTop : 0;

  body.innerHTML = '';

  const actionRow = document.createElement('div');
  actionRow.className = 'log-actions';
  const mqttBtn = document.createElement('button');
  mqttBtn.className = 'ghost-button';
  mqttBtn.textContent = 'MQTT 连接';
  mqttBtn.onclick = () => {
    openModal('mqtt-modal');
  };
  const pill = document.createElement('span');
  pill.dataset.mqttPill = 'true';
  pill.className = 'pill';
  pill.textContent = 'MQTT 未连接';
  actionRow.appendChild(mqttBtn);
  actionRow.appendChild(pill);
  body.appendChild(actionRow);

  const list = document.createElement('div');
  list.className = 'log-list';
  if (!state.logs || state.logs.length === 0) {
    list.innerHTML = '<p>暂无日志</p>';
  } else {
    state.logs.forEach((log) => {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.innerHTML = `<time>${new Date(log.timestamp).toLocaleString()}</time><div>${log.message}</div>`;
      list.appendChild(entry);
    });
  }
  body.appendChild(list);
  list.scrollTop = prevScroll;
  lastLogCount = state.logs.length;
  updateMqttBadge();
}

async function postJSON(url, data) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return res.json();
}

fetchState();
setInterval(fetchState, 1500);
