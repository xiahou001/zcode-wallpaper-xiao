// 打印 9222 的 /json/list(JSON)—— 长期工具(配合 CDP 验证脚本使用)
const http = require('http');
http.get({ host: '127.0.0.1', port: 9222, path: '/json/list', timeout: 3000 }, (r) => {
  let b = '';
  r.on('data', (c) => (b += c));
  r.on('end', () => console.log(b));
}).on('error', (e) => { console.log('[]'); process.stderr.write(String(e)); });
