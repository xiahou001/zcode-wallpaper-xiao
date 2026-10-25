// cdp-inject.mjs — 零改文件的壁纸注入(Chrome DevTools Protocol 轨道)。
//
// 为什么比 asar 补丁稳:
//   · 完全不碰 ZCode 安装文件:没有等长覆写、没有更新后被冲掉的补丁、
//     没有「未来 ZCode 开启 asar 完整性校验导致客户端拒绝启动」的风险;
//   · 注入经由 Electron 官方的 --remote-debugging-port,协议随版本稳定;
//   · 壁纸服务器常驻,顺带当注入器:发现目标就挂上,进程随时可重启。
//
// 机制:launch-zcode.vbs 给 ZCode 加 --remote-debugging-port=9333(只绑 127.0.0.1);
//   本模块轮询 /json/list,对每个匹配的页面目标建立 WebSocket(零依赖手写 WS 客户端),
//   Page.addScriptToEvaluateOnNewDocument 注册 bootstrap(每次新文档自动执行)+
//   Runtime.evaluate 立即补一次已加载的文档;连接保持长活(断开即注销,故不主动断)。
//
// 与 asar 轨道共存:bootstrap.js 有 __weWpBootstrapV2 幂等闸,双轨只生效一次。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_FILE = path.join(ROOT, 'public', 'bootstrap.js');

// ── 极简 WebSocket 客户端(只做 CDP 需要的:文本帧/分片/ping-pong/close)──
class Ws {
  constructor(url) { this.url = url; this.buf = Buffer.alloc(0); this.fragments = []; this.nextId = 1; this.pending = new Map(); this.onMessage = null; this.onClose = null; }
  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port: Number(u.port), path: u.pathname + u.search, headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
        },
      });
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('ws handshake timeout')); });
      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        socket.on('data', (d) => this._feed(d));
        socket.on('error', () => this._closed());
        socket.on('close', () => this._closed());
        resolve(this);
      });
      req.on('response', (res) => { res.resume(); reject(new Error('ws rejected ' + res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
  }
  _closed() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('ws closed'));
    this.pending.clear();
    if (this.onClose) { try { this.onClose(); } catch (e) {} }
  }
  _sendRaw(op, payload) {
    if (!this.socket || this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([header, mask, masked])); } catch (e) {}
  }
  sendText(str) { this._sendRaw(0x1, Buffer.from(str, 'utf8')); }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const r = this._parse();
      if (!r) break;
      const { op, payload, fin } = r;
      if (op === 0x9) { this._sendRaw(0xA, payload); continue; }        // ping → pong
      if (op === 0x8) { try { this.socket.end(); } catch (e) {} this._closed(); return; }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          if (op !== 0x0 || true) { if (this.onMessage) { try { this.onMessage(full.toString('utf8')); } catch (e) {} } }
        }
      }
    }
  }
  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; const big = b.readBigUInt64BE(2); if (big > BigInt(64 * 1024 * 1024)) { this._closed(); return null; } len = Number(big); off = 10; }
    let maskKey = null;
    if (masked) { if (b.length < off + 4) return null; maskKey = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = Buffer.from(b.subarray(off, off + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    this.buf = b.subarray(off + len);
    return { op, payload, fin };
  }
  call(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('ws closed'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sendText(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.socket && this.socket.end(); } catch (e) {} this._closed(); }
}

// ── 注入器:轮询目标 + 挂载 + 注册 bootstrap ──────────────────────────
export function startCdpInjector(opts = {}) {
  const port = Number(opts.port || 9333);
  const urlMatch = opts.urlMatch || ((t) => (t.url || '').startsWith('file:') && /index\.html/i.test(t.url || '') || (t.title || '') === 'ZCode');
  const pollMs = Number(opts.pollMs || 5000);
  const log = opts.log || (() => {});
  const targets = new Map();   // targetId -> ws
  let stopped = false;

  function bootstrapSource() {
    try { return fs.readFileSync(BOOTSTRAP_FILE, 'utf8'); } catch (e) { return ''; }
  }

  function listTargets() {
    return new Promise((resolve) => {
      const rq = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2500 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve([]); } });
      });
      rq.on('error', () => resolve([]));
      rq.on('timeout', () => { rq.destroy(); resolve([]); });
    });
  }

  async function attach(t) {
    if (!t.webSocketDebuggerUrl) return;
    let ws;
    try { ws = await new Ws(t.webSocketDebuggerUrl).connect(); } catch (e) { log('cdp-connect-fail ' + e.message); return; }
    targets.set(t.id, ws);
    ws.onClose = () => { targets.delete(t.id); };
    ws.onMessage = (txt) => {
      let m;
      try { m = JSON.parse(txt); } catch (e) { return; }
      if (m.id && ws.pending.has(m.id)) {
        const p = ws.pending.get(m.id);
        ws.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'cdp error'));
        else p.resolve(m.result);
      }
    };
    try {
      const src = bootstrapSource();
      if (!src) return;
      await ws.call('Page.enable');
      await ws.call('Page.addScriptToEvaluateOnNewDocument', { source: src });   // 未来的每次导航
      await ws.call('Runtime.evaluate', { expression: src });                     // 当前已加载的文档
      log('cdp-injected ' + (t.title || t.url || t.id).slice(0, 60));
    } catch (e) {
      log('cdp-inject-fail ' + e.message);
      ws.close();
    }
  }

  async function sweep() {
    if (stopped) return;
    const list = await listTargets();
    const seen = new Set();
    for (const t of list || []) {
      if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) continue;
      seen.add(t.id);
      if (targets.has(t.id)) continue;
      if (!urlMatch(t)) continue;
      attach(t);
    }
    for (const [id, ws] of targets) if (!seen.has(id)) { ws.close(); targets.delete(id); }
  }

  sweep();
  const timer = setInterval(sweep, pollMs);
  if (timer.unref) timer.unref();
  return {
    stop() { stopped = true; clearInterval(timer); for (const ws of targets.values()) ws.close(); },
    status() { return { port, attached: [...targets.keys()] }; },
  };
}
