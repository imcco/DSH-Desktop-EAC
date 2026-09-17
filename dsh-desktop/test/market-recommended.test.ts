import test from 'node:test';
import assert from 'node:assert/strict';

const host = await import('../assets/plugins/dsh-unified-market/lib/host.js');
const { loadEacRecommendations, mergeRecommendedCatalog } = host;

test('EAC recommended catalog exposes Archify for web-desktop with an exact version', () => {
  const plugins = loadEacRecommendations('zh');
  const archify = plugins.find((plugin) => plugin.name === 'Archify');

  assert.ok(archify, 'Archify must be present in the EAC recommendation catalog');
  assert.equal(archify.cat, 'skill');
  assert.equal(archify.profile, 'web-desktop');
  assert.equal(archify.source, '@tt-a1i/archify-dsh@0.1.0');
  assert.equal(archify.eacRecommended, true);
  assert.match(archify.desc, /架构图/);
});

test('EAC recommendations merge before remote entries and deduplicate by repository', () => {
  const merged = mergeRecommendedCatalog({
    plugins: [{
      cat: 'skill',
      name: 'archify-dsh',
      url: 'https://github.com/tt-a1i/archify',
      by: 'remote',
      desc: 'remote copy',
      cmd: 'dsh plugin --profile web add @tt-a1i/archify-dsh',
      profile: 'web',
      source: '@tt-a1i/archify-dsh',
      stars: 123,
      added: '2026-08-14',
    }],
    cats: [
      { id: 'all', label: '全部', count: 1 },
      { id: 'skill', label: '技能包', count: 1 },
    ],
  }, 'zh');

  const archify = merged.plugins.filter((plugin) => plugin.url === 'https://github.com/tt-a1i/archify');
  assert.equal(archify.length, 1, 'remote duplicates must not create a second Archify card');
  assert.equal(archify[0].name, 'Archify', 'the EAC recommendation owns display and install metadata');
  assert.equal(archify[0].profile, 'web-desktop');
  assert.equal(archify[0].stars, 123, 'live metadata should be retained when available');
  assert.equal(merged.cats.find((cat) => cat.id === 'skill')?.count, 1);
  assert.equal(merged.cats[0].count, 1);
});

test('EAC recommendation descriptions follow the requested catalog locale', () => {
  const archify = loadEacRecommendations('en').find((plugin) => plugin.name === 'Archify');
  assert.ok(archify);
  assert.match(archify.desc, /validated, interactive architecture/);
});
