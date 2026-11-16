import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBudgetProblem } from '../src/resource-budget.ts';

test('shared-server job admission reserves host and container memory before billable work', () => {
  const mib = 1024 * 1024;
  assert.equal(memoryBudgetProblem(800 * mib, 400 * mib), undefined);
  assert.match(memoryBudgetProblem(255 * mib, 400 * mib)!, /现有项目/);
  assert.match(memoryBudgetProblem(800 * mib, 319 * mib)!, /容器/);
  assert.equal(memoryBudgetProblem(256 * mib, 320 * mib), undefined);
  assert.match(memoryBudgetProblem(NaN, 400 * mib)!, /可用内存/);
  assert.match(memoryBudgetProblem(800 * mib, NaN)!, /容器/);
});
