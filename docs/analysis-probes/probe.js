const { spawn } = require('child_process');
const [shell, mode, delay] = [process.argv[2]==='shell', process.argv[3], Number(process.argv[4]||500)];
const cmd = `node "${__dirname}\gc.js" ${mode}`;
const child = shell ? spawn(cmd, { shell: true, stdio: ['pipe','pipe','pipe'] }) : spawn('node', [__dirname + '\gc.js', mode], { stdio: ['pipe','pipe','pipe'] });
let exited = false; child.stderr.on('data', d => process.stdout.write('ERR:' + String(d).slice(0,200)));
child.on('exit', (c) => { exited = true; console.log('exit event', c); });
child.on('error', (e) => console.log('child error', e.message));
let n = 0;
const t = setInterval(() => {
  n++;
  if (exited || !child.stdin.writable) { console.log('guard hit at write', n, 'exited=', exited, 'writable=', child.stdin.writable); clearInterval(t); return; }
  child.stdin.write('{"id":1}\n');
  if (n > 60) { console.log('no error after', n, 'writes'); clearInterval(t); child.kill(); }
}, 50);
setTimeout(()=>{}, 5000);
