import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(
  join(root, 'assets', 'plugins', 'dsh-viewport-lock', 'lib', 'client.js'),
  'utf8',
);

function createHarness(initialHeight = 148) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><main data-phase="active">' +
      '<div data-conversation-scroll><div data-slot="conversation.session"><div></div></div>' +
      '<div data-composer-seat></div></div></main></body></html>',
    { url: 'http://localhost/' },
  );
  const { window } = dom;
  let height = initialHeight;
  let viewBottom = 900;
  let moduleExports;
  const resizeObservers = [];
  const mutationObservers = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnected = false;
      resizeObservers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }

    emit(target) {
      this.callback([{ target }]);
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      mutationObservers.push(this);
    }

    observe() {}

    disconnect() {
      this.disconnected = true;
    }

    emit() {
      this.callback([]);
    }
  }

  Object.defineProperties(window, {
    ResizeObserver: { value: FakeResizeObserver, configurable: true },
    MutationObserver: { value: FakeMutationObserver, configurable: true },
    requestAnimationFrame: {
      value: (callback) => {
        callback(0);
        return 0;
      },
      configurable: true,
    },
    cancelAnimationFrame: { value: () => {}, configurable: true },
    __ModuleLoader__: {
      value: {
        load(spec) {
          moduleExports = spec.factory();
        },
      },
      configurable: true,
    },
  });

  const seat = window.document.querySelector('[data-composer-seat]');
  const scroll = window.document.querySelector('[data-conversation-scroll]');
  const view = window.document.querySelector('[data-slot="conversation.session"] > :first-child');
  Object.defineProperty(scroll, 'getBoundingClientRect', {
    value: () => ({
      x: 0,
      y: 100,
      top: 100,
      right: 900,
      bottom: 800,
      left: 0,
      width: 900,
      height: 700,
      toJSON() {},
    }),
    configurable: true,
  });
  Object.defineProperty(seat, 'getBoundingClientRect', {
    value: () => ({
      x: 0,
      y: 800 - height,
      top: 800 - height,
      right: 900,
      bottom: 800,
      left: 0,
      width: 900,
      height,
      toJSON() {},
    }),
    configurable: true,
  });
  Object.defineProperty(view, 'getBoundingClientRect', {
    value: () => ({
      x: 0,
      y: viewBottom - 1200,
      top: viewBottom - 1200,
      right: 900,
      bottom: viewBottom,
      left: 0,
      width: 900,
      height: 1200,
      toJSON() {},
    }),
    configurable: true,
  });

  new Function('window', 'document', source)(window, window.document);
  return {
    window,
    plugin: moduleExports,
    seat,
    scroll,
    view,
    resizeObservers,
    mutationObservers,
    setHeight(value) {
      height = value;
    },
    setViewBottom(value) {
      viewBottom = value;
    },
  };
}

test('viewport lock keeps the composer transparent and clips only message pixels', () => {
  const { plugin, window } = createHarness();
  const dispose = plugin.apply();
  const style = window.document.getElementById('dsh-viewport-lock');
  assert.ok(style);
  assert.match(style.textContent, /\[data-dsh-composer-clip\]\{clip-path:/);
  assert.doesNotMatch(style.textContent, /\[data-composer-seat\]::before/);
  assert.doesNotMatch(style.textContent, /--dsw-alias-bg-overlay/);
  assert.match(style.textContent, /scroll-padding-bottom:var\(--dsh-composer-safe-height,0px\)/);
  dispose();
  assert.equal(window.document.getElementById('dsh-viewport-lock'), null);
});

test('viewport lock tracks composer height and releases observers cleanly', () => {
  const harness = createHarness(148);
  const dispose = harness.plugin.apply();
  assert.equal(harness.scroll.style.getPropertyValue('--dsh-composer-safe-height'), '148px');
  assert.equal(harness.view.getAttribute('data-dsh-composer-clip'), '');
  assert.equal(harness.view.style.getPropertyValue('--dsh-composer-clip-bottom'), '248px');
  assert.equal(harness.resizeObservers.length, 1);
  assert.equal(harness.mutationObservers.length, 1);

  harness.setHeight(213.2);
  harness.resizeObservers[0].emit(harness.seat);
  assert.equal(harness.scroll.style.getPropertyValue('--dsh-composer-safe-height'), '214px');
  assert.equal(harness.view.style.getPropertyValue('--dsh-composer-clip-bottom'), '314px');

  harness.seat.remove();
  harness.mutationObservers[0].emit();
  assert.equal(harness.scroll.style.getPropertyValue('--dsh-composer-safe-height'), '');
  assert.equal(harness.view.getAttribute('data-dsh-composer-clip'), null);
  assert.equal(harness.view.style.getPropertyValue('--dsh-composer-clip-bottom'), '');
  assert.equal(harness.resizeObservers[0].disconnected, true);

  dispose();
  assert.equal(harness.mutationObservers[0].disconnected, true);
});

test('viewport lock rebinds after the composer seat is mounted again', () => {
  const harness = createHarness(96);
  const dispose = harness.plugin.apply();
  harness.seat.remove();

  const replacement = harness.window.document.createElement('div');
  replacement.setAttribute('data-composer-seat', '');
  Object.defineProperty(replacement, 'getBoundingClientRect', {
    value: () => ({ height: 172.4 }),
    configurable: true,
  });
  harness.scroll.appendChild(replacement);
  harness.mutationObservers[0].emit();

  assert.equal(harness.resizeObservers.length, 2);
  assert.equal(harness.resizeObservers[0].disconnected, true);
  assert.equal(harness.scroll.style.getPropertyValue('--dsh-composer-safe-height'), '173px');
  dispose();
  assert.equal(harness.resizeObservers[1].disconnected, true);
});

test('viewport lock updates the transparent clip boundary while scrolling', () => {
  const harness = createHarness(148);
  const dispose = harness.plugin.apply();
  assert.equal(harness.view.style.getPropertyValue('--dsh-composer-clip-bottom'), '248px');

  harness.setViewBottom(760);
  harness.scroll.dispatchEvent(new harness.window.Event('scroll'));
  assert.equal(harness.view.style.getPropertyValue('--dsh-composer-clip-bottom'), '108px');

  harness.setViewBottom(652);
  harness.scroll.dispatchEvent(new harness.window.Event('scroll'));
  assert.equal(harness.view.style.getPropertyValue('--dsh-composer-clip-bottom'), '0px');
  dispose();
  assert.equal(harness.view.getAttribute('data-dsh-composer-clip'), null);
});
