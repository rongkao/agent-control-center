import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MergeError, cleanupTaskWorktree, createTaskWorktree, mergeTaskWorktree, previewWorktreeMerge } from '@acc/adapters';
import { EventBus, createRedactor, scanDiffForSecrets, type UnifiedEvent } from '@acc/core';

/**
 * P2-9 金鑰脫敏與合入前掃描：
 * - adapter 事件在唯一入口 createSink 脫敏：金鑰類環境變數的值精確替換，常見金鑰格式按規則替換；路徑等正常內容不變；
 * - 合入前掃描 diff 新增的行，發現疑似金鑰時預設拒絕，操作員確認後可以合入。
 */

// 拼接出來的假金鑰：原始碼裡不出現完整的金鑰格式
const FAKE_ANTHROPIC = ['sk-ant', 'api03', 'A'.repeat(40)].join('-');
const FAKE_GITHUB = `ghp_${'b'.repeat(36)}`;
const FAKE_AWS = `AKIA${'C'.repeat(16)}`;

describe('P2-9：脫敏', () => {
  it('環境變數的值精確替換，常見格式按規則替換，其餘內容不變', () => {
    const redact = createRedactor({
      env: { MY_SERVICE_TOKEN: 'tok-9f8e7d6c5b4a3210', HOME_PATH_KEY: 'C:\\Users\\me\\keys', SHORT_KEY: 'abc', PATH: 'C:\\Windows' },
      values: ['access-token-value-123'],
    });
    const input = {
      text: `token tok-9f8e7d6c5b4a3210 and ${FAKE_ANTHROPIC} and ${FAKE_GITHUB} key=${FAKE_AWS}`,
      nested: { list: ['access-token-value-123', 'C:\\Users\\me\\keys\\file.txt'] },
      count: 3,
    };
    const out = redact(input);
    expect(out.text).toBe('token [已遮蔽:MY_SERVICE_TOKEN] and [已遮蔽:Anthropic API key] and [已遮蔽:GitHub token] key=[已遮蔽:AWS access key]');
    expect(out.nested.list[0]).toBe('[已遮蔽]');
    // 像路徑的值不做精確替換
    expect(out.nested.list[1]).toBe('C:\\Users\\me\\keys\\file.txt');
    expect(out.count).toBe(3);
    // 不修改原物件；沒有變化時返回原物件
    expect(input.text).toContain('tok-9f8e7d6c5b4a3210');
    const clean = { a: 'hello', b: ['x'] };
    expect(redact(clean)).toBe(clean);
  });

  it('adapter 事件經過 createSink 時脫敏：落盤的和流式片段都看不到原文', async () => {
    const bus = new EventBus({ log: () => undefined, redact: createRedactor({ env: { OPENAI_API_KEY: 'zz-secret-value-0001' } }) });
    const persisted: UnifiedEvent[] = [];
    const streamed: UnifiedEvent[] = [];
    bus.subscribe((e) => void persisted.push(e), { phase: 'persist' });
    bus.subscribeEphemeral((e) => void streamed.push(e));
    const sink = bus.createSink({ projectId: 'p', taskId: 't', runId: 'r', agentId: 'claude' });
    await sink({ type: 'agent.message', sessionId: 's', data: { text: `the key is zz-secret-value-0001 / ${FAKE_ANTHROPIC}` } } as never);
    await sink({ type: 'agent.message', sessionId: 's', data: { ephemeral: true, delta: 'zz-secret-value-0001' } } as never);
    expect(JSON.stringify(persisted)).not.toContain('zz-secret-value-0001');
    expect(JSON.stringify(persisted)).not.toContain(FAKE_ANTHROPIC);
    expect(persisted[0]!.data.text).toBe('the key is [已遮蔽:OPENAI_API_KEY] / [已遮蔽:Anthropic API key]');
    expect(streamed[0]!.data.delta).toBe('[已遮蔽:OPENAI_API_KEY]');
  });

  it('diff 掃描只看新增的行，並給出檔案與行號', () => {
    const patch = [
      'diff --git a/config.js b/config.js',
      '--- a/config.js',
      '+++ b/config.js',
      '@@ -1,2 +1,3 @@',
      ` const old = '${FAKE_GITHUB}';`,
      `-const removed = '${FAKE_AWS}';`,
      '+const ok = 1;',
      `+const key = '${FAKE_ANTHROPIC}';`,
    ].join('\n');
    const findings = scanDiffForSecrets(patch);
    expect(findings).toEqual([{ rule: 'anthropic', name: 'Anthropic API key', path: 'config.js', line: 3, preview: 'sk-ant…' }]);
  });
});

describe('P2-9：合入前掃描', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      try {
        rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 忽略
      }
    }
  });

  it('新增內容裡有疑似金鑰：預覽列出來，合入預設拒絕，確認後可以合入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-secret-'));
    dirs.push(dir);
    execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'app.js'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'ignore' });
    const wt = await createTaskWorktree(dir, 'task-secret');
    mkdirSync(join(wt.path, 'src'));
    writeFileSync(join(wt.path, 'src', 'client.js'), `const a = 1;\nconst key = '${FAKE_ANTHROPIC}';\n`);

    const preview = await previewWorktreeMerge(wt);
    expect(preview.secrets).toEqual([expect.objectContaining({ rule: 'anthropic', path: 'src/client.js', line: 2 })]);
    const error = await mergeTaskWorktree(wt, 'merge', 'acc: t').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeError);
    expect((error as Error).message).toContain('src/client.js:2');
    // 主倉庫沒有被改動
    expect(execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);

    const merged = await mergeTaskWorktree(wt, 'merge', 'acc: t', { allowSecrets: true });
    expect(merged.files).toBe(1);
    await cleanupTaskWorktree(wt);
  }, 60_000);
});
