import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github.js';

function recordingClient(token) {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url: String(url), headers: init.headers });
    return { ok: true, status: 200, json: async () => [] };
  };
  return { gh: new GitHubClient({ token, fetchImpl }), urls };
}

test('builds content URLs without a trailing slash for the repository root', async () => {
  const { gh, urls } = recordingClient();
  await gh.contents('acme/kiosk', '');
  await gh.contents('acme/kiosk', '/docs/ROADMAP tyrazh.md');
  assert.equal(urls[0].url, 'https://api.github.com/repos/acme/kiosk/contents');
  assert.equal(urls[1].url, 'https://api.github.com/repos/acme/kiosk/contents/docs/ROADMAP%20tyrazh.md');
});

test('rejects path traversal and malformed repository names', async () => {
  const { gh } = recordingClient();
  assert.throws(() => gh.contents('acme/kiosk', '../secrets'), /traversal/);
  assert.throws(() => gh.commits('acme/kiosk/extra', ''), /Invalid repository/);
});

test('sends the token only as a bearer header', async () => {
  const { gh, urls } = recordingClient('t0ken');
  await gh.commits('acme/kiosk', '2026-09-01T00:00:00Z');
  assert.equal(urls[0].headers.Authorization, 'Bearer t0ken');
  assert.ok(!urls[0].url.includes('t0ken'));
  assert.match(urls[0].url, /since=2026-09-01/);
});
