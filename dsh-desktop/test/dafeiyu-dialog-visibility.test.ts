import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createVisibilityHandler, VISIBILITY_ENDPOINT } from '../assets/plugins/dsh-dafeiyu/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientSource = readFileSync(join(root, 'assets', 'plugins', 'dsh-dafeiyu', 'lib', 'client.js'), 'utf8');

function request(body, overrides = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = overrides.method ?? 'POST';
  req.socket = { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' };
  req.headers = {
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    ...overrides.headers,
  };
  return req;
}

function response() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = String(body); },
  };
}

test('visibility endpoint suspends the native companion for application dialogs', async () => {
  assert.equal(VISIBILITY_ENDPOINT, '/plugins/dsh-dafeiyu/visibility');
  const seen = [];
  const handler = createVisibilityHandler((value) => seen.push(value));
  const res = response();
  await handler(request({ suspended: true }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { suspended: true });
  assert.deepEqual(seen, [true]);
});

test('visibility endpoint rejects malformed or non-local requests', async () => {
  const handler = createVisibilityHandler(() => assert.fail('callback must not run'));
  const malformed = response();
  await handler(request({ suspended: 'yes' }), malformed);
  assert.equal(malformed.status, 400);

  const remote = response();
  await handler(request({ suspended: true }, { remoteAddress: '192.0.2.1' }), remote);
  assert.equal(remote.status, 403);
});

test('browser client observes modal dialogs and reports lifecycle changes', () => {
  assert.match(clientSource, /const VISIBILITY_ENDPOINT = '\/plugins\/dsh-dafeiyu\/visibility'/);
  assert.match(clientSource, /document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)/);
  assert.match(clientSource, /new MutationObserver\(schedule\)/);
  assert.match(clientSource, /ctx\.effect\(\(\) => installDialogVisibilityBridge\(\)/);
  assert.match(clientSource, /if \(lastSuspended === true\) void send\(false\)/);
});
