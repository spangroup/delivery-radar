// Minimal GitHub REST client: only the read endpoints the agent needs,
// plus one write (create issue) that is gated behind human approval in the CLI.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function assertRepoName(repo) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new Error(`Invalid repository name "${repo}". Expected "owner/name".`);
  }
}

export class GitHubClient {
  constructor({ token, fetchImpl = globalThis.fetch, baseUrl = 'https://api.github.com' } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'delivery-radar',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async paginate(path, query = {}, { maxPages = 3 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.request('GET', path, { query: { ...query, per_page: 100, page } });
      if (!Array.isArray(items)) break;
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  repo(repo) {
    assertRepoName(repo);
    return this.request('GET', `/repos/${repo}`);
  }

  commits(repo, sinceISO) {
    assertRepoName(repo);
    return this.paginate(`/repos/${repo}/commits`, { since: sinceISO });
  }

  pulls(repo) {
    assertRepoName(repo);
    return this.request('GET', `/repos/${repo}/pulls`, {
      query: { state: 'all', sort: 'updated', direction: 'desc', per_page: 50 },
    });
  }

  // Note: GitHub's issues endpoint also returns pull requests; callers filter them out.
  issues(repo, sinceISO) {
    assertRepoName(repo);
    return this.paginate(`/repos/${repo}/issues`, { state: 'all', since: sinceISO });
  }

  milestones(repo) {
    assertRepoName(repo);
    return this.request('GET', `/repos/${repo}/milestones`, { query: { state: 'all', per_page: 50 } });
  }

  contents(repo, path = '') {
    assertRepoName(repo);
    const clean = String(path).replace(/^\/+/, '');
    if (clean.split('/').includes('..')) throw new Error('Path traversal is not allowed');
    const encoded = clean.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return this.request('GET', `/repos/${repo}/contents/${encoded}`);
  }

  createIssue(repo, { title, body, labels }) {
    assertRepoName(repo);
    return this.request('POST', `/repos/${repo}/issues`, { body: { title, body, labels } });
  }
}
