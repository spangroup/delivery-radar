// Tool definitions for the agent. Every tool is read-only; the agent cannot
// change anything in GitHub. Tool outputs are slimmed so the model sees signal,
// not raw API payloads.

import { assertRepoName } from './github.js';
import { estimationStats } from './estimation.js';
import { CATEGORIES, SEVERITIES, STATUSES } from './raid.js';

const DAY = 86_400_000;
const firstLine = (s, max = 140) => String(s || '').split('\n')[0].slice(0, max);
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY);
const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name));

const repoParam = { repo: { type: 'string', description: 'Repository in "owner/name" form. Must be one of the in-scope repositories.' } };

const EVIDENCED = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    item: { type: 'string' },
    evidence: { type: 'string', description: 'Commit sha, PR/issue number or file path.' },
  },
  required: ['item', 'evidence'],
};

export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    overall_status: { type: 'string', enum: ['green', 'amber', 'red'], description: 'green = on track, amber = risks need attention, red = commitments at risk' },
    status_rationale: { type: 'string', description: 'One or two sentences explaining the status, with evidence.' },
    summary: { type: 'string', description: 'Executive summary for stakeholders, 3-5 sentences.' },
    completed: { type: 'array', items: EVIDENCED, description: 'Work finished in the period.' },
    in_progress: { type: 'array', items: EVIDENCED, description: 'Work under way.' },
    next: { type: 'array', items: { type: 'string' }, description: 'Most likely next steps, based on plans and open work.' },
    raid: {
      type: 'array',
      description: 'Full current view of the RAID log: existing items (keep their id) plus new ones (omit id).',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Existing RAID id, e.g. R-001. Omit for new items.' },
          title: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          severity: { type: 'string', enum: SEVERITIES },
          status: { type: 'string', enum: STATUSES },
          repo: { type: 'string' },
          evidence: { type: 'string', description: 'Commit sha, PR/issue number or file path that supports the item.' },
          mitigation: { type: 'string' },
          owner: { type: 'string', description: 'Suggested owner (role or person), if evident.' },
        },
        required: ['title', 'category', 'severity', 'status', 'evidence'],
      },
    },
    decisions_needed: { type: 'array', items: { type: 'string' } },
    estimation_notes: { type: 'string', description: 'What the estimation and flow data says, and how to improve data capture.' },
    learnings: { type: 'array', items: { type: 'string' }, description: 'Delivery learnings worth keeping for future estimates and projects.' },
  },
  required: ['overall_status', 'status_rationale', 'summary', 'completed', 'in_progress', 'next', 'raid', 'decisions_needed', 'estimation_notes', 'learnings'],
};

export function buildTools({ gh, repos, sinceISO, raidStore, now = new Date() }) {
  repos.forEach(assertRepoName);
  const nowISO = now.toISOString();
  const cache = new Map();
  const cached = (key, fn) => {
    if (!cache.has(key)) {
      const promise = Promise.resolve().then(fn);
      promise.catch(() => cache.delete(key)); // do not cache failures
      cache.set(key, promise);
    }
    return cache.get(key);
  };

  const inScope = (repo) => {
    assertRepoName(repo);
    if (!repos.includes(repo)) throw new Error(`Repository ${repo} is not in scope. In scope: ${repos.join(', ')}`);
    return repo;
  };

  async function issuesFor(repo) {
    return cached(`issues:${repo}`, async () => {
      const [recent, open] = await Promise.all([
        gh.issues(repo, sinceISO),
        gh.request('GET', `/repos/${repo}/issues`, { query: { state: 'open', per_page: 100 } }),
      ]);
      const byNumber = new Map();
      for (const i of [...recent, ...open]) if (!i.pull_request) byNumber.set(i.number, i);
      return [...byNumber.values()];
    });
  }

  const handlers = {
    async list_repositories() {
      return Promise.all(
        repos.map(async (repo) => {
          try {
            const r = await cached(`repo:${repo}`, () => gh.repo(repo));
            return {
              repo,
              description: r.description,
              default_branch: r.default_branch,
              private: r.private,
              pushed_at: r.pushed_at,
              open_issues_and_prs: r.open_issues_count,
            };
          } catch (e) {
            return { repo, error: e.message };
          }
        }),
      );
    },

    async list_commits({ repo }) {
      inScope(repo);
      const commits = await cached(`commits:${repo}`, () => gh.commits(repo, sinceISO));
      const byAuthor = {};
      const slim = commits.map((c) => {
        const author = c.author?.login || c.commit?.author?.name || 'unknown';
        byAuthor[author] = (byAuthor[author] || 0) + 1;
        return { sha: c.sha.slice(0, 7), date: c.commit?.author?.date, author, message: firstLine(c.commit?.message) };
      });
      return {
        period_since: sinceISO,
        count: slim.length,
        by_author: byAuthor,
        commits: slim.slice(0, 80),
        truncated: slim.length > 80,
      };
    },

    async list_pull_requests({ repo }) {
      inScope(repo);
      const pulls = await cached(`pulls:${repo}`, () => gh.pulls(repo));
      const relevant = pulls.filter((p) => p.state === 'open' || p.updated_at >= sinceISO);
      return relevant.map((p) => ({
        number: p.number,
        title: firstLine(p.title),
        state: p.merged_at ? 'merged' : p.state,
        draft: !!p.draft,
        author: p.user?.login,
        created_at: p.created_at,
        merged_at: p.merged_at,
        age_days: daysBetween(p.created_at, p.merged_at || p.closed_at || nowISO),
        days_since_update: daysBetween(p.updated_at, nowISO),
        labels: labelNames(p.labels),
      }));
    },

    async list_issues({ repo, state = 'all' }) {
      inScope(repo);
      const issues = await issuesFor(repo);
      return issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({
          number: i.number,
          title: firstLine(i.title),
          state: i.state,
          labels: labelNames(i.labels),
          assignees: (i.assignees || []).map((a) => a.login),
          milestone: i.milestone?.title || null,
          created_at: i.created_at,
          closed_at: i.closed_at,
          days_since_update: daysBetween(i.updated_at, nowISO),
          body_excerpt: String(i.body || '').slice(0, 300),
        }));
    },

    async list_milestones({ repo }) {
      inScope(repo);
      const ms = await cached(`milestones:${repo}`, () => gh.milestones(repo));
      return ms.map((m) => ({
        title: m.title,
        state: m.state,
        due_on: m.due_on,
        open_issues: m.open_issues,
        closed_issues: m.closed_issues,
        overdue: m.state === 'open' && !!m.due_on && m.due_on < nowISO,
      }));
    },

    async list_files({ repo, path = '' }) {
      inScope(repo);
      const res = await gh.contents(repo, path);
      if (!Array.isArray(res)) return { path, type: res.type, note: 'This is a file; use read_file.' };
      return res.slice(0, 200).map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
    },

    async read_file({ repo, path }) {
      inScope(repo);
      if (!path) throw new Error('path is required');
      const res = await gh.contents(repo, path);
      if (Array.isArray(res)) return { path, note: 'This is a directory; use list_files.' };
      if (res.encoding !== 'base64' || typeof res.content !== 'string') return { path, note: 'File content not available through the API (too large or binary).' };
      const text = Buffer.from(res.content, 'base64').toString('utf8');
      const limit = 15_000;
      return { path, size: res.size, content: text.slice(0, limit), truncated: text.length > limit };
    },

    async estimation_stats({ repo }) {
      inScope(repo);
      return estimationStats(await issuesFor(repo));
    },

    async get_raid_log({ include_closed = false } = {}) {
      const items = raidStore.list({ includeClosed: include_closed });
      return { count: items.length, items };
    },
  };

  const specs = [
    { name: 'list_repositories', description: 'List the in-scope repositories with basic metadata. Call this first.', input_schema: { type: 'object', properties: {} } },
    { name: 'get_raid_log', description: 'Read the persistent RAID log (risks, assumptions, issues, dependencies) from previous runs. Reuse existing ids when you update items.', input_schema: { type: 'object', properties: { include_closed: { type: 'boolean' } } } },
    { name: 'list_commits', description: 'Commits in the reporting period with author counts. Use to see what actually changed and who carries the work.', input_schema: { type: 'object', properties: repoParam, required: ['repo'] } },
    { name: 'list_pull_requests', description: 'Open pull requests plus those updated in the period, with age and days since last update. Long-open or idle PRs are delivery risks.', input_schema: { type: 'object', properties: repoParam, required: ['repo'] } },
    { name: 'list_issues', description: 'Issues updated in the period plus all open issues, with staleness.', input_schema: { type: 'object', properties: { ...repoParam, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['repo'] } },
    { name: 'list_milestones', description: 'Milestones with due dates and progress. Overdue milestones are schedule risks.', input_schema: { type: 'object', properties: repoParam, required: ['repo'] } },
    { name: 'list_files', description: 'List a directory in the default branch. Use to find planning docs (ROADMAP, docs/, CHANGELOG, runbooks).', input_schema: { type: 'object', properties: { ...repoParam, path: { type: 'string', description: 'Directory path; empty for repository root.' } }, required: ['repo'] } },
    { name: 'read_file', description: 'Read a text file from the default branch, e.g. a roadmap or runbook, to compare plan with actual progress.', input_schema: { type: 'object', properties: { ...repoParam, path: { type: 'string' } }, required: ['repo', 'path'] } },
    { name: 'estimation_stats', description: 'Deterministic estimation and flow metrics computed from issue estimates/actuals and cycle time. Use these numbers as-is; do not invent metrics.', input_schema: { type: 'object', properties: repoParam, required: ['repo'] } },
    { name: 'submit_report', description: 'Submit the final evidence-based delivery report. Call exactly once, when the investigation is complete.', input_schema: REPORT_SCHEMA },
  ];

  return { specs, handlers };
}
