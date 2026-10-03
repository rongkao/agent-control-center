// 經 shell 啟動，整個程序樹退出前後持續寫入，模擬退出競態視窗
const { spawn } = require('child_process');
const path = require('path');
const child = spawn(`node "${path.join(__dirname, 'child3.js')}"`, { shell: true, stdio: ['pipe','pipe','pipe'] });
let closed = false; let writes = 0;
child.on('exit', (c) => { closed = true; console.log('exit', c, 'writes', writes); });
const tick = () => {
  if (closed || !child.stdin.writable) { console.log('stop: closed', closed, 'writable', child.stdin.writable); return; }
  child.stdin.write('{"id":1,"result":{}}\n'); writes++;
  setImmediate(tick);
};
setTimeout(tick, 300);
setTimeout(() => console.log('still alive at end'), 3000);
