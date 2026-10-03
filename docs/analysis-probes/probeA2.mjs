// A2: 記錄 stdin error 相對 exit 的時間
import { spawn } from 'node:child_process';
const t0 = Date.now();
const child = spawn(`node -e "process.stdin.destroy(); setTimeout(()=>{},1500)"`, { shell: true, stdio: ['pipe','pipe','pipe'] });
let closed = false;
child.stdin.on('error', (e) => console.log('stdin error at', Date.now()-t0, e.code, 'closed=', closed));
child.on('exit', (c) => { closed = true; console.log('exit at', Date.now()-t0); });
let n = 0;
const t = setInterval(() => {
  if (closed || !child.stdin.writable) { console.log('writes stop at', Date.now()-t0, 'n=', n); clearInterval(t); return; }
  child.stdin.write('{"id":1,"result":{}}\n'); n++;
}, 5);
