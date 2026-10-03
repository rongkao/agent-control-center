import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';

/**
 * P1-17：核心不寫死 provider（claude / codex）。預設的實現者、評審者、「同時問」的主 agent 按能力和註冊順序選擇；
 * 只註冊兩個不叫 claude / codex 的 agent 時，自動流程、同時問、交接都能跑通。這是以後接入 ACP agent（Gemini、OpenCode……）的前提。
 */

function boot() {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { log: () => undefined, workspacePolicy: 'shared' });
  const alpha = new WorkflowAgent({ id: 'alpha', kind: 'other', capabilities: ['implement', 'analysis'] });
  const beta = new WorkflowAgent({ id: 'beta', kind: 'other', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'Fine.\nVERDICT: ACCEPT' });
  const tester = new WorkflowAgent({ id: 'runner', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  orchestrator.registerAdapter(alpha);
  orchestrator.registerAdapter(beta);
  orchestrator.registerAdapter(tester);
  return { store, orchestrator, alpha, beta, tester };
}

describe('P1-17：核心不寫死 provider', () => {
  it('自動流程：預設實現者 alpha、評審者 beta、測試執行器 runner，一路跑到完成', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ title: 'wf', prompt: 'implement', workflow: 'implementation-v1', testCommand: 'npm test', reviewGate: false });
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.workflowState?.agents).toEqual({ implement: 'alpha', review: 'beta', test: 'runner' });
    expect(env.alpha.calls[0]).toMatchObject({ via: 'start', mode: 'implement' });
    expect(run.status).toBe('COMPLETED');
  });

  it('對話任務：沒有指定時交給能實現的 alpha；同時問時 alpha 可寫、beta 唯讀；交接可以用', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', workflow: 'manual' });
    await env.orchestrator.idle();
    expect(env.alpha.calls[0]).toMatchObject({ via: 'start', mode: 'implement' });
    await env.orchestrator.askBoth(task.id, 'both?');
    await env.orchestrator.idle();
    expect(env.beta.calls.at(-1)).toMatchObject({ mode: 'analysis' });
    await env.orchestrator.handoffMessage(task.id, 'alpha', 'beta', 'some output', 'please review');
    await env.orchestrator.idle();
    expect(env.beta.calls.at(-1)!.prompt).toContain('please review');
  });

  it('編排器和工作流的程式碼裡不再出現 claude / codex 字面量（註釋除外）', () => {
    for (const file of ['orchestrator.ts', 'workflow.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../../packages/core/src/${file}`, import.meta.url)), 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(code, file).not.toMatch(/['"`](claude|codex)['"`]/);
    }
  });
});
