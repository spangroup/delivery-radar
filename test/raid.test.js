import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RaidStore } from '../src/raid.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raid-')), 'raid.json');

test('assigns ids per RAID category', () => {
  const store = new RaidStore(null);
  const [r, i, r2, d] = store.upsert([
    { title: 'Slip', category: 'risk', severity: 'high', status: 'open', evidence: 'm1' },
    { title: 'Bug', category: 'issue', severity: 'low', status: 'open', evidence: '#1' },
    { title: 'Vendor', category: 'risk', severity: 'medium', status: 'open', evidence: 'doc' },
    { title: 'API', category: 'dependency', severity: 'medium', status: 'open', evidence: 'doc' },
  ]);
  assert.deepEqual([r.id, i.id, r2.id, d.id], ['R-001', 'I-001', 'R-002', 'D-001']);
});

test('keeps ids across runs, updates and closes items with dates', () => {
  const file = tmpFile();
  const first = new RaidStore(file);
  first.upsert([{ title: 'Slip', category: 'risk', severity: 'high', status: 'open', evidence: 'm1' }], { now: new Date('2026-09-21') });
  first.save();

  const second = new RaidStore(file);
  assert.equal(second.list().length, 1);
  second.upsert([{ id: 'R-001', title: 'Slip', category: 'risk', severity: 'high', status: 'closed', evidence: 'station live, a1b2c3d' }], { now: new Date('2026-09-28') });
  second.save();

  const third = new RaidStore(file);
  const item = third.get('R-001');
  assert.equal(item.status, 'closed');
  assert.equal(item.first_seen, '2026-09-21');
  assert.equal(item.closed_on, '2026-09-28');
  assert.equal(third.list().length, 0);
  assert.equal(third.list({ includeClosed: true }).length, 1);
});

test('unknown id becomes a new item instead of overwriting', () => {
  const store = new RaidStore(null);
  const [item] = store.upsert([{ id: 'R-999', title: 'Ghost', category: 'risk', severity: 'low', status: 'open', evidence: 'x' }]);
  assert.equal(item.id, 'R-001');
});
