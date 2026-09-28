// Fake GitHub client with a small, realistic dataset: a kiosk rollout repo.

export const NOW = new Date('2026-09-28T12:00:00Z');
export const SINCE = '2026-09-21T12:00:00Z';

const roadmap = `# Rollout roadmap
- [x] Golden image for stations
- [ ] Station 3 hardware on site (target 2026-09-25)
- [ ] Payment terminal firmware update (vendor)
`;

export class FakeGitHub {
  constructor() {
    this.calls = [];
  }

  async repo(repo) {
    this.calls.push(['repo', repo]);
    return { description: 'Kiosk fleet', default_branch: 'main', private: true, pushed_at: '2026-09-27T10:00:00Z', open_issues_count: 3 };
  }

  async commits(repo) {
    this.calls.push(['commits', repo]);
    return [
      { sha: 'a1b2c3d4e5', author: { login: 'ihor' }, commit: { author: { name: 'Ihor', date: '2026-09-26T09:00:00Z' }, message: 'feat: first-boot wizard\n\nlong body' } },
      { sha: 'f6e5d4c3b2', author: { login: 'ihor' }, commit: { author: { name: 'Ihor', date: '2026-09-24T09:00:00Z' }, message: 'docs: provisioning runbook §1.13' } },
    ];
  }

  async pulls(repo) {
    this.calls.push(['pulls', repo]);
    return [
      { number: 7, title: 'Station health endpoint', state: 'open', draft: false, user: { login: 'ihor' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', merged_at: null, closed_at: null, labels: [] },
      { number: 5, title: 'Old PR', state: 'closed', user: { login: 'ihor' }, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z', merged_at: '2026-08-02T00:00:00Z', labels: [] },
    ];
  }

  async issues(repo) {
    this.calls.push(['issues', repo]);
    return [
      { number: 11, title: 'Addons-only payment', state: 'closed', labels: [{ name: 'estimate: 6h' }], body: 'actual: 9h', created_at: '2026-09-20T00:00:00Z', closed_at: '2026-09-23T00:00:00Z', updated_at: '2026-09-23T00:00:00Z', assignees: [] },
      { number: 12, title: 'PR mirrored as issue', pull_request: {}, state: 'open', created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z' },
    ];
  }

  async request(method, path, { query } = {}) {
    this.calls.push(['request', method, path, query?.state]);
    if (path.endsWith('/issues') && query?.state === 'open') {
      return [
        { number: 9, title: 'Payment terminal firmware update', state: 'open', labels: [{ name: 'vendor' }, { name: 'estimate: 1d' }], body: '', created_at: '2026-09-05T00:00:00Z', closed_at: null, updated_at: '2026-09-06T00:00:00Z', assignees: [{ login: 'ihor' }] },
      ];
    }
    throw new Error(`unexpected request ${method} ${path}`);
  }

  async milestones(repo) {
    this.calls.push(['milestones', repo]);
    return [{ title: 'Station 3 live', state: 'open', due_on: '2026-09-25T00:00:00Z', open_issues: 2, closed_issues: 4 }];
  }

  async contents(repo, path = '') {
    this.calls.push(['contents', repo, path]);
    if (path === '' || path === 'docs') {
      return [
        { name: 'README.md', path: 'README.md', type: 'file', size: 100 },
        { name: 'ROADMAP.md', path: 'ROADMAP.md', type: 'file', size: roadmap.length },
      ];
    }
    if (path === 'ROADMAP.md') {
      return { type: 'file', encoding: 'base64', size: roadmap.length, content: Buffer.from(roadmap).toString('base64') };
    }
    const err = new Error('GitHub GET contents -> 404: Not Found');
    err.status = 404;
    throw err;
  }

  async createIssue() {
    throw new Error('tests must never publish');
  }
}

export const VALID_REPORT = {
  overall_status: 'amber',
  status_rationale: 'Milestone "Station 3 live" is overdue and PR #7 has been idle for 18 days.',
  summary: 'Golden image and first-boot wizard landed. Station 3 slipped past its target date.',
  completed: [{ repo: 'acme/kiosk', item: 'First-boot wizard', evidence: 'a1b2c3d' }],
  in_progress: [{ repo: 'acme/kiosk', item: 'Station health endpoint', evidence: '#7' }],
  next: ['Install station 3 hardware'],
  raid: [
    { title: 'Station 3 behind schedule', category: 'risk', severity: 'high', status: 'open', repo: 'acme/kiosk', evidence: 'milestone "Station 3 live" due 2026-09-25', mitigation: 'Confirm delivery date with supplier' },
    { title: 'Terminal firmware update depends on vendor', category: 'dependency', severity: 'medium', status: 'open', repo: 'acme/kiosk', evidence: '#9, ROADMAP.md', mitigation: 'Agree a date with the vendor; keep current firmware pinned' },
  ],
  decisions_needed: ['Accept a one-week slip for station 3?'],
  estimation_notes: 'One closed issue with estimate and actual: 9h vs 6h (ratio 1.5).',
  learnings: ['Integration work with payment hardware ran 50% over estimate.'],
};
