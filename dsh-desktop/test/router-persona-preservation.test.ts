import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const presets = [
  'router-standard',
  'v4-flash-godmode-opencode-go',
];

for (const preset of presets) {
  test(`${preset} replaces its own persona without removing the user persona card`, async () => {
    const moduleUrl = pathToFileURL(
      join(root, 'assets', 'agent-presets', preset, 'router-core.mjs'),
    ).href;
    const { applyPersona } = await import(moduleUrl);
    const soul = { name: 'soul:persona', text: 'Mocha persona', order: 0 };
    const custom = { name: 'third-party:persona-notes', text: 'keep me', order: 1 };
    const plan = { name: 'plan-mode', text: 'plan rules', order: 2 };

    const result = applyPersona([
      { name: 'persona', text: 'legacy persona', order: 0 },
      { name: 'deployment:persona', text: 'deployment persona', order: 0 },
      { name: 'router-persona', text: 'stale router persona', order: 0 },
      soul,
      custom,
      plan,
    ], 'fresh router persona');

    assert.deepEqual(result, [
      soul,
      custom,
      plan,
      { name: 'router-persona', text: 'fresh router persona', order: 0 },
    ]);
  });
}
