import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEstimateHours, parseActualHours, estimationStats } from '../src/estimation.js';

test('parses estimates from labels and body lines in hours, days and weeks', () => {
  assert.equal(parseEstimateHours({ labels: [{ name: 'estimate: 4h' }] }), 4);
  assert.equal(parseEstimateHours({ labels: ['est:2d'] }), 16);
  assert.equal(parseEstimateHours({ labels: [], body: 'Some text\n- Estimate = 1w\n' }), 40);
  assert.equal(parseEstimateHours({ labels: [], body: 'estimate: 1,5d' }), 12);
  assert.equal(parseEstimateHours({ labels: [{ name: 'bug' }], body: 'no numbers here' }), null);
});

test('parses actuals separately from estimates', () => {
  const issue = { labels: [{ name: 'estimate: 6h' }], body: 'spent: 9h' };
  assert.equal(parseEstimateHours(issue), 6);
  assert.equal(parseActualHours(issue), 9);
});

test('computes coverage, accuracy ratio and cycle time; ignores pull requests', () => {
  const stats = estimationStats([
    { number: 1, title: 'a', state: 'closed', labels: ['estimate: 4h'], body: 'actual: 6h', created_at: '2026-09-01T00:00:00Z', closed_at: '2026-09-03T00:00:00Z' },
    { number: 2, title: 'b', state: 'open', labels: ['estimate: 1d'], created_at: '2026-09-02T00:00:00Z' },
    { number: 3, title: 'c', state: 'open', labels: [], created_at: '2026-09-02T00:00:00Z' },
    { number: 4, title: 'pr', state: 'open', labels: ['estimate: 99h'], pull_request: {} },
  ]);
  assert.equal(stats.issues_in_period, 3);
  assert.equal(stats.with_estimate, 2);
  assert.equal(stats.estimate_coverage_pct, 67);
  assert.equal(stats.closed_with_estimate, 1);
  assert.equal(stats.median_accuracy_ratio, 1.5);
  assert.equal(stats.median_cycle_time_days, 2);
  assert.equal(stats.open_estimated_hours, 8);
  assert.equal(stats.note, null);
});

test('explains missing data instead of inventing numbers', () => {
  assert.match(estimationStats([]).note, /No issues/);
  assert.match(estimationStats([{ number: 1, title: 'x', state: 'open', labels: [] }]).note, /No issues carry estimates/);
});
