// 直接子程序（不經 shell）關閉 stdin 後父程序寫入
const { spawn } = require('child_process');
const path = require('path');
const child = spawn(process.execPath, [path.join(__dirname, 'child.js')], { stdio: ['pipe','pipe','pipe'] });
child.on('exit', (c) => console.log('exit', c));
setTimeout(() => { console.log('writable?', child.stdin.writable); child.stdin.write('x\n'); console.log('wrote'); }, 1000);
setTimeout(() => console.log('still alive'), 2500);
