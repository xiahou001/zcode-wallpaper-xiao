// 一次性:逐页签点击并截图(点击走 CDP 页面内 JS,截图走 PrintWindow)
import { execFileSync } from 'child_process';
import http from 'node:http';
import crypto from 'node:crypto';
class Ws {
  constructor(url) { this.url = url; this.buf = Buffer.alloc(0); this.fragments = []; this.nextId = 1; this.pending = new Map(); this.onMessage = null; }
  connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({ host: '127.0.0.1', port: Number(u.port), path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 } });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('ws timeout')));
      req.on('upgrade', (res, socket) => { this.socket = socket; socket.on('data', (d) => this._feed(d)); resolve(this); });
      req.on('response', (res) => { res.resume(); reject(new Error('rejected ' + res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
  }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const r = this._parse(); if (!r) break;
      if (r.op === 0x9) { this._raw(0xA, r.payload); continue; }
      if (r.op === 0x8) return;
      if (r.op === 0x1 || r.op === 0x2 || r.op === 0x0) {
        this.fragments.push(r.payload);
        if (r.fin) { const full = Buffer.concat(this.fragments); this.fragments = []; if (this.onMessage) this.onMessage(full.toString('utf8')); }
      }
    }
  }
  _parse() {
    const b = this.buf; if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0; const op = b[0] & 0x0f; const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f; let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    let mk = null;
    if (masked) { if (b.length < off + 4) return null; mk = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mk) for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
    this.buf = b.subarray(off + len);
    return { op, payload, fin };
  }
  _raw(op, payload) {
    const len = payload.length; let header;
    if (len < 126) header = Buffer.from([0x80 | op, 0x80 | len]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    const mask = crypto.randomBytes(4); const m = Buffer.alloc(len);
    for (let i = 0; i < len; i++) m[i] = payload[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([header, mask, m])); } catch (e) {}
  }
  call(method, params, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this._raw(0x1, Buffer.from(JSON.stringify({ id, method, params: params || {} })));
    });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = JSON.parse(execFileSync('node', ['tools/cdp-list.cjs'], { encoding: 'utf8', timeout: 15000, cwd: 'D:/AI/zcode/.zcode/workspace/default/we-wallpaper' }));
const page = (Array.isArray(list) ? list : []).find((t) => String(t.url).includes('workbench'));
if (!page) { console.log('NO TARGET'); process.exit(1); }
const ws = await new Ws(page.webSocketDebuggerUrl).connect();
ws.onMessage = (txt) => {
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (m.id && ws.pending.has(m.id)) { const p = ws.pending.get(m.id); ws.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
const pages = ['wall', 'look', 'play', 'sys', 'ext', 'about'];
for (const p of pages) {
  await ws.call('Runtime.evaluate', { expression: `document.querySelector('.tabs button[data-page="${p}"]').click()` });
  await sleep(700);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/_capture-wb.ps1', p], { timeout: 30000, cwd: 'D:/AI/zcode/.zcode/workspace/default/we-wallpaper' });
}
console.log('all captured');
process.exit(0);
