import { spawn } from 'node:child_process';
process.on('exit', (c) => console.log('process exit code', c));
const child = spawn('node -e "process.exit(0)"', { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
let exited = false;
child.on('exit', () => { exited = true; console.log('child exit event'); });
// 模擬：子程序已死但 exit 事件尚未處理時寫入
const timer = setInterval(() => {
  try {
    const ok = child.stdin.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    console.log('write returned', ok, 'exited=', exited, 'writable=', child.stdin.writable);
  } catch (e) { console.log('sync throw', e.message); }
}, 30);
setTimeout(() => { clearInterval(timer); console.log('survived'); }, 1500);
