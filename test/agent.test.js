import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';
import { buildTools } from '../src/tools.js';
import { RaidStore } from '../src/raid.js';
import { renderMarkdown } from '../src/render.js';
import { FakeGitHub, NOW, SINCE, VALID_REPORT } from './fixtures.js';

// Scripted stand-in for the Anthropic client: returns canned responses in order
// and records what the agent sent, so we can assert on the loop's behaviour.
class ScriptedClient {
  constructor(responses) {
    this.responses = responses;
    this.requests = [];
    this.messages = { create: async (req) => {
      this.requests.push(structuredClone(req));
      const next = this.responses.shift();
      if (!next) throw new Error('no more scripted responses');
      return { usage: { input_tokens: 100, output_tokens: 50 }, ...next };
    } };
  }
}

const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const setup = () => {
  const gh = new FakeGitHub();
  const raidStore = new RaidStore(null);
  const tools = buildTools({ gh, repos: ['acme/kiosk'], sinceISO: SINCE, raidStore, now: NOW });
  return { gh, raidStore, tools };
};

test('runs tools, feeds results back, rejects an invalid report, then accepts a valid one', async () => {
  const { gh, tools } = setup();
  const client = new ScriptedClient([
    { stop_reason: 'tool_use', content: [toolUse('t1', 'get_raid_log'), toolUse('t2', 'list_commits', { repo: 'acme/kiosk' })] },
    { stop_reason: 'tool_use', content: [toolUse('t3', 'read_file', { repo: 'acme/kiosk', path: 'ROADMAP.md' }), toolUse('t4', 'estimation_stats', { repo: 'acme/kiosk' })] },
    { stop_reason: 'tool_use', content: [toolUse('t5', 'submit_report', { overall_status: 'purple' })] },
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Fixed.' }, toolUse('t6', 'submit_report', VALID_REPORT)] },
  ]);

  const result = await runAgent({ client, model: 'test-model', system: 'sys', userPrompt: 'go', tools });

  assert.equal(result.steps, 4);
  assert.equal(result.report.overall_status, 'amber');
  assert.deepEqual(result.usage, { input_tokens: 400, output_tokens: 200 });

  // Step 2 request must carry both tool results from step 1.
  const step2 = client.requests[1].messages.at(-1);
  assert.equal(step2.role, 'user');
  assert.deepEqual(step2.content.map((c) => c.tool_use_id), ['t1', 't2']);
  const commits = JSON.parse(step2.content[1].content);
  assert.equal(commits.count, 2);
  assert.deepEqual(commits.by_author, { ihor: 2 });
  assert.equal(commits.commits[0].message, 'feat: first-boot wizard');

  // Roadmap was decoded from base64.
  const step3 = client.requests[2].messages.at(-1);
  assert.match(JSON.parse(step3.content[0].content).content, /Golden image/);

  // Invalid report is returned to the model as an error it can fix.
  const step4 = client.requests[3].messages.at(-1);
  assert.equal(step4.content[0].is_error, true);
  assert.match(step4.content[0].content, /overall_status/);

  // Only read endpoints were used.
  assert.ok(gh.calls.every(([kind]) => kind !== 'createIssue'));
});

test('tool errors are reported to the model, not thrown', async () => {
  const { tools } = setup();
  const client = new ScriptedClient([
    { stop_reason: 'tool_use', content: [toolUse('t1', 'list_commits', { repo: 'someone/else' }), toolUse('t2', 'read_file', { repo: 'acme/kiosk', path: 'missing.md' })] },
    { stop_reason: 'tool_use', content: [toolUse('t3', 'submit_report', VALID_REPORT)] },
  ]);
  const result = await runAgent({ client, model: 'm', system: 's', userPrompt: 'go', tools });
  const results = client.requests[1].messages.at(-1).content;
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content, /not in scope/);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /404/);
  assert.equal(result.trace.filter((t) => !t.ok).length, 2);
});

test('nudges once when the model stops without submitting, then fails clearly', async () => {
  const { tools } = setup();
  const client = new ScriptedClient([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is my report in prose.' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still prose.' }] },
  ]);
  await assert.rejects(runAgent({ client, model: 'm', system: 's', userPrompt: 'go', tools }), /without submitting/);
  assert.match(client.requests[1].messages.at(-1).content, /submit_report/);
});

test('respects the step budget', async () => {
  const { tools } = setup();
  const loop = Array.from({ length: 5 }, (_, i) => ({ stop_reason: 'tool_use', content: [toolUse(`t${i}`, 'get_raid_log')] }));
  const client = new ScriptedClient(loop);
  await assert.rejects(runAgent({ client, model: 'm', system: 's', userPrompt: 'go', tools, maxSteps: 3 }), /within 3 steps/);
  assert.equal(client.requests.length, 3);
});

test('tools expose flow signals: idle PRs, stale open issues, overdue milestones', async () => {
  const { tools } = setup();
  const prs = await tools.handlers.list_pull_requests({ repo: 'acme/kiosk' });
  assert.deepEqual(prs.map((p) => p.number), [7]);
  assert.equal(prs[0].days_since_update, 18);

  const issues = await tools.handlers.list_issues({ repo: 'acme/kiosk', state: 'open' });
  assert.deepEqual(issues.map((i) => i.number), [9]);

  const ms = await tools.handlers.list_milestones({ repo: 'acme/kiosk' });
  assert.equal(ms[0].overdue, true);
});

test('report renders to markdown with RAID ids after merge', async () => {
  const { raidStore } = setup();
  raidStore.upsert(VALID_REPORT.raid, { now: NOW });
  const md = renderMarkdown(VALID_REPORT, {
    repos: ['acme/kiosk'],
    sinceISO: SINCE,
    now: NOW,
    raidItems: raidStore.list({ includeClosed: true }),
    meta: { model: 'test-model', steps: 4, usage: { input_tokens: 400, output_tokens: 200 } },
  });
  assert.match(md, /# Delivery Status — 2026-09-28/);
  assert.match(md, /🟠 AMBER/);
  assert.match(md, /\| R-001 \| risk \| high \| Station 3 behind schedule/);
  assert.match(md, /\| D-001 \| dependency \| medium/);
  assert.match(md, /First-boot wizard _\(a1b2c3d\)_/);
  assert.match(md, /600 tokens/);
});
