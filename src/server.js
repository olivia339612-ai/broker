const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const EventEmitter = require('events');

class SimpleMQTTClient extends EventEmitter {
  constructor(options) {
    super();
    this.host = options.host;
    this.port = options.port || 1883;
    this.username = options.username;
    this.password = options.password;
    this.clientId = options.clientId || `railcar-web-${Math.random().toString(16).slice(2, 8)}`;
    this.keepAlive = options.keepAlive || 60;
    this.socket = null;
    this.packetId = 1;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.topics = options.topics || [];
    this.lastPingLog = 0;
  }

  start() {
    this.connect();
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    this.emit('log', `尝试连接 MQTT：${this.host}:${this.port}`);
    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.sendConnect();
    });

    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (err) => {
      this.emit('log', `MQTT socket error: ${err.message}`);
      this.scheduleReconnect();
    });
    this.socket.on('close', () => {
      this.connected = false;
      clearInterval(this.keepAliveTimer);
      this.emit('log', 'MQTT connection closed');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  close() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepAliveTimer);
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  sendConnect() {
    const protocolName = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]); // "MQTT"
    const protocolLevel = Buffer.from([0x04]);
    let connectFlags = 0x02; // clean session
    if (this.username) connectFlags |= 0x80;
    if (this.password) connectFlags |= 0x40;
    const keepAlive = Buffer.alloc(2);
    keepAlive.writeUInt16BE(this.keepAlive);
    const payloadParts = [this.encodeString(this.clientId)];
    if (this.username) payloadParts.push(this.encodeString(this.username));
    if (this.password) payloadParts.push(this.encodeString(this.password));
    const payload = Buffer.concat(payloadParts);
    const variableHeader = Buffer.concat([protocolName, protocolLevel, Buffer.from([connectFlags]), keepAlive]);
    const fixedHeader = this.createFixedHeader(0x10, variableHeader.length + payload.length);
    this.socket.write(Buffer.concat([fixedHeader, variableHeader, payload]));
  }

  subscribe(topic) {
    const packetId = this.packetId++;
    const topicBuf = this.encodeString(topic);
    const payload = Buffer.concat([topicBuf, Buffer.from([0x00])]); // QoS 0
    const variableHeader = Buffer.alloc(2);
    variableHeader.writeUInt16BE(packetId);
    const fixedHeader = this.createFixedHeader(0x82, variableHeader.length + payload.length);
    this.socket.write(Buffer.concat([fixedHeader, variableHeader, payload]));
  }

  publish(topic, message) {
    if (!this.connected) {
      this.emit('log', 'MQTT publish skipped: not connected');
      return;
    }
    const topicBuf = this.encodeString(topic);
    const payload = Buffer.from(message);
    const fixedHeader = this.createFixedHeader(0x30, topicBuf.length + payload.length);
    this.socket.write(Buffer.concat([fixedHeader, topicBuf, payload]));
  }

  sendPing() {
    if (this.connected) {
      this.socket.write(Buffer.from([0xc0, 0x00]));
    }
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      if (this.buffer.length < 2) return;
      const header = this.buffer[0];
      const { value: remainingLength, bytes: lenBytes } = this.decodeRemainingLength(this.buffer.slice(1));
      const totalLength = 1 + lenBytes + remainingLength;
      if (this.buffer.length < totalLength) return;
      const packet = this.buffer.slice(0, totalLength);
      this.buffer = this.buffer.slice(totalLength);
      const packetType = header >> 4;
      if (packetType === 2) {
        // CONNACK
        this.connected = true;
        this.emit('log', 'MQTT connected');
        this.topics.forEach((t) => this.subscribe(t));
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = setInterval(() => this.sendPing(), Math.max(this.keepAlive * 500, 5000));
      } else if (packetType === 3) {
        // PUBLISH
        this.parsePublish(packet, lenBytes);
      } else if (packetType === 13) {
        const now = Date.now();
        if (now - this.lastPingLog > 60000) {
          this.lastPingLog = now;
          this.emit('log', 'MQTT ping response（连接正常）');
        }
      }
    }
  }

  parsePublish(packet, lenBytes) {
    const start = 1 + lenBytes;
    const topicLength = packet.readUInt16BE(start);
    const topic = packet.slice(start + 2, start + 2 + topicLength).toString();
    const payload = packet.slice(start + 2 + topicLength).toString();
    this.emit('message', topic, payload);
  }

  createFixedHeader(typeFlag, remainingLength) {
    const lenEncoded = this.encodeRemainingLength(remainingLength);
    return Buffer.concat([Buffer.from([typeFlag]), lenEncoded]);
  }

  encodeString(str) {
    const buf = Buffer.from(str);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(buf.length);
    return Buffer.concat([lenBuf, buf]);
  }

  encodeRemainingLength(length) {
    const parts = [];
    let x = length;
    do {
      let encodedByte = x % 128;
      x = Math.floor(x / 128);
      if (x > 0) encodedByte |= 128;
      parts.push(encodedByte);
    } while (x > 0);
    return Buffer.from(parts);
  }

  decodeRemainingLength(buffer) {
    let multiplier = 1;
    let value = 0;
    let bytes = 0;
    for (const byte of buffer) {
      bytes += 1;
      value += (byte & 127) * multiplier;
      if ((byte & 128) === 0) break;
      multiplier *= 128;
    }
    return { value, bytes };
  }
}

const state = {
  status: 'offline',
  parameters: { side: null, num: null, locked: false },
  controlState: 'idle',
  car: { spe: 0, dis: '00000000', dn: 0, sn: 0 },
  uptimeStart: null,
  tasks: [],
  nextPendingId: null,
  logs: []
};

const MAX_LOGS = 200;

function addLog(message) {
  const entry = { timestamp: new Date().toISOString(), message };
  state.logs.unshift(entry);
  if (state.logs.length > MAX_LOGS) state.logs.pop();
  console.log(`[LOG] ${entry.timestamp} ${message}`);
}

let mqttClient = null;
let mqttConfig = {
  host: process.env.MQTT_HOST || '124.222.86.236',
  port: Number(process.env.MQTT_PORT) || 1883,
  username: process.env.MQTT_USER || 'railcar',
  password: process.env.MQTT_PASSWORD || 'olivia167349@',
  keepAlive: Number(process.env.MQTT_KEEPALIVE) || 60,
  topics: (process.env.MQTT_TOPICS && process.env.MQTT_TOPICS.split(',')) || ['status', 'car', 'task']
};

function attachMqttClient(client) {
  client.on('log', addLog);
  client.on('message', (topic, payload) => {
    addLog(`MQTT message on ${topic}: ${payload}`);
    if (topic === 'status') handleStatusMessage(payload.trim());
    else if (topic === 'car') handleCarMessage(payload.trim());
    else if (topic === 'task') handleTaskMessage(payload.trim());
  });
  client.start();
}

function createMqttClient(options) {
  if (mqttClient) {
    try {
      mqttClient.removeAllListeners();
      mqttClient.close();
    } catch (err) {
      addLog(`关闭旧 MQTT 连接出错：${err.message}`);
    }
  }
  mqttClient = new SimpleMQTTClient(options);
  attachMqttClient(mqttClient);
}

createMqttClient(mqttConfig);

function handleStatusMessage(payload) {
  if (payload === '{online}') {
    state.status = 'online';
    state.uptimeStart = new Date();
  } else if (payload === '{offline}') {
    state.status = 'offline';
    state.uptimeStart = null;
  }
}

function parseKeyValuePayload(payload) {
  const clean = payload.replace(/[{}]/g, '');
  if (!clean) return {};
  return clean.split(';').reduce((acc, pair) => {
    if (!pair) return acc;
    const [k, v] = pair.split(':');
    if (k && v !== undefined) acc[k.trim()] = v.trim();
    return acc;
  }, {});
}

function handleCarMessage(payload) {
  const data = parseKeyValuePayload(payload);
  if (data.spe !== undefined) state.car.spe = parseFloat(data.spe) || 0;
  if (data.dis) state.car.dis = data.dis.padStart(8, '0');
  if (data.dn !== undefined) state.car.dn = Number(data.dn) || 0;
  if (data.sn !== undefined) state.car.sn = Number(data.sn) || 0;
}

function handleTaskMessage(payload) {
  const data = parseKeyValuePayload(payload);
  if (!data.ID || !data.span) return;
  if (!state.parameters.locked) {
    addLog('收到跨距数据但参数未锁定，已忽略展示');
    return;
  }
  const id = Number(data.ID);
  const span = Number(data.span);
  const record = buildTaskRecord(id, span);
  state.tasks.push(record);
  state.nextPendingId = state.controlState === 'idle' ? null : id + 1;
}

function buildTaskRecord(id, span) {
  const record = {
    id,
    span,
    side: state.parameters.side,
    num: state.parameters.num,
    delta: null,
    positions: [],
    status: 'done',
    createdAt: new Date().toISOString(),
    error: null
  };
  if (!state.parameters.locked || state.parameters.side === null || state.parameters.num === null) {
    record.error = '参数未锁定，无法计算吊弦位置';
    return record;
  }
  const D = state.parameters.side / 100;
  const n = state.parameters.num;
  if (n < 2) {
    record.error = '跨内总吊弦数无效（需≥2）';
    return record;
  }
  const L = span - 2 * D;
  if (L <= 0) {
    record.error = '跨距过小，无法生成吊弦位置';
    return record;
  }
  const delta = L / (n - 1);
  record.delta = delta;
  for (let i = 0; i < n; i += 1) {
    record.positions.push(Number((D + i * delta).toFixed(2)));
  }
  record.positions = [0, ...record.positions, Number((span).toFixed(2))];
  return record;
}

function formatDistance(dis) {
  const padded = (dis || '').toString().padStart(8, '0');
  const km = padded.slice(0, 3);
  const meters = padded.slice(3, 6);
  const cm = padded.slice(6, 8);
  return `DK${km}+${meters}.${cm}`;
}

function formatUptime() {
  if (!state.uptimeStart || state.status !== 'online') return '00时00分00秒';
  const diffMs = Date.now() - state.uptimeStart.getTime();
  const seconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, '0')}时${mins.toString().padStart(2, '0')}分${secs.toString().padStart(2, '0')}秒`;
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  res.writeHead(404);
  res.end('Not found');
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript'
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

function getStatePayload() {
  return {
    status: state.status,
    parameters: state.parameters,
    controlState: state.controlState,
    car: {
      ...state.car,
      disLabel: formatDistance(state.car.dis),
      uptime: formatUptime()
    },
    tasks: state.tasks,
    nextPendingId: state.nextPendingId,
    logs: state.logs,
    mqtt: {
      host: mqttConfig.host,
      port: mqttConfig.port,
      username: mqttConfig.username,
      password: mqttConfig.password,
      topics: mqttConfig.topics,
      connected: mqttClient ? mqttClient.connected : false
    }
  };
}

function handleApiRequest(req, res, body) {
  if (req.method === 'GET' && req.url === '/api/state') {
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'GET' && req.url === '/api/mqtt') {
    return jsonResponse(res, 200, {
      config: { host: mqttConfig.host, port: mqttConfig.port, username: mqttConfig.username, password: mqttConfig.password, topics: mqttConfig.topics },
      connected: mqttClient ? mqttClient.connected : false
    });
  }
  if (req.method === 'POST' && req.url === '/api/mqtt') {
    const host = (body.host || '').trim();
    const port = Number(body.port);
    const username = (body.username || '').trim();
    const password = (body.password || '').trim();
    let topics = Array.isArray(body.topics) ? body.topics.filter(Boolean) : mqttConfig.topics;
    if (!topics || topics.length === 0) topics = mqttConfig.topics;
    if (!host || Number.isNaN(port) || port <= 0) {
      return jsonResponse(res, 400, { error: 'MQTT 地址或端口无效' });
    }
    mqttConfig = { host, port, username, password, keepAlive: mqttConfig.keepAlive, topics };
    addLog(`切换 MQTT 服务器到 ${host}:${port}`);
    createMqttClient(mqttConfig);
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'POST' && req.url === '/api/parameters/lock') {
    if (state.status !== 'online') {
      return jsonResponse(res, 400, { error: '小车未在线，无法设置参数' });
    }
    const side = Number(body.side);
    const num = Number(body.num ?? body.unm);
    if (Number.isNaN(side) || side <= 0 || Number.isNaN(num) || num < 2) {
      return jsonResponse(res, 400, { error: '参数无效，请检查 side 与 num' });
    }
    state.parameters = { side, num, locked: true };
    mqttClient.publish('data', `{side:${side};num:${num}}`);
    addLog(`参数锁定并下发：side=${side}, num=${num}`);
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'POST' && req.url === '/api/parameters/unlock') {
    if (state.controlState !== 'idle') {
      return jsonResponse(res, 400, { error: '当前状态不可解锁，请先结束任务' });
    }
    state.parameters.locked = false;
    addLog('参数已解锁');
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'POST' && req.url === '/api/control/start') {
    if (!state.parameters.locked) return jsonResponse(res, 400, { error: '参数未锁定' });
    if (state.status !== 'online') return jsonResponse(res, 400, { error: '小车未在线' });
    state.controlState = 'running';
    state.nextPendingId = state.tasks.length > 0 ? state.tasks[state.tasks.length - 1].id + 1 : 1;
    mqttClient.publish('cmd', '{start}');
    addLog('发送开始命令');
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'POST' && req.url === '/api/control/stop') {
    state.controlState = 'paused';
    mqttClient.publish('cmd', '{stop}');
    addLog('发送暂停命令');
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'POST' && req.url === '/api/control/continue') {
    state.controlState = 'running';
    if (!state.nextPendingId) state.nextPendingId = state.tasks.length > 0 ? state.tasks[state.tasks.length - 1].id + 1 : 1;
    mqttClient.publish('cmd', '{con}');
    addLog('发送继续命令');
    return jsonResponse(res, 200, getStatePayload());
  }
  if (req.method === 'POST' && req.url === '/api/control/over') {
    state.controlState = 'idle';
    state.nextPendingId = null;
    mqttClient.publish('cmd', '{over}');
    addLog('发送结束命令');
    return jsonResponse(res, 200, getStatePayload());
  }
  return notFound(res);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.connection.destroy();
    });
    req.on('end', () => {
      let parsed = {};
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          return jsonResponse(res, 400, { error: '请求体必须是 JSON' });
        }
      }
      handleApiRequest(req, res, parsed);
    });
  } else {
    const filePath = req.url === '/' ? path.join(__dirname, '../public/index.html') : path.join(__dirname, '../public', req.url);
    sendFile(res, filePath);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
