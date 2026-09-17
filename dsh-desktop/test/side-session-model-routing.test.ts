import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFinalPrompt } from '../assets/plugins/dsh-side-session/lib/index.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PLUGIN = join(ROOT, 'assets', 'plugins', 'dsh-side-session');

test('temporary sessions use the host LLM route by default', () => {
  const host = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

  assert.match(host, /\.default\("3"\)/, 'host settings must default to ctx.llm mode');
  assert.match(client, /mode:\s*"3"/, 'client state and settings must default to ctx.llm mode');
  assert.match(client, /String\(v\.mode \|\| "3"\)/, 'missing saved settings must remain on ctx.llm mode');
});

test('host mode resolves the live Session model-selection projection first', () => {
  const host = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');

  assert.match(host, /ctxRef\.agents\.get\(sessionId\)/);
  assert.match(host, /stateOf\(agent\.session,\s*"modelSelection"\)/);
  assert.match(host, /selection\.pending \|\| selection\.lastUsed/);
  assert.match(host, /ctxRef\.agentDefaultModel\.currentSelection\(\)/);
  assert.match(host, /"agents",\s*"sessionProjections",\s*"agentDefaultModel"/);
});

test('direct DeepSeek mode never forwards a third-party model id', () => {
  const host = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');

  assert.match(host, /route\.provider === DEFAULT_PROVIDER \? route\.model : DEFAULT_DIRECT_MODEL/);
  assert.match(host, /const DEFAULT_DIRECT_MODEL = "deepseek-chat";/);
});

test('upstream errors retain their real HTTP status and message', () => {
  const host = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

  assert.match(host, /const status = upstream\.status >= 400 && upstream\.status <= 599 \? upstream\.status : 502;/);
  assert.match(client, /e\.message \|\| e\.error \|\| "HTTP " \+ r\.status/);
});

test('temporary session history is folded into system before the second turn', () => {
  const prompt = buildFinalPrompt({
    sessionId: '',
    messages: [
      { role: 'system', content: '主会话上下文' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
      { role: 'user', content: '第二问' },
    ],
  });

  assert.deepEqual(prompt.rest, [{ role: 'user', content: '第二问' }]);
  assert.match(prompt.system, /==== 临时会话上下文 ====/);
  assert.match(prompt.system, /\[用户\] 第一问/);
  assert.match(prompt.system, /\[助手\] 第一答/);
  assert.match(prompt.system, /主会话上下文/);
  assert.doesNotMatch(prompt.system, /\[用户\] 第二问/);
});

test('floating temporary session stays fully inside the viewport', () => {
  const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

  assert.match(client, /function fitFloatToViewport\(element\)/);
  assert.match(client, /window\.innerWidth - margin - rect\.width/);
  assert.match(client, /window\.innerHeight - margin - rect\.height/);
  assert.match(client, /window\.addEventListener\("resize", fit\)/);
  assert.match(client, /window\.removeEventListener\("resize", fit\)/);
  assert.doesNotMatch(client, /window\.innerWidth - 60/);
  assert.doesNotMatch(client, /window\.innerHeight - 40/);
});

test('temporary session footer action stacks below other navigation actions', () => {
  const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8');

  assert.match(
    client,
    /div:has\(> div\[data-slot="sidebar\.footer\.action"\] \.dss-footer-icon\)\{flex-direction:column/,
  );
  assert.match(client, /\.dss-footer-icon\{[^}]*width:100%;/);
  assert.match(
    client,
    /div:has\(> div\[data-slot="sidebar\.footer\.action"\] \.dss-footer-icon\[data-rail="1"\]\)\{align-items:center/,
  );
  assert.doesNotMatch(client, /width:calc\(100% \+ 8px\)/);
});
