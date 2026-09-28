#!/usr/bin/env node
// Delivery Radar CLI.
//   node src/cli.js --repo owner/name [--repo ...] [--since 7] [--out ./reports]
//   node src/cli.js --dry-run            # check GitHub access and data, no LLM call
//   node src/cli.js --publish owner/name # after review, post the report as a GitHub issue

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadEnvFile } from './env.js';
import { GitHubClient, assertRepoName } from './github.js';
import { RaidStore } from './raid.js';
import { buildTools } from './tools.js';
import { runAgent } from './agent.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { renderMarkdown } from './render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Delivery Radar: AI agent for evidence-based delivery status reports.

Usage:
  node src/cli.js [options]

Options:
  --repo <owner/name>     Repository to analyse (repeatable). Default: RADAR_REPOS
  --since <days>          Reporting window in days. Default: RADAR_SINCE_DAYS or 7
  --out <dir>             Output directory. Default: RADAR_OUT_DIR or ./reports
  --model <id>            Claude model. Default: RADAR_MODEL or claude-sonnet-5
  --max-steps <n>         Agent step budget. Default: 25
  --dry-run               Collect GitHub data only (no LLM). Verifies access.
  --publish <owner/name>  After generation, ask for approval and post as a GitHub issue.
  -h, --help              Show this help.
`;

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  loadEnvFile(path.join(ROOT, '.env'));

  const { values } = parseArgs({
    options: {
      repo: { type: 'string', multiple: true },
      since: { type: 'string' },
      out: { type: 'string' },
      model: { type: 'string' },
      'max-steps': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      publish: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const repos = (values.repo?.length ? values.repo : (process.env.RADAR_REPOS || '').split(','))
    .map((r) => r.trim())
    .filter(Boolean);
  if (!repos.length) throw new Error('No repositories. Pass --repo owner/name or set RADAR_REPOS.');
  repos.forEach(assertRepoName);

  const sinceDays = Number(values.since || process.env.RADAR_SINCE_DAYS || 7);
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) throw new Error('--since must be a positive number of days');
  const outDir = path.resolve(values.out || process.env.RADAR_OUT_DIR || path.join(ROOT, 'reports'));
  const model = values.model || process.env.RADAR_MODEL || 'claude-sonnet-5';
  const maxSteps = Number(values['max-steps'] || 25);

  const now = new Date();
  const sinceISO = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
  const gh = new GitHubClient({ token: process.env.GITHUB_TOKEN, baseUrl: process.env.GITHUB_API_URL || undefined });
  const raidStore = new RaidStore(path.join(outDir, 'raid.json'));
  const tools = buildTools({ gh, repos, sinceISO, raidStore, now });

  if (values['dry-run']) return dryRun({ tools, repos, sinceISO });

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (see .env.example).');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  log(`Delivery Radar: ${repos.join(', ')} | since ${sinceISO.slice(0, 10)} | model ${model}`);
  const result = await runAgent({
    client,
    model,
    system: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({ repos, sinceISO, now }),
    tools,
    maxSteps,
    onStep: ({ step, tool, input }) => log(`  [${step}] ${tool}${input?.repo ? ' ' + input.repo : ''}${input?.path ? ' ' + input.path : ''}`),
  });

  raidStore.upsert(result.report.raid, { now });
  raidStore.save();

  const date = now.toISOString().slice(0, 10);
  const md = renderMarkdown(result.report, {
    repos,
    sinceISO,
    now,
    raidItems: raidStore.list({ includeClosed: true }),
    meta: { model, steps: result.steps, usage: result.usage },
  });

  fs.mkdirSync(outDir, { recursive: true });
  const mdFile = path.join(outDir, `${date}-status.md`);
  fs.writeFileSync(mdFile, md);
  fs.writeFileSync(path.join(outDir, 'latest.md'), md);
  fs.writeFileSync(
    path.join(outDir, `${date}-run.json`),
    JSON.stringify({ date, repos, sinceISO, model, steps: result.steps, usage: result.usage, trace: result.trace, report: result.report }, null, 2) + '\n',
  );
  log(`Report: ${mdFile}`);
  log(`RAID log: ${path.join(outDir, 'raid.json')} (${raidStore.list().length} open)`);

  if (values.publish) await publish({ gh, repo: values.publish, md, date });
  return 0;
}

async function dryRun({ tools, repos, sinceISO }) {
  log(`Dry run (no LLM). Period since ${sinceISO.slice(0, 10)}.`);
  const h = tools.handlers;
  const safe = (p) => p.catch((e) => ({ error: e.message }));
  const show = (label, value, fmt) => log(`  ${label}: ${value?.error ? 'ERROR ' + value.error : fmt(value)}`);
  let failures = 0;

  for (const meta of await h.list_repositories()) {
    if (meta.error) {
      failures++;
      log(`\n${meta.repo}: ERROR ${meta.error}`);
      continue;
    }
    const repo = meta.repo;
    const [commits, pulls, issues, milestones, est, root] = await Promise.all([
      safe(h.list_commits({ repo })),
      safe(h.list_pull_requests({ repo })),
      safe(h.list_issues({ repo })),
      safe(h.list_milestones({ repo })),
      safe(h.estimation_stats({ repo })),
      safe(h.list_files({ repo, path: '' })),
    ]);
    log(`\n${repo} (${meta.private ? 'private' : 'public'}, default branch ${meta.default_branch})`);
    show('commits in period', commits, (c) => `${c.count} by ${Object.keys(c.by_author).join(', ') || 'nobody'}`);
    show('pull requests (open or updated)', pulls, (p) => p.length);
    show('issues (open or updated)', issues, (i) => i.length);
    show('milestones', milestones, (m) => `${m.length} (${m.filter((x) => x.overdue).length} overdue)`);
    show('estimate coverage', est, (e) => `${e.estimate_coverage_pct}%${e.note ? ' | ' + e.note : ''}`);
    show('planning docs at root', root, (r) => (Array.isArray(r) ? r : []).map((f) => f.name).filter((n) => /roadmap|readme|changelog|docs/i.test(n)).join(', ') || 'none found');
  }
  if (failures) {
    log(`\n${failures} repository(ies) not reachable. Check GITHUB_TOKEN access and repository names.`);
    return 1;
  }
  log('\nGitHub access OK. Run without --dry-run to generate the report.');
  return 0;
}

async function publish({ gh, repo, md, date }) {
  assertRepoName(repo);
  if (!process.stdin.isTTY) {
    log('Not publishing: approval needs an interactive terminal. The report stays local.');
    return;
  }
  process.stdout.write('\n' + md + '\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Publish this report as a GitHub issue in ${repo}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    log('Not published.');
    return;
  }
  const issue = await gh.createIssue(repo, { title: `Delivery status: ${date}`, body: md });
  log(`Published: ${issue.html_url}`);
}

function log(msg) {
  process.stderr.write(msg + '\n');
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    log(`Error: ${err.message}`);
    process.exit(1);
  },
);
