// 一次性:移除本轮用完的一次性诊断脚本
const fs = require('fs');
for (const f of ['tools/_catch-spawner.cjs', 'tools/_check-scan-lag.cjs', 'tools/_grep-serverspawn.cjs', 'tools/_probe-lag.cjs', 'tools/_cleanup-test-upload.cjs']) {
  fs.rmSync(f, { force: true });
}
console.log('cleaned');
