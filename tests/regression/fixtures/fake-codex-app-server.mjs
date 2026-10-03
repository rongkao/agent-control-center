// 子程序夾具：假的 `codex app-server`（P0-8）。
// 用法：node fake-codex-app-server.mjs <env-dump.json> [app-server]
// - 啟動時把自己繼承到的全部環境變數寫進 argv[2]（JSON），用來斷言 Codex 程序拿到的是白名單環境；
// - 之後按行 JSON 應答 adapter 用到的最小協議：initialize、thread/start、turn/start（立即完成這一輪）。
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [target] = process.argv.slice(2);
if (!target) {
  process.stderr.write('usage: node fake-codex-app-server.mjs <output.json>\n');
  process.exit(2);
}
writeFileSync(target, JSON.stringify(process.env));

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turns = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') send({ id, result: { userAgent: 'fake-app-server' } });
  else if (method === 'thread/start') send({ id, result: { thread: { id: 'fixture-thread', sessionId: 'fixture-thread' }, model: 'fake', cwd: params?.cwd ?? '.', approvalsReviewer: 'user' } });
  else if (method === 'turn/start') {
    const turnId = `fixture-turn-${++turns}`;
    send({ id, result: { turn: { id: turnId, status: 'inProgress', error: null, durationMs: null } } });
    send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', error: null, durationMs: null } } });
    send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed', error: null, durationMs: 1 } } });
  } else if (id !== undefined && method) send({ id, result: {} });
});
lines.on('close', () => process.exit(0));
