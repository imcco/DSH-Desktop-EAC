import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'assets', 'plugins', 'dsh-raw-html', 'lib', 'client.js');

interface SanitizerExports {
  sanitizeVcpHtml(html: string): string;
  sanitizeCss(css: string): string;
  isAllowedUrl(value: string, image?: boolean): boolean;
  hasVcpRoot(text: string): boolean;
}

/** 在 jsdom 中加载真实的 client.js 工厂，取回安全过滤函数。 */
function loadSanitizer(): SanitizerExports {
  const source = readFileSync(clientPath, 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  let captured: { factory: (require: (id: string) => unknown) => unknown } | null = null;
  (window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load(def: { factory: (require: (id: string) => unknown) => unknown }) {
      captured = def;
    },
  };
  window.eval(source);
  assert.ok(captured, 'client.js must register itself through window.__ModuleLoader__.load');
  const moduleExports = captured.factory((id) => {
    if (id === 'react') return { createElement: () => null };
    throw new Error(`unexpected require inside client.js factory: ${id}`);
  });
  return moduleExports as unknown as SanitizerExports;
}

const s = loadSanitizer();

test('sanitizer functions are exported from client.js for testing', () => {
  for (const fn of ['sanitizeVcpHtml', 'sanitizeCss', 'isAllowedUrl', 'hasVcpRoot'] as const) {
    assert.equal(typeof s[fn], 'function', `${fn} must be exported`);
  }
});

test('hasVcpRoot detects only the exact vcp-root marker', () => {
  assert.equal(s.hasVcpRoot('<div id="vcp-root"><p>hi</p></div>'), true);
  assert.equal(s.hasVcpRoot('<div id="vcp-roots">x</div>'), false);
  assert.equal(s.hasVcpRoot('<div class="vcp-root">x</div>'), false);
  assert.equal(s.hasVcpRoot('plain text'), false);
});

test('sanitizeVcpHtml requires #vcp-root and returns empty otherwise', () => {
  assert.equal(s.sanitizeVcpHtml('<p>no root here</p>'), '');
  assert.equal(s.sanitizeVcpHtml(''), '');
  assert.equal(s.sanitizeVcpHtml('<div id="vcp-root">ok</div>').length > 0, true);
});

test('sanitizeVcpHtml strips script/iframe/object/embed/base/meta/link', () => {
  const html = [
    '<div id="vcp-root">',
    '<script>alert(1)</script>',
    '<iframe src="//evil.example"></iframe>',
    '<object data="//evil.example"></object>',
    '<embed src="//evil.example">',
    '<base href="//evil.example">',
    '<meta http-equiv="refresh" content="0;url=//evil.example">',
    '<link rel="stylesheet" href="//evil.example">',
    '<p>kept</p>',
    '</div>',
  ].join('');
  const out = s.sanitizeVcpHtml(html);
  assert.match(out, /id="vcp-root"/);
  assert.match(out, /kept/);
  for (const tag of ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link']) {
    assert.doesNotMatch(out, new RegExp(`<${tag}\\b`, 'i'), `${tag} must be removed`);
  }
});

test('sanitizeVcpHtml keeps only the controlled input() onclick bridge', () => {
  const out = s.sanitizeVcpHtml(
    '<div id="vcp-root"><button onclick="input(\'发送文案\')">go</button>' +
      '<button onclick="alert(1)">bad</button><img src="x" onerror="steal()"></div>',
  );
  assert.match(out, /data-vcp-input="发送文案"/);
  assert.doesNotMatch(out, /onclick\s*=/);
  assert.doesNotMatch(out, /onerror\s*=/);
});

test('sanitizeVcpHtml drops on* attributes and dangerous attributes', () => {
  const out = s.sanitizeVcpHtml(
    '<div id="vcp-root">' +
      '<img src="a.png" onload="x()" srcdoc="<script>x</script>" srcset="a 1x, b 2x">' +
      '<form action="//evil" formaction="//evil"><input></form>' +
      '</div>',
  );
  assert.doesNotMatch(out, /onload\s*=/);
  assert.doesNotMatch(out, /srcdoc\s*=/);
  assert.doesNotMatch(out, /srcset\s*=/);
  assert.doesNotMatch(out, /action\s*=/);
  assert.doesNotMatch(out, /formaction\s*=/);
});

test('sanitizeVcpHtml filters javascript: URLs and keeps safe ones', () => {
  const out = s.sanitizeVcpHtml(
    '<div id="vcp-root">' +
      '<a href="javascript:alert(1)">bad</a>' +
      '<a href="https://ok.example/a">good</a>' +
      '<a href="/relative">rel</a>' +
      '<a href="#section">anchor</a>' +
      '<img src="data:image/png;base64,AAAA">' +
      '<img src="data:text/html;base64,PGI+">' +
      '</div>',
  );
  assert.match(out, /https:\/\/ok\.example/);
  assert.match(out, /href="\/relative"/);
  assert.match(out, /href="#section"/);
  assert.match(out, /data:image\/png;base64,AAAA/);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /data:text\/html/i);
});

test('sanitizeVcpHtml sanitizes inline style', () => {
  const out = s.sanitizeVcpHtml(
    '<div id="vcp-root"><p style="position:fixed;color:red;background:url(javascript:alert(1))">x</p></div>',
  );
  assert.doesNotMatch(out, /position\s*:\s*fixed/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /color:\s*red/);
});

test('sanitizeVcpHtml adds rel=noopener to _blank links', () => {
  const out = s.sanitizeVcpHtml(
    '<div id="vcp-root"><a href="https://example.com" target="_blank">x</a></div>',
  );
  assert.match(out, /rel="noopener noreferrer"/);
});

test('sanitizeVcpHtml sanitizes <template> content subtree (nested included)', () => {
  // <template> 的 content 是独立 DocumentFragment，querySelectorAll('*') 不进入，
  // 模板内节点原本会整体绕过属性净化，克隆挂载后原样生效——必须递归净化。
  const html = [
    '<div id="vcp-root">',
    '<template>',
    '<img src="a.png" onerror="steal()">',
    '<a href="javascript:alert(1)">t</a>',
    '<div style="position:fixed;background:url(//evil.example/px.gif)">t</div>',
    '<template><script>alert(2)</script></template>',
    '</template>',
    '<p>kept</p>',
    '</div>',
  ].join('');
  const out = s.sanitizeVcpHtml(html);
  assert.match(out, /<template>/i, 'template element itself is kept');
  assert.match(out, /kept/);
  assert.doesNotMatch(out, /onerror\s*=/i, 'event handlers inside template must be stripped');
  assert.doesNotMatch(out, /javascript:/i, 'javascript: href inside template must be stripped');
  assert.doesNotMatch(out, /position\s*:\s*fixed/i, 'inline style inside template must be sanitized');
  assert.doesNotMatch(out, /evil\.example/i, 'external css url inside template must be neutralized');
  assert.doesNotMatch(out, /<script\b/i, 'script inside nested template must be removed');
});

test('sanitizeVcpHtml strips SMIL animation elements inside and outside <svg>', () => {
  // SMIL 动画元素可在渲染期动态改写其他元素属性（如把 href 动画成 javascript:），
  // 绕过静态净化，必须整体移除；链接本身保留。
  const html =
    '<div id="vcp-root">' +
    '<svg><a href="https://ok.example/x">' +
    '<animate attributeName="href" to="javascript:alert(1)"></animate>' +
    '<set attributeName="href" to="javascript:alert(2)"></set>' +
    '<animateTransform attributeName="href" to="javascript:alert(3)"></animateTransform>' +
    '</a></svg>' +
    '<animate attributeName="href" to="javascript:alert(4)"></animate>' +
    '</div>';
  const out = s.sanitizeVcpHtml(html);
  assert.match(out, /ok\.example/, 'the link itself is kept');
  for (const tag of ['animate', 'set', 'animateTransform']) {
    assert.doesNotMatch(out, new RegExp(`<${tag}\\b`, 'i'), `${tag} must be removed`);
  }
});

test('sanitizeVcpHtml forces external http(s) links into a new tab with noopener', () => {
  // 外链在本窗口点击会把整个 Web UI 导航离站：统一 target=_blank；
  // rel=noopener noreferrer 切断 window.opener 反向操控。
  const out = s.sanitizeVcpHtml(
    '<div id="vcp-root">' +
      '<a href="https://example.com/a">ext-plain</a>' +
      '<a href="http://example.com/b" target="_self">ext-self</a>' +
      '<a href="https://example.com/c" target="_blank">ext-blank</a>' +
      '<a href="/internal">int</a>' +
      '<a href="#/route">route</a>' +
      '</div>',
  );
  assert.equal((out.match(/target="_blank"/g) || []).length, 3,
    'all external http(s) links must open in a new tab');
  assert.equal((out.match(/rel="noopener noreferrer"/g) || []).length, 3,
    'every new-tab link must cut the opener relationship');
  assert.doesNotMatch(out, /target="_self"/i, 'in-window navigation to external origin must be overridden');
  assert.doesNotMatch(out, /href="\/internal"[^>]*target=/i, 'internal link must not gain target');
  assert.doesNotMatch(out, /href="#\/route"[^>]*target=/i, 'hash-route link must not gain target');
});

test('isAllowedUrl protocol allowlist', () => {
  assert.equal(s.isAllowedUrl('https://example.com'), true);
  assert.equal(s.isAllowedUrl('http://example.com'), true);
  assert.equal(s.isAllowedUrl('/relative/path'), true);
  assert.equal(s.isAllowedUrl('#fragment'), true);
  assert.equal(s.isAllowedUrl('javascript:alert(1)'), false);
  assert.equal(s.isAllowedUrl('//evil.example'), false);
  assert.equal(s.isAllowedUrl('data:text/html,<b>x</b>'), false);
  assert.equal(s.isAllowedUrl('file:///etc/passwd'), false);
  assert.equal(s.isAllowedUrl('mailto:a@b.c', false), true);
  assert.equal(s.isAllowedUrl('mailto:a@b.c', true), false);
  assert.equal(s.isAllowedUrl('data:image/png;base64,AAAA', true), true);
  assert.equal(s.isAllowedUrl('data:image/png;base64,AAAA', false), false);
});

test('sanitizeCss strips dangerous CSS constructs', () => {
  const out = s.sanitizeCss(
    '@import url("//evil");color:red;' +
      'background:url(javascript:alert(1));' +
      'expression(alert(1));' +
      'behavior:url(x);' +
      'position:fixed;left:0;' +
      'z-index:9999;' +
      'z-index:99;' +
      'position:sticky;top:0;' +
      'content:"x";',
  );
  assert.doesNotMatch(out, /@import/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /expression/i);
  assert.doesNotMatch(out, /behavior/i);
  assert.doesNotMatch(out, /position\s*:\s*fixed/i);
  assert.doesNotMatch(out, /position\s*:\s*sticky/i);
  assert.doesNotMatch(out, /z-index\s*:\s*9999/i);
  assert.doesNotMatch(out, /content\s*:/i);
  assert.match(out, /color:\s*red/);
  assert.match(out, /z-index\s*:\s*99/i);
});

test('sanitizeCss url() whitelist neutralizes every external url() form', () => {
  // 外链 url 会随渲染向第三方发请求（追踪像素/数据外带）：协议相对 //、
  // http(s)、javascript:、其余 data:（含 data:text/html）都必须中和。
  // 三种引号形态（无引号/"…"/'…'）都要覆盖。
  const out = s.sanitizeCss(
    'background:url(//evil.example/px.gif);' +
      'background:url("http://evil.example/px.gif");' +
      "background:url('https://evil.example/exfil');" +
      'background:url(javascript:alert(1));' +
      'background:url(data:text/html;base64,PGI+);',
  );
  assert.equal((out.match(/url\(about:blank\)/g) || []).length, 5,
    'each of the five external url() forms must be replaced with url(about:blank)');
  assert.doesNotMatch(out, /evil\.example/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /data:text\/html/i);
});

test('sanitizeCss url() whitelist keeps same-document/same-origin/data-image forms', () => {
  // 放行面：同文档引用（SVG 渐变 url(#g)、应用内 #/ 路由）、同源根相对路径
  // （/fonts/… 字体契约，下载内嵌依赖）、data:image/ 内联图片。
  const keep = s.sanitizeCss(
    'background:url("#/dashboard");' +
      "background:url('data:image/png;base64,AAAA');" +
      'background:url(/fonts/Lanxi-WenKai.woff2);' +
      'fill:url(#grad);',
  );
  assert.match(keep, /url\("#\/dashboard"\)/, 'hash-route relative url must survive');
  assert.match(keep, /url\('data:image\/png;base64,AAAA'\)/, 'data:image url must survive');
  assert.match(keep, /url\(\/fonts\/Lanxi-WenKai\.woff2\)/,
    'plugin font contract (/fonts/…) must survive sanitization');
  assert.match(keep, /url\(#grad\)/, 'SVG paint server reference must survive');
  assert.doesNotMatch(keep, /about:blank/);
});

test('sanitizeCss closes the escaped-quote url() bypass (P1 regression)', () => {
  // 转义引号（\"）令旧正则的 [^"]* 提前失配 → 整个 url() 不匹配、原文存活。
  // 浏览器会把 \" 解码为引号，串值 //evil.com/"x 是协议相对外链（数据外带）。
  const out = s.sanitizeCss('div{background:url("//evil.com/\\"x")}')
  assert.doesNotMatch(out, /evil\.com/, 'escaped-quote protocol-relative url must not survive');
});

test('sanitizeCss judges escaped schemes by decoded semantics', () => {
  // java\73 cript: 解码后 = javascript: —— 必须中和。
  const ESC = String.fromCharCode(92); // 反斜杠（避开 heredoc/严格模式转义层）
  const out = s.sanitizeCss('a{background:url(java' + ESC + '73 cript:alert(1))}')
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /url\(about:blank\)/);
});

test('sanitizeCss strips escape-obfuscated @import (at-keyword escapes)', () => {
  // @\69 mport 解码后 = @import（\69 = i）：浏览器照样发起远程样式表请求。
  const ESC = String.fromCharCode(92);
  const out = s.sanitizeCss('@' + ESC + '69 mport "//evil.com/x.css";body{color:red}')
  assert.doesNotMatch(out, /evil\.com/, 'escaped @import must be stripped');
  assert.match(out, /color:\s*red/, 'subsequent rules must survive');
  // 字面形态回归（既有行为保持）
  const plain = s.sanitizeCss('@import url("//evil.com/y.css");body{color:blue}')
  assert.doesNotMatch(plain, /evil\.com/);
  assert.match(plain, /color:\s*blue/);
});

test('sanitizeCss fail-closed on unterminated quoted url()', () => {
  const out = s.sanitizeCss('background:url("//evil.com/x')
  assert.doesNotMatch(out, /evil\.com/, 'unterminated quoted url must be neutralized');
});

test('sanitizeCss consumes escaped-paren bare url() without residue', () => {
  // 裸串内转义括号：旧正则裸分支不含转义对，残留 b) 产垃圾 CSS；现整体消费。
  const ESC = String.fromCharCode(92);
  const out = s.sanitizeCss('background:url(http://evil.example/a' + ESC + ')b)')
  assert.doesNotMatch(out, /evil\.example/);
  assert.doesNotMatch(out, /b\)/, 'no residue after escaped paren');
});
