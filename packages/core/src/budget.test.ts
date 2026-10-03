import { describe, expect, it } from 'vitest';
import { budgetViolations, createBudgetSnapshot } from './budget.js';

describe('budget', () => {
  it('detects review and stall limits', () => {
    const b = createBudgetSnapshot({ maxReviewRounds: 1, maxStallCount: 2 });
    b.reviewRoundsUsed = 1;
    b.stallCount = 2;
    expect(budgetViolations(b)).toContain('maxReviewRounds');
    expect(budgetViolations(b)).toContain('maxStallCount');
  });
});
