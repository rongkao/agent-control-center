import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminal } from './state-machine.js';

describe('task state machine', () => {
  it('allows expected pause/resume transitions', () => {
    expect(canTransition('RUNNING', 'WAITING_APPROVAL')).toBe(true);
    expect(canTransition('WAITING_APPROVAL', 'RUNNING')).toBe(true);
  });

  it('allows fail-closed BLOCKED from any non-terminal state', () => {
    expect(canTransition('CREATED', 'BLOCKED')).toBe(true);
    expect(canTransition('QUEUED', 'BLOCKED')).toBe(true);
    expect(canTransition('COMPLETED', 'BLOCKED')).toBe(false);
  });

  it('rejects terminal state escape', () => {
    expect(() => assertTransition('COMPLETED', 'RUNNING')).toThrow(/Illegal task transition/);
  });

  it('recognizes terminal states', () => {
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('BLOCKED')).toBe(false);
  });
});
