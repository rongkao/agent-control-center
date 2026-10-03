// A: shell:true 下孫程序關閉 stdin 但 cmd.exe 仍存活，父程序寫入
import { spawn } from 'node:child_process';
const child = spawn(`node -e "process.stdin.destroy(); setTimeout(()=>{},2500)"`, { shell: true, stdio: ['pipe','pipe','pipe'] });
let closed = false;
child.on('exit', (c) => { closed = true; console.log('exit', c); });
let n = 0;
const t = setInterval(() => {
  if (closed || !child.stdin.writable) { console.log('writes done, n=', n); clearInterval(t); return; }
  child.stdin.write('{"id":1,"result":{}}\n'); n++;
}, 50);
process.on('exit', () => console.log('parent exit normally'));
