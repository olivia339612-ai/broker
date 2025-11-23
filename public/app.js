const state = { status: 'offline', parameters: {}, controlState: 'idle', car: {}, tasks: [], nextPendingId: null, logs: [] };

const modalButtons = document.querySelectorAll('[data-modal]');
const modals = document.querySelectorAll('.modal');
const toastEl = document.getElementById('toast');

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
    if (document.getElementById('task-modal').style.display === 'flex') renderTasks();
    if (document.getElementById('log-modal').style.display === 'flex') renderLogs();
    if (document.getElementById('control-modal').style.display === 'flex') renderControl();
    if (document.getElementById('params-modal').style.display === 'flex') fillParams();
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
  document.getElementById('car-uptime').textContent = state.car.uptime || '00h00m';
  document.getElementById('car-dn').textContent = state.car.dn ?? 0;
  document.getElementById('car-sn').textContent = state.car.sn ?? 0;
}

function fillParams() {
  const sideInput = document.getElementById('input-side');
  const unmInput = document.getElementById('input-unm');
  const lockBtn = document.getElementById('lock-button');
  sideInput.value = state.parameters.side ?? '';
  unmInput.value = state.parameters.unm ?? '';
  if (state.parameters.locked) {
    sideInput.disabled = true;
    unmInput.disabled = true;
    lockBtn.textContent = '解锁';
    lockBtn.classList.add('secondary');
  } else {
    sideInput.disabled = false;
    unmInput.disabled = false;
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
    const side = Number(document.getElementById('input-side').value);
    const unm = Number(document.getElementById('input-unm').value);
    const res = await postJSON('/api/parameters/lock', { side, unm });
    if (res.error) return showToast(res.error);
  }
  await fetchState();
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

function renderTasks() {
  const body = document.getElementById('task-body');
  body.innerHTML = '';
  if (!state.tasks || state.tasks.length === 0) {
    body.innerHTML = '<p>任务未开始</p>';
    return;
  }
  state.tasks.forEach((task) => {
    const card = document.createElement('div');
    card.className = 'task-card';
    const deltaLabel = task.delta ? `${task.delta.toFixed(2)}m` : '—';
    card.innerHTML = `
      <div class="task-header">跨${task.id}：<span class="task-sub">跨距：${task.span.toFixed(2)}m</span><span class="task-sub">中间吊弦距离：${deltaLabel}</span></div>
      <div class="task-sub">参数：side=${task.side ?? '—'}cm，unm=${task.unm ?? '—'}</div>
    `;
    if (task.error) {
      const err = document.createElement('div');
      err.className = 'task-error';
      err.textContent = task.error;
      card.appendChild(err);
    } else {
      const line = document.createElement('div');
      line.className = 'scale-line';
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
    }
    body.appendChild(card);
  });

  if (state.nextPendingId) {
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
  table.innerHTML = '<thead><tr><th>跨号</th><th>跨距(m)</th><th>side(cm)</th><th>unm</th><th>中间吊弦距离(m)</th><th>时间</th></tr></thead>';
  const tbody = document.createElement('tbody');
  state.tasks.forEach((task) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${task.id}</td><td>${task.span.toFixed(2)}</td><td>${task.side ?? '—'}</td><td>${task.unm ?? '—'}</td><td>${task.delta ? task.delta.toFixed(2) : '—'}</td><td>${new Date(task.createdAt).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  history.appendChild(table);
  body.appendChild(history);
}

function renderLogs() {
  const body = document.getElementById('log-body');
  body.innerHTML = '';
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
}

async function postJSON(url, data) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return res.json();
}

fetchState();
setInterval(fetchState, 1500);
