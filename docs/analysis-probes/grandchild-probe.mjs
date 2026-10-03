import { spawn, spawnSync } from 'node:child_process';
// 模擬測試命令：啟動一個繼承 stdout 的後台孫程序（如測試里拉起的 dev server），自己立即退出
const cmd = `node -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{detached:true,stdio:'inherit'}).unref(); console.log('parent done')"`;
const t0 = Date.now();
const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(`[out +${Date.now()-t0}ms] ${d}`));
child.on('exit', (c) => console.log(`exit event +${Date.now()-t0}ms code=${c}`));
child.on('close', (c) => console.log(`close event +${Date.now()-t0}ms code=${c}`));
// 與 adapter 相同：超時後 taskkill /T /F
setTimeout(() => { const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf8' }); console.log(`taskkill +${Date.now()-t0}ms status=${r.status}`); }, 1000);
