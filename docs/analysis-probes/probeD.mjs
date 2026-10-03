// D: 只在開頭寫一次（模擬 initialize），子程序不讀並退出；無 error 監聽
import { spawn } from 'node:child_process';
const cmd = process.argv[2];
const t0 = Date.now();
const child = spawn(cmd, { shell: true, stdio: ['pipe','pipe','pipe'] });
child.on('exit', (c) => console.log('exit at', Date.now()-t0, 'code', c));
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n');
process.on('exit', () => console.log('parent exit normally'));
