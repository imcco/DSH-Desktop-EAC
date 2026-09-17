import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  migrateRouterCoreFile,
  normalizedSha256,
} = require(join(root, 'router-persona-preset-migrate.js'));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-router-persona-migrate-'));
  const source = join(dir, 'assets', 'router-core.mjs');
  const installed = join(dir, 'installed', 'router-core.mjs');
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(installed), { recursive: true });
  return { dir, source, installed };
}

test('router persona migration updates an untouched buggy preset and keeps a backup', () => {
  const { dir, source, installed } = fixture();
  try {
    const buggy = "const keep = sections.filter((section) => !/persona/i.test(section.name))\n";
    const fixed = "const keep = sections.filter((section) => section.name !== 'router-persona')\n";
    writeFileSync(source, fixed);
    writeFileSync(installed, buggy);

    const result = migrateRouterCoreFile(source, installed, normalizedSha256(buggy));
    assert.equal(result.status, 'migrated');
    assert.equal(readFileSync(installed, 'utf8'), fixed);
    assert.equal(readFileSync(installed + '.persona-card-fix.bak', 'utf8'), buggy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router persona migration never overwrites a customized preset', () => {
  const { dir, source, installed } = fixture();
  try {
    writeFileSync(source, 'fixed official source\n');
    writeFileSync(installed, 'user customized source\n');

    const result = migrateRouterCoreFile(source, installed, normalizedSha256('old official source\n'));
    assert.equal(result.status, 'customized');
    assert.equal(readFileSync(installed, 'utf8'), 'user customized source\n');
    assert.equal(existsSync(installed + '.persona-card-fix.bak'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router persona migration is idempotent after the fixed source is installed', () => {
  const { dir, source, installed } = fixture();
  try {
    writeFileSync(source, 'fixed source\n');
    writeFileSync(installed, 'fixed source\r\n');

    const result = migrateRouterCoreFile(source, installed, normalizedSha256('old source\n'));
    assert.equal(result.status, 'kept');
    assert.equal(existsSync(installed + '.persona-card-fix.bak'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
