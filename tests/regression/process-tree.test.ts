import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BoundedOutput, LocalTestRunnerAdapter, decodeProcessOutput, quoteExecutable } from '@acc/adapters';
import { emitRecorder } from './fakes/event-waiter.js';

/**
 * P1-5：L-32（子程序輸出按塊解碼導致中文亂碼）、L-8（孫程序佔著管道時測試執行永遠不結束）、路徑含空格的可執行檔案。
 */

describe('L-32：子程序輸出解碼', () => {
  it('多位元組字元被拆在兩個資料塊之間時仍然解碼正確', () => {
    const bytes = Buffer.from('測試通過：全部 3 個用例', 'utf8');
    const out = new BoundedOutput(1024);
    // 在一個漢字的中間切開
    out.push(bytes.subarray(0, 4));
    out.push(bytes.subarray(4));
    expect(out.text()).toBe('測試通過：全部 3 個用例');
  });

  it('Windows 上不是合法 UTF-8 的輸出按 GBK（cp936）解碼', () => {
    // “測試失敗” 的 GBK 編碼
    const gbk = Buffer.from([0x9c, 0x79, 0xd4, 0x87, 0xca, 0xa7, 0x94, 0xa1]);
    expect(decodeProcessOutput(gbk, 'win32')).toBe('測試失敗');
  });

  it('尾部截斷切開開頭的多位元組字元時，丟掉殘缺的位元組而不是整段按亂碼處理', () => {
    const out = new BoundedOutput(8);
    out.push(Buffer.from('ab中文字', 'utf8'));
    const text = out.text();
    expect(text.endsWith('文字')).toBe(true);
    expect(text).not.toContain('\uFFFD');
  });
});

describe('路徑含空格的可執行檔案', () => {
  it('加引號；已有引號或沒有空格時保持原樣', () => {
    expect(quoteExecutable('C:\\Program Files\\codex\\codex.cmd')).toBe('"C:\\Program Files\\codex\\codex.cmd"');
    expect(quoteExecutable('"C:\\Program Files\\codex.cmd"')).toBe('"C:\\Program Files\\codex.cmd"');
    expect(quoteExecutable('codex')).toBe('codex');
  });
});

describe('L-8：孫程序佔著管道', () => {
  it('測試命令本身退出後，即使孫程序還佔著輸出管道，這一次執行也會結束並報告結果', async () => {
    // 孫程序會在這個目錄裡多活一會兒：不新建臨時目錄，免得清理時因為目錄被佔用而失敗
    const dir = tmpdir();
    // 父程序啟動一個繼承 stdout 的孫程序（睡 30 秒），列印它的 PID 後立刻以 0 退出
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'inherit'});c.unref();console.log('grandchild='+c.pid)";
    const command = `"${process.execPath}" -e "${script}"`;
    const adapter = new LocalTestRunnerAdapter({ defaultCwd: dir, log: () => undefined, timeoutMs: 60_000 });
    const rec = emitRecorder();
    const started = Date.now();
    await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', agentId: 'test', prompt: '', context: { testCommand: command } } as never, rec.emit);
    const done = await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    const elapsed = Date.now() - started;
    const pid = /grandchild=(\d+)/.exec(String(done.data.outputTail ?? ''))?.[1];
    if (pid) {
      try {
        process.kill(Number(pid));
      } catch {
        // 已經退出
      }
    }
    expect(done.data.testPassed).toBe(true);
    // 遠早於孫程序的 30 秒，也遠早於超時
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);
});
