import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');

for (const file of ['boot-smoke.js', 'gui-smoke.js']) {
  test(`${file} isolates every user-data boundary`, () => {
    const source = readFileSync(join(REPO, file), 'utf8');
    for (const key of [
      'DSH_HOME',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'DSH_DESKTOP_SKIP_AUTO_UPDATE',
      'DSH_DESKTOP_SKIP_CLIENT_UPDATE',
      'DSH_DESKTOP_SKIP_AGENT_UPDATE',
      'DSH_DESKTOP_SKIP_PLUGIN_UPDATE',
      'DSH_DESKTOP_TEST_NO_SHORTCUTS',
    ]) {
      assert.match(source, new RegExp(`\\b${key}:`), `${file} does not isolate ${key}`);
    }
    assert.match(source, /pluginOnboardingDone: true/);
    assert.match(source, /env:\s*(?:isolatedEnv|\{\s*\.\.\.isolatedEnv,)/);
  });
}
