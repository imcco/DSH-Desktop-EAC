// Tests for the dsh-file-drop-eac companion plugin's pure core.
// EAC 特化版（取代 dsh-file-drop）：
//   · 普通文件 → 文件卡片 + 紧凑路径引用
//   · 文本文件 → 卡片支持摘要预览，保存失败时才回退内容注入
//   · 图片 → 完全不接管（交给 picturereader / 缩略图，避免重复注入）
//   · 文件夹 → 识别并给出可操作降级提示
// 纯逻辑挂在 lib/client.js 的 `window.__dshFileDropEacCore`（classic-script
// bundle，官方加载器不允许 import），故用 vm 载入真实 bundle 评估。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../assets/plugins/dsh-file-drop-eac/lib/client.js', import.meta.url);

/** 用 stubbed window 载入真实 client bundle，返回暴露的 core。 */
function loadCore(language = '', documentOverrides = {}) {
  const src = readFileSync(BUNDLE, 'utf8');
  const captured = {};
  const win = {
    __ModuleLoader__: { load: (handoff) => { captured.handoff = handoff; } },
  };
  const document = {
    documentElement: { lang: language },
    addEventListener: () => {},
    removeEventListener: () => {},
    ...documentOverrides,
  };
  vm.runInNewContext(src, {
    window: win, document, console, setTimeout, clearTimeout,
    FileReader: class {}, DataTransfer: class {}, InputEvent: class {}, Event: class {},
    HTMLTextAreaElement: { prototype: {} },
  });
  assert.ok(captured.handoff, 'bundle must register via __ModuleLoader__.load');
  assert.equal(captured.handoff.id, 'dsh-file-drop-eac', 'handoff must carry the plugin id');
  assert.ok(win.__dshFileDropEacCore, 'bundle must expose the pure core');
  return { core: win.__dshFileDropEacCore, handoff: captured.handoff };
}

const { core } = loadCore();

test('English UI produces English file and folder instructions for the agent', () => {
  const { core: englishCore } = loadCore('en');
  const pathHint = englishCore.buildPathHint({ name: 'a.zip', path: 'C:\\a.zip', size: 10 });
  const folderHint = englishCore.buildFolderHint([{ name: 'project', virtualPath: '/project' }]);
  assert.match(pathHint, /Dropped file/);
  assert.match(pathHint, /Full path/);
  assert.doesNotMatch(pathHint, /[\u3400-\u9fff]/u);
  assert.match(folderHint, /Dropped folders/);
  assert.doesNotMatch(folderHint, /[\u3400-\u9fff]/u);
});

const TEXT_SAMPLES = ['a.txt', 'main.js', 'b.md', 'c.json', 'd.yaml', 'e.log', 'f.csv', 'Makefile', 'LICENSE', 'package.json'];
const IMAGE_SAMPLES = ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp', 'g.svg'];
const BIN_SAMPLES = ['a.exe', 'b.dll', 'c.bin', 'd.pdb', 'e.zip', 'f.unknownxyz'];

test('bundle registers as dsh-file-drop-eac with a web client', () => {
  assert.equal(typeof core.classifyFile, 'function');
});

test('classifyFile: known text extensions and extensionless files are text', () => {
  for (const name of TEXT_SAMPLES) {
    assert.equal(core.classifyFile(name, 100).kind, 'text', name);
  }
  assert.equal(core.classifyFile('README', 100).kind, 'text', 'extensionless stays text');
});

test('classifyFile: images are image (本插件不接管)', () => {
  for (const name of IMAGE_SAMPLES) {
    assert.equal(core.classifyFile(name, 100).kind, 'image', name);
  }
});

test('classifyFile: .sql 归入「只给路径提示」而非内容注入', () => {
  assert.equal(core.classifyFile('dump.sql', 100).kind, 'binary', 'sql → binary（路径提示）');
  assert.equal(core.classifyFile('init.sql', 100).kind, 'binary');
});

test('classifyFile: binaries and unknown extensions fall back to path hint', () => {
  for (const name of BIN_SAMPLES) {
    assert.equal(core.classifyFile(name, 100).kind, 'binary', name);
  }
});

test('buildTextInsertion wraps content with a filename header', () => {
  const out = core.buildTextInsertion({ name: 'notes.md', content: 'hello\nworld' });
  assert.equal(out.kind, 'text');
  assert.ok(out.text.includes('notes.md'));
  assert.ok(out.text.includes('hello\nworld'));
});

test('buildTextInsertion clamps oversized content to a path hint', () => {
  const big = 'x'.repeat(core.TEXT_MAX_BYTES + 1);
  const out = core.buildTextInsertion({ name: 'huge.txt', content: big, path: 'C:\\huge.txt', size: big.length });
  assert.equal(out.kind, 'path-hint');
  assert.ok(out.text.includes('C:\\huge.txt'));
  assert.ok(!out.text.includes('xxxx'));
});

test('buildPathHint carries name, path and size; missing path yields a readable fallback', () => {
  const withPath = core.buildPathHint({ name: 'a.sql', path: 'D:\\p\\a.sql', size: 2048 });
  assert.ok(withPath.includes('a.sql') && withPath.includes('D:\\p\\a.sql'));
  assert.ok(withPath.includes('2.0 KB'), 'size formatted, not raw bytes');
  const noPath = core.buildPathHint({ name: 'a.sql', size: 2048 });
  assert.ok(noPath.includes('a.sql'));
  assert.ok(!noPath.includes('undefined'));
});

test('looksBinary detects NUL bytes in the head of the content', () => {
  assert.equal(core.looksBinary('plain text'), false);
  assert.equal(core.looksBinary('a\u0000b'), true);
});

test('buildFolderHint lists folders and guides the user (no disk abs path)', () => {
  const hint = core.buildFolderHint([
    { name: 'Fol', virtualPath: '/Fol' },
    { name: '空目录', virtualPath: '/' },
  ]);
  assert.ok(hint.includes('拖入文件夹：2 个'));
  assert.ok(hint.includes('Fol'));
  assert.ok(hint.includes('无法读取文件夹的磁盘绝对路径'));
  assert.ok(hint.includes('文件 / 项目目录'));
});

test('collectEntries separates directory entries from files', () => {
  const { files, folders } = core.collectEntries([
    { webkitGetAsEntry: () => ({ isDirectory: true, name: 'F', fullPath: '/F' }), getAsFile: () => null },
    { webkitGetAsEntry: () => null, getAsFile: () => ({ name: 'a.js', size: 5 }) },
  ]);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].name, 'F');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'a.js');
});

test('planDrop: 图片不接管(skipped)，文本进 texts、二进制进 hints、文件夹进 folders', () => {
  const files = [
    { name: 'a.js', size: 5 },
    { name: 'photo.png', size: 1000 },
    { name: 'b.zip', size: 2048 },
  ];
  const plan = core.planDrop(files, [{ name: 'Fol', virtualPath: '/Fol' }]);
  assert.deepEqual([...plan.skipped], ['photo.png']);
  assert.equal(plan.texts.length, 1);
  assert.equal(plan.texts[0].name, 'a.js');
  assert.equal(plan.hints.length, 1);
  assert.equal(plan.hints[0].name, 'b.zip');
  assert.equal(plan.folders.length, 1);
});

test('TEXT_MAX_BYTES is a sane clamp', () => {
  assert.equal(typeof core.TEXT_MAX_BYTES, 'number');
  assert.ok(core.TEXT_MAX_BYTES >= 65536 && core.TEXT_MAX_BYTES <= 1024 * 1024);
});

test('drop handling is limited to the composer input target', () => {
  const input = { id: 'composer-input' };
  assert.equal(core.composerInputOf({
    closest: (selector) => selector === '[data-composer-input="true"]' ? input : null,
  }), input);
  assert.equal(core.composerInputOf({
    closest: () => null,
  }), null, 'message area and sidebars must not be treated as drop targets');
  assert.equal(core.composerInputOf(null), null);
});

test('appendDraft keeps existing text and terminates the inserted block with a newline', () => {
  assert.equal(core.appendDraft('', 'alpha'), 'alpha\n');
  assert.equal(core.appendDraft('before', 'alpha'), 'before\nalpha\n');
  assert.equal(core.appendDraft('before\n', 'alpha\n'), 'before\nalpha\n');
  assert.equal(core.appendDraft('before', ''), 'before');
});

test('file references stay compact instead of expanding the full text file in the composer', () => {
  const reference = core.buildFileReference({
    name: 'SKILL.md',
    path: 'C:\\Temp\\SKILL.md',
    size: 2048,
  });
  assert.match(reference, /SKILL\.md/);
  assert.match(reference, /C:\\Temp\\SKILL\.md/);
  assert.match(reference, /2\.0 KB/);
  assert.doesNotMatch(reference, /## Workflow/);
});

test('removeInsertedBlock removes only the matching file reference', () => {
  const block = '[拖入文件：SKILL.md]\n完整路径：C:\\Temp\\SKILL.md\n';
  assert.equal(
    core.removeInsertedBlock(`保留文本\n${block}后续文本\n`, block),
    '保留文本\n后续文本\n',
  );
  assert.equal(core.removeInsertedBlock('用户已改写', block), '用户已改写');
});

test('transferLooksImageOnly distinguishes image-only and ordinary file drags', () => {
  assert.equal(core.transferLooksImageOnly({
    types: ['Files'],
    items: [{ kind: 'file', type: 'image/png' }],
  }), true);
  assert.equal(core.transferLooksImageOnly({
    types: ['Files'],
    items: [{ kind: 'file', type: 'text/markdown' }],
  }), false);
  assert.equal(core.transferLooksImageOnly({
    types: ['Files'],
    items: [{ kind: 'file', type: '' }],
  }), false, 'unknown MIME must use the file handler until the drop reveals its name');
});

test('conversation input overlay capture routes inserts through inputActions.setDraft', () => {
  const { core: isolatedCore, handoff } = loadCore();
  let capturedComponent = null;
  let effect = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: (fn) => {
      effect = fn;
      fn();
    },
  };
  const plugin = handoff.factory((name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return { createPortal: (child) => child };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { IconCloseOutline16: () => null, IconPaperclipOutline16: () => null };
    }
    assert.fail(`unexpected module: ${name}`);
  });
  assert.deepEqual([...plugin.inject], ['slots']);
  plugin.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (name, register) => {
        assert.equal(name, 'conversation.input.overlay');
        register();
      },
      register: (_descriptor, component) => {
        capturedComponent = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof capturedComponent, 'function');
  let written = '';
  capturedComponent({
    sessionId: 'session-1',
    inputActions: { setDraft: (value) => { written = value; } },
    useInput: (selector) => selector({ draft: 'existing' }),
  });
  assert.equal(typeof effect, 'function');
  assert.equal(isolatedCore.appendToCurrentDraft('dropped'), true);
  assert.equal(written, 'existing\ndropped\n');
});

test('drag events are prevented only when files are over the composer input', () => {
  const listeners = new Map();
  const { handoff } = loadCore('', {
    addEventListener: (name, listener) => { listeners.set(name, listener); },
    removeEventListener: () => {},
  });
  const plugin = handoff.factory((name) => {
    if (name === 'react') return { useEffect: () => {} };
    if (name === 'react-dom') return { createPortal: (child) => child };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
    assert.fail(`unexpected module: ${name}`);
  });
  plugin.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (_name, register) => register(),
      register: () => () => {},
    },
  });

  const dragover = listeners.get('dragover');
  assert.equal(typeof dragover, 'function');
  let outsidePrevented = 0;
  let outsideStopped = 0;
  dragover({
    target: { closest: () => null },
    dataTransfer: {
      types: ['Files'],
      items: [{ kind: 'file', type: 'text/plain' }],
    },
    preventDefault: () => { outsidePrevented += 1; },
    stopImmediatePropagation: () => { outsideStopped += 1; },
  });
  assert.equal(outsidePrevented, 0);
  assert.equal(outsideStopped, 1, 'ordinary files must not activate the global image overlay');

  const input = {};
  let insidePrevented = 0;
  let insideStopped = 0;
  const dataTransfer = {
    types: ['Files'],
    items: [{ kind: 'file', type: 'text/plain' }],
    dropEffect: 'none',
  };
  dragover({
    target: {
      closest: (selector) => selector === '[data-composer-input="true"]' ? input : null,
    },
    dataTransfer,
    preventDefault: () => { insidePrevented += 1; },
    stopImmediatePropagation: () => { insideStopped += 1; },
  });
  assert.equal(insidePrevented, 1);
  assert.equal(insideStopped, 1);
  assert.equal(dataTransfer.dropEffect, 'copy');

  let imagePrevented = 0;
  let imageStopped = 0;
  dragover({
    target: {
      closest: (selector) => selector === '[data-composer-input="true"]' ? input : null,
    },
    dataTransfer: {
      types: ['Files'],
      items: [{ kind: 'file', type: 'image/png' }],
      dropEffect: 'none',
    },
    preventDefault: () => { imagePrevented += 1; },
    stopImmediatePropagation: () => { imageStopped += 1; },
  });
  assert.equal(imagePrevented, 0);
  assert.equal(imageStopped, 0, 'image-only drags must remain owned by the official attachment plugin');
});
