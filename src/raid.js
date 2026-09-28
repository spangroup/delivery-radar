// Persistent RAID log (Risks, Assumptions, Issues, Dependencies).
// The agent reads it at the start of every run and must keep IDs stable,
// so accountability for an item survives from one weekly report to the next.

import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = ['risk', 'assumption', 'issue', 'dependency'];
export const SEVERITIES = ['low', 'medium', 'high'];
export const STATUSES = ['open', 'closed'];
const PREFIX = { risk: 'R', assumption: 'A', issue: 'I', dependency: 'D' };

export class RaidStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.items = Array.isArray(data.items) ? data.items : [];
    }
  }

  list({ includeClosed = false } = {}) {
    return this.items.filter((i) => includeClosed || i.status !== 'closed');
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  nextId(category) {
    const prefix = PREFIX[category] || 'R';
    const max = this.items
      .filter((i) => i.id?.startsWith(prefix + '-'))
      .reduce((m, i) => Math.max(m, Number(i.id.slice(prefix.length + 1)) || 0), 0);
    return `${prefix}-${String(max + 1).padStart(3, '0')}`;
  }

  // Merge the agent's view of the RAID log into the store.
  // Items with a known id are updated; everything else becomes a new item.
  upsert(entries, { now = new Date() } = {}) {
    const stamp = now.toISOString().slice(0, 10);
    const touched = [];
    for (const e of entries || []) {
      const existing = e.id ? this.get(e.id) : null;
      if (existing) {
        const wasOpen = existing.status !== 'closed';
        Object.assign(existing, pick(e), { last_seen: stamp });
        if (existing.status === 'closed' && wasOpen) existing.closed_on = stamp;
        if (existing.status !== 'closed') delete existing.closed_on;
        touched.push(existing);
      } else {
        const category = CATEGORIES.includes(e.category) ? e.category : 'risk';
        const item = {
          id: this.nextId(category),
          ...pick({ ...e, category }),
          status: e.status === 'closed' ? 'closed' : 'open',
          first_seen: stamp,
          last_seen: stamp,
        };
        if (item.status === 'closed') item.closed_on = stamp;
        this.items.push(item);
        touched.push(item);
      }
    }
    return touched;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ updated: new Date().toISOString(), items: this.items }, null, 2) + '\n');
  }
}

function pick(e) {
  const out = {};
  for (const k of ['title', 'category', 'severity', 'evidence', 'mitigation', 'owner', 'status', 'repo']) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') out[k] = e[k];
  }
  return out;
}
