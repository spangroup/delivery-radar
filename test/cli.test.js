// End-to-end smoke test: runs the real CLI against a local mock of the GitHub
// and Anthropic APIs. No network, no keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeGitHub, VALID_REPORT } from './fixtures.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function startMock() {
  const gh = new FakeGitHub();
  const script = [
    [{ type: 'tool_use', id: 'u1', name: 'list_repositories', input: {} }, { type: 'tool_use', id: 'u2', name: 'get_raid_log', input: {} }],
    [{ type: 'tool_use', id: 'u3', name: 'list_milestones', input: { repo: 'acme/kiosk' } }],
    [{ type: 'tool_use', id: 'u4', name: 'submit_report', input: VALID_REPORT }],
  ];
  const seen = { messages: 0, auth: null };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    for await (const chunk of req) body += chunk;

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      seen.messages++;
      seen.auth = req.headers['x-api-key'];
      const content = script.shift();
      return send(200, { id: `msg_${seen.messages}`, type: 'message', role: 'assistant', model: JSON.parse(body).model, content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
    }

    const m = url.pathname.match(/^\/repos\/acme\/kiosk(?:\/(\w+))?(?:\/(.*))?$/);
    if (!m) return send(404, { message: 'Not Found' });
    const [, kind, rest] = m;
    try {
      if (!kind) return send(200, await gh.repo('acme/kiosk'));
      if (kind === 'commits') return send(200, await gh.commits('acme/kiosk'));
      if (kind === 'pulls') return send(200, await gh.pulls('acme/kiosk'));
      if (kind === 'milestones') return send(200, await gh.milestones('acme/kiosk'));
      if (kind === 'contents') return send(200, await gh.contents('acme/kiosk', decodeURIComponent(rest || '')));
      if (kind === 'issues') {
        if (url.searchParams.get('state') === 'open') return send(200, await gh.request('GET', '/repos/acme/kiosk/issues', { query: { state: 'open' } }));
        return send(200, await gh.issues('acme/kiosk'));
      }
    } catch (e) {
      return send(e.status || 500, { message: e.message });
    }
    return send(404, { message: 'Not Found' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, cwd: os.tmpdir() });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('dry run and full run produce report files and a persistent RAID log', async () => {
  const { server, seen, base } = await startMock();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const env = { GITHUB_API_URL: base, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'test-key', GITHUB_TOKEN: '', RADAR_REPOS: 'acme/kiosk', RADAR_OUT_DIR: out, RADAR_MODEL: 'mock-model' };
  try {
    const dry = await runCli(['--dry-run'], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stderr, /commits in period: 2/);
    assert.match(dry.stderr, /1 overdue/);
    assert.match(dry.stderr, /planning docs at root: README.md, ROADMAP.md/);
    assert.equal(seen.messages, 0, 'dry run must not call the LLM');

    const full = await runCli([], env);
    assert.equal(full.code, 0, full.stderr);
    assert.equal(seen.messages, 3);
    assert.equal(seen.auth, 'test-key');

    const files = fs.readdirSync(out).sort();
    assert.ok(files.includes('latest.md'));
    assert.ok(files.includes('raid.json'));
    assert.ok(files.some((f) => /-status\.md$/.test(f)));
    assert.ok(files.some((f) => /-run\.json$/.test(f)));

    const md = fs.readFileSync(path.join(out, 'latest.md'), 'utf8');
    assert.match(md, /R-001/);
    const raid = JSON.parse(fs.readFileSync(path.join(out, 'raid.json'), 'utf8'));
    assert.deepEqual(raid.items.map((i) => i.id), ['R-001', 'D-001']);
  } finally {
    server.close();
  }
});

test('fails clearly without repositories', async () => {
  const res = await runCli([], { RADAR_REPOS: '' });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /No repositories/);
});
