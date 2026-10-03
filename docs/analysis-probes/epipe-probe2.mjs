import { spawn } from 'node:child_process';
process.on('exit', (c) => console.log('process exit code', c));
// 子程序關閉 stdin 但仍存活（模擬 app-server 正在退出/stdin 已斷開），父程序繼續寫入
const child = spawn('node -e "process.stdin.destroy(); setTimeout(()=>{}, 1500)"', { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
setTimeout(() => {
  for (let i = 0; i < 5; i++) {
    const ok = child.stdin.write('x'.repeat(100000) + '\n');
    console.log('write', i, ok, 'writable=', child.stdin.writable);
  }
}, 700);
setTimeout(() => console.log('survived'), 2500);
