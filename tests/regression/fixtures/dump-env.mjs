// 子程序夾具：把自己繼承到的全部環境變數寫進 argv[2] 指定的檔案（JSON）。
// 由 tests/regression/access-control.test.ts 用來斷言訪問令牌沒有被傳給 agent 子程序和測試程序。
import { writeFileSync } from 'node:fs';

const [target] = process.argv.slice(2);
if (!target) {
  process.stderr.write('usage: node dump-env.mjs <output.json>\n');
  process.exit(2);
}
writeFileSync(target, JSON.stringify(process.env));
