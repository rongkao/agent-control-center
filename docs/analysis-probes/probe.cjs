const { spawn, spawnSync } = require('node:child_process');
const t0 = Date.now();
const log = (m) => console.log(`+${Date.now()-t0}ms ${m}`);
const child = spawn('start /b node -e "setTimeout(()=>{},5000)" & exit 0', { shell: true, stdio: ['ignore','pipe','pipe'] });
child.stdout.on('data', ()=>{}); child.stderr.on('data', ()=>{});
child.on('exit', (c) => { log('exit '+c); setTimeout(() => { const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); log('taskkill status '+r.status); }, 500); });
child.on('close', (c) => log('close '+c));
