const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, run_id TEXT, sequence INTEGER, timestamp INTEGER, type TEXT, severity TEXT, confidence TEXT, agent_id TEXT, session_id TEXT, data_json TEXT, UNIQUE(run_id, sequence));`);
const RUNS = Number(process.argv[2]||200), PER = Number(process.argv[3]||2000);
const ins = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const types=['tool.started','tool.completed','agent.message','model.turn.completed'];
db.exec('BEGIN'); (()=>{ for(let r=0;r<RUNS;r++) for(let s=1;s<=PER;s++){ const t=types[s%4]; const data = t==='tool.completed'? {toolCallId:'x'+s,toolName:'shell',exitCode:0,output:'x'.repeat(800),action:'shell completed'} : {text:'y'.repeat(200),action:'a'}; ins.run(`e${r}_${s}`,'p','t'+r,'r'+r,s,Date.now(),t,'info','confirmed','codex','s',JSON.stringify(data)); } })(); db.exec('COMMIT');
const q = db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC');
for (let i=0;i<3;i++){ const t0=Date.now(); let n=0; for(let r=0;r<RUNS;r++){ const rows=q.all('r'+r,0); for(const row of rows){ JSON.parse(row.data_json); n++; } } console.log(`${RUNS}x${PER}: ${n} rows in ${Date.now()-t0} ms`); }
