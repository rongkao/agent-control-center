// W: 測量“管道已斷但 exit 未派發”的視窗寬度（模擬真實 codex 鏈：cmd -> node 包裝 -> node 孫程序(inherit)）
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const t0 = performance.now();
const inner = `node -e "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.stdin.resume();setTimeout(()=>process.exit(7),800)'],{stdio:'inherit'});c.on('exit',x=>process.exit(x))"`;
const child = spawn(inner, { shell: true, stdio: ['pipe','pipe','pipe'] });
let closed = false, firstFailIssued = null, lastOkIssued = null;
child.stdin.on('error', () => {});
child.on('exit', (c) => { closed = true; const te = performance.now()-t0; console.log(`exit=${te.toFixed(1)} firstFailIssued=${firstFailIssued?.toFixed(1)} lastOkIssued=${lastOkIssued?.toFixed(1)} window>=${(te-firstFailIssued).toFixed(1)}ms`); });
const tick = () => {
  if (closed || !child.stdin.writable) return;
  const ti = performance.now()-t0;
  child.stdin.write('x\n', (err) => { if (err) { if (firstFailIssued===null) firstFailIssued = ti; } else lastOkIssued = ti; });
  setImmediate(tick);
};
tick();
