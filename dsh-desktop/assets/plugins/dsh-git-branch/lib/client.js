// dsh-git-branch — 输入区 git 灵动岛（Deepseek Harness EAC 原研）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 收起态：分支 pill（git 分支 SVG 图标 + 分支名 + 改动数徽标，按 暂存/未暂存/未跟踪 分色）；
//   · 展开态：灵动岛面板，三 tab ——
//       改动：文件清单（状态字符/路径）、过滤、单文件 diff 抽屉、
//             暂存/取消暂存/丢弃（确认）、全部暂存/取消全部暂存；
//       分支：搜索 + 分支列表，二次确认切换（沿用 0.1 行为）；
//       提交：提交信息 → 全部暂存 + 提交（确认）；最近 10 条提交，
//             点选查看 commit diff（复用 diff 抽屉）；
//   · 可被输入灵动岛（dsh-composer-dynamic-island）收编：根节点保持
//     <button>，插槽 conversation.input.left / id dsh-git-branch / order 50 不变；
//   · 脏工作区 / checkout / commit / discard 失败时展示 git 原始报错
//     （不自动 stash，不碰用户数据）；非 git 工作区 / 无会话目录时隐藏。
//
// 后端全部复用既有端点（零宿主新代码，dsh-better-sidebar / dsh-file-changes）：
//   · GET  /api/dsh-files/session-cwd?sessionId=…      → cwd
//   · POST /sidebar/api/git.status      {cwd}          → {isRepo, branch, entries:[{path, xy}]}
//   · POST /sidebar/api/git.branch      {cwd}          → {current, names[]}
//   · POST /sidebar/api/git.checkout    {cwd, branch}  → {ok}
//   · POST /sidebar/api/git.diff        {cwd, path?, staged?} → {diff}
//   · POST /sidebar/api/git.stage       {cwd, path?}   → {ok}
//   · POST /sidebar/api/git.unstage     {cwd, path?}   → {ok}
//   · POST /sidebar/api/git.commit      {cwd, message} → {ok}
//   · POST /sidebar/api/git.discard     {cwd, path}    → {ok}
//   · POST /sidebar/api/git.log         {cwd, count}   → [{hash, subject, author, date, hashFull, refs}]
//   · POST /sidebar/api/git.commit-diff {cwd, hash}    → {diff}
//   · POST /sidebar/api/fs.read         {cwd, path}    → {kind:'text'|'binary', …}（未跟踪文件内容回退）
//
// 纯逻辑挂在 window.__dshGitBranchCore 上（生产无副作用），供 node 测试
// 直接评估本文件验证 —— 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测，无 react 依赖） ─────────────────────────

  /** 从 /sidebar/api 响应信封解包；!ok 时抛错（携带 git 原始信息）。 */
  function unwrapEnvelope(data) {
    if (!data || typeof data !== 'object') throw new Error('接口无响应');
    if (data.ok !== true) {
      var err = data.error;
      var msg = (err && (err.message || err.code)) || '请求失败';
      throw new Error(String(msg));
    }
    return data.value;
  }

  /**
   * porcelain v1 双字符状态 → 三个布尔维度。
   * xy[0] = 暂存区（'?' 表示未跟踪，不算暂存），xy[1] = 工作区（'?' 同样不算）。
   */
  function xyKinds(xy) {
    var s = String(xy == null ? '' : xy);
    var a = s.charAt(0) || ' ';
    var b = s.charAt(1) || ' ';
    return {
      staged: a !== ' ' && a !== '?',
      unstaged: b !== ' ' && b !== '?',
      untracked: a === '?'
    };
  }

  /** 单个条目的状态字符（展示用）：未跟踪 → U，否则取工作区字符，再退暂存区字符。 */
  function xyGlyph(xy) {
    var kinds = xyKinds(xy);
    var s = String(xy == null ? '' : xy);
    if (kinds.untracked) return 'U';
    var b = s.charAt(1) || ' ';
    return b !== ' ' ? b : (s.charAt(0) || '?');
  }

  /** git.status 响应 → 岛状态（counts 按 暂存/未暂存/未跟踪 分维度）。 */
  function statusToIsland(value) {
    if (!value || value.isRepo !== true) return null;
    var entries = Array.isArray(value.entries) ? value.entries : [];
    var staged = 0, unstaged = 0, untracked = 0;
    for (var i = 0; i < entries.length; i += 1) {
      var k = xyKinds(entries[i] && entries[i].xy);
      if (k.staged) staged += 1;
      if (k.unstaged) unstaged += 1;
      if (k.untracked) untracked += 1;
    }
    return {
      branch: typeof value.branch === 'string' && value.branch ? value.branch : 'HEAD',
      total: entries.length,
      staged: staged,
      unstaged: unstaged,
      untracked: untracked,
      dirty: entries.length > 0,
      entries: statusEntries(value)
    };
  }

  /** git.status entries → 规范化 [{path, xy}]（过滤坏行）。 */
  function statusEntries(value) {
    var raw = value && Array.isArray(value.entries) ? value.entries : [];
    var out = [];
    for (var i = 0; i < raw.length; i += 1) {
      var e = raw[i];
      if (e && typeof e.path === 'string' && e.path !== '') out.push({ path: e.path, xy: String(e.xy || '??') });
    }
    return out;
  }

  /** 默认 diff 来源：有工作区改动 → worktree；未跟踪 → worktree（恒空，客户端回退 fs.read）；仅暂存 → staged。 */
  function diffKindFor(xy) {
    var k = xyKinds(xy);
    if (k.unstaged || k.untracked) return 'worktree';
    return 'staged';
  }

  /** 关键词过滤（大小写不敏感，空查询返回全部）。 */
  function filterEntries(entries, query) {
    var list = Array.isArray(entries) ? entries : [];
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (e) {
      return String(e.path).toLowerCase().indexOf(q) !== -1;
    });
  }

  /** git.branch 响应 → 分支名列表（当前分支已由宿主置顶）。 */
  function branchesToList(value) {
    if (!value || !Array.isArray(value.names)) return [];
    return value.names.map(function (n) { return String(n); });
  }

  /** 过滤分支列表（当前分支始终保留且置顶）。 */
  function filterBranches(names, query, current) {
    var list = Array.isArray(names) ? names : [];
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    var hits = list.filter(function (n) {
      return String(n).toLowerCase().indexOf(q) !== -1;
    });
    var hasCurrent = list.indexOf(current) !== -1 &&
      String(current).toLowerCase().indexOf(q) !== -1;
    return hasCurrent ? hits : [current].concat(hits);
  }

  /** git.log 响应 → 展示行（dateLabel 为本地友好的截断时间）。 */
  function logToRows(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (r) {
      return {
        hash: String(r.hash || ''),
        subject: String(r.subject || ''),
        author: String(r.author || ''),
        date: String(r.date || ''),
        dateLabel: truncateDateLabel(r.date),
        hashFull: String(r.hashFull || r.hash || ''),
        refs: String(r.refs || '')
      };
    });
  }

  /** ISO 时间 → 'YYYY-MM-DD HH:mm'；坏输入返回 ''。 */
  function truncateDateLabel(iso) {
    var s = String(iso == null ? '' : iso);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? m[1] + ' ' + m[2] : '';
  }

  /** diff 文本 → 增删行数（排除文件头 +++/---）。 */
  function diffStats(text) {
    var s = String(text == null ? '' : text);
    var added = 0, removed = 0;
    var lines = s.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      if (l.charAt(0) === '+' && l.indexOf('+++') !== 0) added += 1;
      else if (l.charAt(0) === '-' && l.indexOf('---') !== 0) removed += 1;
    }
    return { added: added, removed: removed };
  }

  /** 分支显示名：超长截断（完整名走 title 提示）。 */
  function displayBranch(name, max) {
    var s = String(name == null ? '' : name);
    var m = max || 24;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }

  if (typeof window !== 'undefined') {
    window.__dshGitBranchCore = {
      unwrapEnvelope: unwrapEnvelope,
      xyKinds: xyKinds,
      xyGlyph: xyGlyph,
      statusToIsland: statusToIsland,
      statusEntries: statusEntries,
      diffKindFor: diffKindFor,
      filterEntries: filterEntries,
      branchesToList: branchesToList,
      filterBranches: filterBranches,
      logToRows: logToRows,
      truncateDateLabel: truncateDateLabel,
      diffStats: diffStats,
      displayBranch: displayBranch
    };
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__ || !window.__ModuleLoader__.load) return;

  // ───────────────────────── 网络（薄封装） ─────────────────────────

  function apiCall(method, payload) {
    return fetch('/sidebar/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.json().catch(function () { return null; });
    }).then(unwrapEnvelope);
  }

  function fetchSessionCwd(sessionId) {
    return fetch('/api/dsh-files/session-cwd?sessionId=' + encodeURIComponent(sessionId))
      .then(function (res) { return res.json().catch(function () { return null; }); })
      .then(function (data) {
        return data && typeof data.cwd === 'string' ? data.cwd : '';
      })
      .catch(function () { return ''; });
  }

  // ───────────────────────── 模块入口 ─────────────────────────

  window.__ModuleLoader__.load({
    // 模块 id 必须与 package.json 的包名一致（加载器按包名校验注册，
    // 作用域包要用完整名；见 dsh-side-session 的 @dsh-external/… 先例）。
    id: '@deepseek-ai/dsh-git-branch',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      var React = require('react');
      var h = React.createElement;

      // ── 样式 ──
      var STYLE_ID = 'dsh-git-branch-style';
      var CSS = [
        '.dgb-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(255,255,255,.12)) 70%,transparent);background:color-mix(in srgb,var(--dsw-specific-selector,rgba(255,255,255,.06)) 88%,transparent);color:var(--dsw-alias-label-secondary,#9aa7c7);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;flex:0 0 auto;transition:border-color .15s,color .15s,background-color .15s}',
        '.dgb-chip:hover{color:var(--dsw-alias-label-primary,#eef2ff);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 46%,transparent);background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.1))}',
        '.dgb-chip svg{flex:none;opacity:.85}',
        '.dgb-branch{max-width:150px;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11.5px}',
        '.dgb-badge{flex:none;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:#f5a623;color:#1a1206;font-size:10px;font-weight:700;line-height:15px;text-align:center;box-shadow:0 0 0 2px color-mix(in srgb,#f5a623 25%,transparent)}',
        '.dgb-badge.dgb-badge-s{background:#3ecf8e;color:#06281a;box-shadow:0 0 0 2px color-mix(in srgb,#3ecf8e 25%,transparent)}',
        '.dgb-badge.dgb-badge-n{background:#4fc3f7;color:#052433;box-shadow:0 0 0 2px color-mix(in srgb,#4fc3f7 25%,transparent)}',
        '.dgb-panel{position:fixed;z-index:2147482999;min-width:320px;max-width:380px;max-height:460px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:12px;background:color-mix(in srgb,var(--dsw-specific-input-major,rgba(20,26,40,.96)) 94%,transparent);box-shadow:0 12px 30px rgba(0,0,0,.4);backdrop-filter:blur(18px) saturate(1.15);-webkit-backdrop-filter:blur(18px) saturate(1.15);color:var(--dsw-alias-label-primary,#eef2ff);font:inherit;font-size:13px}',
        '.dgb-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
        '.dgb-head b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;font-family:var(--ds-font-family-code,Consolas,monospace)}',
        '.dgb-head .dgb-sub{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#7c89ad);font-weight:400}',
        '.dgb-iconbtn{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa7c7);font:inherit;font-size:13px;line-height:1;cursor:pointer;padding:0}',
        '.dgb-iconbtn:hover{background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#eef2ff)}',
        '.dgb-tabs{display:flex;gap:4px;padding:7px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
        '.dgb-tab{padding:6px 10px 8px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#9aa7c7);font:inherit;font-size:12px;cursor:pointer;margin-bottom:-1px}',
        '.dgb-tab:hover{color:var(--dsw-alias-label-primary,#eef2ff)}',
        '.dgb-tab.dgb-tab-on{color:var(--dsw-alias-label-primary,#eef2ff);border-bottom-color:var(--dsw-alias-state-business-primary,#4f7cff)}',
        '.dgb-body{overflow-y:auto;padding:8px 10px;min-height:80px}',
        '.dgb-summary{display:flex;align-items:center;gap:8px;padding:2px 2px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa7c7);flex-wrap:wrap}',
        '.dgb-summary .dgb-sp{flex:1}',
        '.dgb-filter{width:100%;box-sizing:border-box;height:28px;margin:0 0 8px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:8px;background:var(--dsw-specific-input-major,rgba(10,14,24,.6));color:var(--dsw-alias-label-primary,#eef2ff);font:inherit;font-size:12px;outline:none}',
        '.dgb-filter:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 55%,transparent)}',
        '.dgb-frow{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px}',
        '.dgb-frow:hover{background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.06))}',
        '.dgb-glyph{flex:none;width:14px;display:inline-flex;align-items:center;justify-content:center;text-align:center;font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11px;font-weight:700}',
        '.dgb-glyph svg{display:block;opacity:.95}',
        '.dgb-glyph.g-s{color:#3ecf8e}',
        '.dgb-glyph.g-u{color:#f5a623}',
        '.dgb-glyph.g-n{color:#4fc3f7}',
        '.dgb-fpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace);font-size:12px}',
        '.dgb-acts{flex:none;display:flex;gap:4px;opacity:.35;transition:opacity .12s}',
        '.dgb-frow:hover .dgb-acts,.dgb-frow:focus-within .dgb-acts{opacity:1}',
        '.dgb-act{height:20px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-secondary,#9aa7c7);font:inherit;font-size:11px;cursor:pointer}',
        '.dgb-act:hover{background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#eef2ff)}',
        '.dgb-act.dgb-act-danger:hover{color:#ff8f8f;border-color:color-mix(in srgb,#ff8f8f 45%,transparent)}',
        '.dgb-act[disabled]{opacity:.45;cursor:default}',
        '.dgb-btn{height:26px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-specific-selector,rgba(255,255,255,.06));color:inherit;font:inherit;font-size:12px;cursor:pointer;flex:none}',
        '.dgb-btn:hover{background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.1))}',
        '.dgb-btn-primary{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 60%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 22%,transparent)}',
        '.dgb-btn[disabled]{opacity:.5;cursor:default}',
        '.dgb-row{display:flex;align-items:center;gap:7px;width:100%;padding:6px 9px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;text-align:left}',
        '.dgb-row:hover{background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.09))}',
        '.dgb-row .dgb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace)}',
        '.dgb-row.dgb-cur{color:var(--dsw-alias-state-business-primary,#4f7cff)}',
        '.dgb-row .dgb-check{flex:none;font-size:11px}',
        '.dgb-logrow{display:block;width:100%;padding:6px 8px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}',
        '.dgb-logrow:hover{background:var(--dsw-interactive-bg-hover-solid,rgba(255,255,255,.08))}',
        '.dgb-logline1{display:flex;align-items:center;gap:6px;min-width:0}',
        '.dgb-hash{flex:none;font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11px;color:var(--dsw-alias-tertiary-label,#7c89ad)}',
        '.dgb-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
        '.dgb-refs{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--dsw-alias-state-business-primary,#4f7cff)}',
        '.dgb-logmeta{padding:2px 0 0 22px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#7c89ad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dgb-commitbox{display:flex;flex-direction:column;gap:6px;padding:2px 2px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));margin-bottom:6px}',
        '.dgb-commitmsg{width:100%;box-sizing:border-box;height:52px;resize:vertical;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:8px;background:var(--dsw-specific-input-major,rgba(10,14,24,.6));color:var(--dsw-alias-label-primary,#eef2ff);font:inherit;font-size:12px;line-height:18px;outline:none}',
        '.dgb-commitmsg:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 55%,transparent)}',
        '.dgb-diffhead{display:flex;align-items:center;gap:8px;padding:2px 2px 8px}',
        '.dgb-diffpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace);font-size:12px}',
        '.dgb-stats{flex:none;font-size:11px;font-family:var(--ds-font-family-code,Consolas,monospace)}',
        '.dgb-stats .dgb-add{color:#3ecf8e}',
        '.dgb-stats .dgb-del{color:#ff8f8f}',
        '.dgb-diff{margin:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:8px;background:rgba(0,0,0,.25);overflow-x:auto;font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11px;line-height:16px;white-space:pre;max-height:260px;overflow-y:auto}',
        '.dgb-dl-add{color:#7fd8a8}',
        '.dgb-dl-del{color:#ff9d9d}',
        '.dgb-dl-hunk{color:#7fb2ff}',
        '.dgb-actions{display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
        '.dgb-actions .dgb-q{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa7c7)}',
        '.dgb-err{margin:0;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));color:#ff8f8f;font-size:11.5px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:110px;overflow-y:auto}',
        '.dgb-empty{padding:14px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#7c89ad)}',
        '.dgb-busy{padding:14px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa7c7)}'
      ].join('\n');

      function ensureStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById(STYLE_ID)) return;
        var el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      }

      // ── 组件 ──
      // 分支图标：lucide git-branch 标准几何（24×24，stroke 2）——
      // 主干线 + 两个圆节点 + 弧线。用 React.createElement 构建 SVG 元素节点
      //（字符串 '<svg…>' 会当纯文本转义显示成源码，元素节点则正常渲染），
      // stroke=currentColor 跟随 chip / 面板文字颜色，天然后色模式适配。
      function BranchIcon(size) {
        var s = size || 13;
        return h('svg', {
          width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: '2',
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false'
        },
          h('line', { x1: '6', x2: '6', y1: '3', y2: '15' }),
          h('circle', { cx: '18', cy: '6', r: '3' }),
          h('circle', { cx: '6', cy: '18', r: '3' }),
          h('path', { d: 'M18 9a9 9 0 0 1-9 9' })
        );
      }
      var POLL_MS = 15000;
      var LOG_COUNT = 10;
      var TAB_CHANGES = 'changes';
      var TAB_BRANCHES = 'branches';
      var TAB_COMMITS = 'commits';

      function GitBranchIsland(props) {
        var sessionId = props.sessionId;

        var cwdRef = React.useRef('');
        var readyRef = React.useRef(false);
        var chipStateRef = React.useRef(null);
        var [, forceRender] = React.useReducer(function (x) { return x + 1; }, 0);
        var [open, setOpen] = React.useState(false);
        var [tab, setTab] = React.useState(TAB_CHANGES);
        var [filter, setFilter] = React.useState('');
        var [branchList, setBranchList] = React.useState(null);
        var [branchLoading, setBranchLoading] = React.useState(false);
        var [branchQuery, setBranchQuery] = React.useState('');
        var [checkoutTarget, setCheckoutTarget] = React.useState(null);
        var [logs, setLogs] = React.useState(null);
        var [logsLoading, setLogsLoading] = React.useState(false);
        var [commitMsg, setCommitMsg] = React.useState('');
        var [commitConfirm, setCommitConfirm] = React.useState(false);
        var [confirmDiscard, setConfirmDiscard] = React.useState(null);
        var [busy, setBusy] = React.useState(false);
        var [error, setError] = React.useState('');
        var [diffView, setDiffView] = React.useState(null);
        var [diffLoading, setDiffLoading] = React.useState(false);

        var chipRef = React.useRef(null);
        var panelRef = React.useRef(null);

        function getChip() {
          return readyRef.current ? chipStateRef.current : null;
        }

        function fetchStatus() {
          var cwd = cwdRef.current;
          if (!cwd) return Promise.resolve();
          return apiCall('git.status', { sessionId: sessionId, cwd: cwd })
            .then(function (value) { chipStateRef.current = statusToIsland(value); })
            .catch(function () { chipStateRef.current = null; })
            .then(forceRender);
        }

        function fetchBranches() {
          var cwd = cwdRef.current;
          setBranchLoading(true);
          return apiCall('git.branch', { sessionId: sessionId, cwd: cwd })
            .then(function (value) { setBranchList(branchesToList(value)); })
            .catch(function (e) { setError(String((e && e.message) || e)); })
            .then(function () { setBranchLoading(false); });
        }

        function fetchLogs() {
          var cwd = cwdRef.current;
          setLogsLoading(true);
          return apiCall('git.log', { sessionId: sessionId, cwd: cwd, count: LOG_COUNT })
            .then(function (value) { setLogs(logToRows(value)); })
            .catch(function (e) { setError(String((e && e.message) || e)); })
            .then(function () { setLogsLoading(false); });
        }

        // 变更操作后统一刷新：状态必刷；提交 tab 打开时补刷历史。
        function refreshAfterMutation() {
          var p = fetchStatus();
          if (open && tab === TAB_COMMITS) p = p.then(function () { return fetchLogs(); });
          return p;
        }

        // 会话目录解析（一次性）+ 状态轮询 + 窗口聚焦刷新。
        React.useEffect(function () {
          if (!sessionId) return;
          var alive = true;
          fetchSessionCwd(sessionId).then(function (cwd) {
            if (!alive) return;
            cwdRef.current = cwd;
            readyRef.current = true;
            forceRender();
            if (cwd) fetchStatus();
          });
          var timer = window.setInterval(fetchStatus, POLL_MS);
          var onFocus = function () { fetchStatus(); };
          window.addEventListener('focus', onFocus);
          return function () {
            alive = false;
            window.clearInterval(timer);
            window.removeEventListener('focus', onFocus);
          };
        }, [sessionId]);

        // 面板打开时拉分支列表（每次打开刷新，保证切换后状态最新）。
        React.useEffect(function () {
          if (!open) {
            setBranchList(null); setCheckoutTarget(null); setDiffView(null);
            setCommitConfirm(false); setConfirmDiscard(null); setError('');
            return;
          }
          fetchBranches();
        }, [open]);

        // 提交 tab 激活时懒加载历史。
        React.useEffect(function () {
          if (open && tab === TAB_COMMITS && logs === null && !logsLoading) fetchLogs();
        }, [open, tab, logs, logsLoading]);

        // 面板定位：贴 chip 上方、右缘对齐、两端 clamp 进视口。
        var placePanel = React.useCallback(function () {
          var c = chipRef.current, p = panelRef.current;
          if (!c || !p) return;
          var r = c.getBoundingClientRect();
          var pw = p.offsetWidth || 340, ph = p.offsetHeight || 240;
          var margin = 8;
          var left = Math.max(margin, Math.min(r.right - pw, window.innerWidth - margin - pw));
          var top = r.top - ph - 8;
          if (top < margin) top = Math.min(r.bottom + 8, window.innerHeight - margin - ph);
          p.style.left = Math.round(left) + 'px';
          p.style.top = Math.round(top) + 'px';
        }, []);

        React.useEffect(function () {
          if (!open) return;
          placePanel();
          var onResize = function () { placePanel(); };
          window.addEventListener('resize', onResize);
          return function () { window.removeEventListener('resize', onResize); };
        }, [open, placePanel, diffView]);

        // 面板外点击 / Esc 关闭。
        React.useEffect(function () {
          if (!open) return;
          var onDocClick = function (e) {
            if (panelRef.current && panelRef.current.contains(e.target)) return;
            if (chipRef.current && chipRef.current.contains(e.target)) return;
            setOpen(false);
          };
          var onKey = function (e) { if (e.key === 'Escape') setOpen(false); };
          document.addEventListener('mousedown', onDocClick);
          document.addEventListener('keydown', onKey);
          return function () {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
          };
        }, [open]);

        var chip = getChip();
        if (!chip) return null; // 非 git 工作区 / 未就绪 → 隐藏

        // ── 动作 ──
        function runMutation(promise, onDone) {
          setBusy(true);
          setError('');
          return promise
            .then(function (v) {
              setDiffView(null);
              setCheckoutTarget(null);
              setCommitConfirm(false);
              setConfirmDiscard(null);
              if (onDone) onDone(v);
              return refreshAfterMutation();
            })
            .catch(function (e) {
              setError(String((e && e.message) || e));
            })
            .then(function () { setBusy(false); });
        }

        function doStageAll() {
          runMutation(apiCall('git.stage', { sessionId: sessionId, cwd: cwdRef.current }));
        }

        function doUnstageAll() {
          runMutation(apiCall('git.unstage', { sessionId: sessionId, cwd: cwdRef.current }));
        }

        function doStageFile(entry) {
          runMutation(apiCall('git.stage', { sessionId: sessionId, cwd: cwdRef.current, path: entry.path }));
        }

        function doUnstageFile(entry) {
          runMutation(apiCall('git.unstage', { sessionId: sessionId, cwd: cwdRef.current, path: entry.path }));
        }

        function doDiscardFile(entry) {
          setConfirmDiscard(null);
          runMutation(apiCall('git.discard', { sessionId: sessionId, cwd: cwdRef.current, path: entry.path }));
        }

        function doCheckout(branch) {
          setCheckoutTarget(null);
          runMutation(
            apiCall('git.checkout', { sessionId: sessionId, cwd: cwdRef.current, branch: branch }).then(function () {
              setOpen(false);
            }),
            function () { chipStateRef.current = null; } // 立即隐藏，等轮询拉到新分支
          );
        }

        function doCommit() {
          var cwd = cwdRef.current;
          var message = commitMsg;
          setCommitConfirm(false);
          runMutation(
            apiCall('git.stage', { sessionId: sessionId, cwd: cwd }).then(function () {
              return apiCall('git.commit', { sessionId: sessionId, cwd: cwd, message: message });
            }).then(function () { setCommitMsg(''); })
          );
        }

        function openDiffView(title, text, opts) {
          // 非 diff 源（新文件内容/占位）不做增删统计，避免误计内容行。
          var stats = (opts && (opts.source === 'new' || opts.plain))
            ? { added: 0, removed: 0 }
            : diffStats(text);
          setDiffView({
            title: title,
            text: text,
            added: stats.added,
            removed: stats.removed,
            source: (opts && opts.source) || 'diff',
            plain: !!(opts && opts.plain)
          });
        }

        function openFileDiff(entry) {
          var cwd = cwdRef.current;
          var kinds = xyKinds(entry.xy);
          var kind = diffKindFor(entry.xy);
          setDiffLoading(true);
          setError('');
          var p = kind === 'staged'
            ? apiCall('git.diff', { sessionId: sessionId, cwd: cwd, path: entry.path, staged: true })
            : apiCall('git.diff', { sessionId: sessionId, cwd: cwd, path: entry.path });
          p = p.then(function (value) {
            var text = value && typeof value.diff === 'string' ? value.diff : '';
            if (text !== '' || !kinds.untracked) {
              openDiffView(entry.path, text !== '' ? text : '（无 diff 内容）');
              return;
            }
            // 未跟踪文件：worktree diff 恒为空，回退读取文件内容展示。
            return apiCall('fs.read', { sessionId: sessionId, cwd: cwd, path: entry.path }).then(function (f) {
              if (!f) { openDiffView(entry.path, '（无法读取新文件内容）'); return; }
              if (f.kind === 'binary') {
                openDiffView(entry.path, '（二进制新文件，' + (f.size != null ? f.size + ' 字节' : '无法展示内容') + '）', { plain: true });
                return;
              }
              openDiffView(entry.path + '（新文件）', typeof f.content === 'string' ? f.content : '', { source: 'new' });
            });
          });
          p.catch(function (e) { setError('读取 diff 失败：' + String((e && e.message) || e)); })
            .then(function () { setDiffLoading(false); });
        }

        function openCommitDiff(row) {
          var cwd = cwdRef.current;
          setDiffLoading(true);
          setError('');
          apiCall('git.commit-diff', { sessionId: sessionId, cwd: cwd, hash: row.hashFull || row.hash })
            .then(function (value) {
              var text = value && typeof value.diff === 'string' ? value.diff : '';
              openDiffView(row.hash + ' ' + row.subject, text !== '' ? text : '（该提交无 diff 内容）');
            })
            .catch(function (e) { setError('读取提交 diff 失败：' + String((e && e.message) || e)); })
            .then(function () { setDiffLoading(false); });
        }

        // ── diff 抽屉 ──
        var diffNode = null;
        if (diffView) {
          var lines = String(diffView.text).split('\n');
          var diffChildren = [];
          for (var li = 0; li < lines.length; li += 1) {
            var l = lines[li];
            var cls = diffView.plain ? 'dgb-dl-ctx'
              : l.charAt(0) === '+' ? 'dgb-dl-add'
              : l.charAt(0) === '-' ? 'dgb-dl-del'
              : l.charAt(0) === '@' ? 'dgb-dl-hunk'
              : 'dgb-dl-ctx';
            diffChildren.push(h('span', { key: li, className: cls }, l.length ? l : ' '));
          }
          diffNode = h('div', null,
            h('div', { className: 'dgb-diffhead' },
              h('button', {
                type: 'button', className: 'dgb-act', disabled: busy,
                onClick: function () { setDiffView(null); }
              }, '← 返回'),
              h('span', { className: 'dgb-diffpath', title: diffView.title }, diffView.title),
              h('span', { className: 'dgb-stats' },
                h('span', { className: 'dgb-add' }, '+' + diffView.added), ' ',
                h('span', { className: 'dgb-del' }, '-' + diffView.removed))
            ),
            h('pre', { className: 'dgb-diff' }, diffChildren)
          );
        }

        // ── 改动 tab ──
        function changesNode() {
          if (diffView) return diffNode;
          var entries = chip.entries || [];
          var shown = filterEntries(entries, filter);
          if (entries.length === 0) {
            return h('div', { className: 'dgb-empty' }, '工作区干净，没有改动 ✓');
          }
          var rows = shown.map(function (entry) {
            var kinds = xyKinds(entry.xy);
            var glyphCls = kinds.staged ? 'g-s' : (kinds.unstaged ? 'g-u' : 'g-n');
            return h('div', { key: entry.path + '|' + entry.xy, className: 'dgb-frow' },
              h('span', { className: 'dgb-glyph ' + glyphCls, title: entry.xy }, xyGlyph(entry.xy)),
              h('span', { className: 'dgb-fpath', title: entry.path }, entry.path),
              h('span', { className: 'dgb-acts' },
                h('button', {
                  type: 'button', className: 'dgb-act', disabled: busy, title: '查看 diff',
                  onClick: function () { openFileDiff(entry); }
                }, 'diff'),
                (kinds.unstaged || kinds.untracked) ? h('button', {
                  type: 'button', className: 'dgb-act', disabled: busy, title: '暂存该文件',
                  onClick: function () { doStageFile(entry); }
                }, '暂存') : null,
                kinds.staged ? h('button', {
                  type: 'button', className: 'dgb-act', disabled: busy, title: '取消暂存该文件',
                  onClick: function () { doUnstageFile(entry); }
                }, '取消暂存') : null,
                (kinds.unstaged && !kinds.untracked) ? h('button', {
                  type: 'button', className: 'dgb-act dgb-act-danger', disabled: busy, title: '丢弃该文件的工作区改动',
                  onClick: function () { setConfirmDiscard(entry.path); setError(''); }
                }, '丢弃') : null
              )
            );
          });
          return h('div', null,
            h('div', { className: 'dgb-summary' },
              h('span', null, '暂存 ' + chip.staged + ' · 未暂存 ' + chip.unstaged + ' · 未跟踪 ' + chip.untracked),
              h('span', { className: 'dgb-sp' }),
              h('button', {
                type: 'button', className: 'dgb-act', disabled: busy || !chip.dirty,
                onClick: doStageAll, title: 'git add -A'
              }, '全部暂存'),
              h('button', {
                type: 'button', className: 'dgb-act', disabled: busy || chip.staged === 0,
                onClick: doUnstageAll, title: 'git reset'
              }, '取消全部暂存')
            ),
            h('input', {
              className: 'dgb-filter', type: 'text', placeholder: '过滤文件…',
              value: filter, onChange: function (e) { setFilter(e.target.value); }
            }),
            rows.length ? h('div', null, rows) : h('div', { className: 'dgb-empty' }, '没有匹配「' + filter + '」的文件')
          );
        }

        // ── 分支 tab ──
        function branchesNode() {
          var names = branchList || [];
          var shown = filterBranches(names, branchQuery, chip.branch);
          var rows = shown.map(function (name) {
            var isCur = name === chip.branch;
            return h('button', {
              key: name,
              type: 'button',
              className: 'dgb-row' + (isCur ? ' dgb-cur' : ''),
              disabled: isCur || busy,
              title: name,
              onClick: function () { if (!isCur) { setCheckoutTarget(name); setError(''); } }
            },
              h('span', { className: 'dgb-name' }, name),
              isCur ? h('span', { className: 'dgb-check' }, '✓ 当前') : null
            );
          });
          return h('div', null,
            h('input', {
              className: 'dgb-filter', type: 'text', placeholder: '搜索分支…',
              value: branchQuery, onChange: function (e) { setBranchQuery(e.target.value); }
            }),
            branchLoading
              ? h('div', { className: 'dgb-busy' }, '正在读取分支…')
              : (rows.length
                ? h('div', null, rows)
                : h('div', { className: 'dgb-empty' }, branchQuery ? '没有匹配「' + branchQuery + '」的分支' : '没有本地分支'))
          );
        }

        // ── 提交 tab ──
        function commitsNode() {
          if (diffView) return diffNode;
          var logRows = (logs || []).map(function (row) {
            return h('button', {
              key: row.hashFull || row.hash,
              type: 'button',
              className: 'dgb-logrow',
              disabled: busy,
              title: row.subject + '（点击查看 diff）',
              onClick: function () { openCommitDiff(row); }
            },
              h('span', { className: 'dgb-logline1' },
                h('span', { className: 'dgb-hash' }, row.hash),
                h('span', { className: 'dgb-subject' }, row.subject),
                row.refs ? h('span', { className: 'dgb-refs', title: row.refs }, row.refs) : null
              ),
              h('span', { className: 'dgb-logmeta' }, [row.author, row.dateLabel].filter(Boolean).join(' · '))
            );
          });
          return h('div', null,
            h('div', { className: 'dgb-commitbox' },
              h('textarea', {
                className: 'dgb-commitmsg', placeholder: '提交信息（提交前会先全部暂存）…',
                value: commitMsg,
                onChange: function (e) { setCommitMsg(e.target.value); }
              }),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
                h('button', {
                  type: 'button',
                  className: 'dgb-btn dgb-btn-primary',
                  disabled: busy || commitMsg.trim() === '' || !chip.dirty,
                  onClick: function () { setCommitConfirm(true); setError(''); }
                }, '全部暂存并提交')
              )
            ),
            h('div', { className: 'dgb-summary' }, h('span', null, '最近提交')),
            logsLoading
              ? h('div', { className: 'dgb-busy' }, '正在读取提交历史…')
              : (logRows.length ? h('div', null, logRows) : h('div', { className: 'dgb-empty' }, '没有提交历史'))
          );
        }

        var badgeCls = 'dgb-badge' + (chip.staged > 0 ? ' dgb-badge-s' : (chip.unstaged > 0 ? '' : ' dgb-badge-n'));
        var tabButtons = [
          { id: TAB_CHANGES, label: '改动', count: chip.total },
          { id: TAB_BRANCHES, label: '分支' },
          { id: TAB_COMMITS, label: '提交' }
        ];

        return h(React.Fragment, null,
          h('button', {
            ref: chipRef,
            type: 'button',
            className: 'dgb-chip',
            title: chip.dirty
              ? chip.branch + '（' + chip.total + ' 处改动：暂存 ' + chip.staged + ' · 未暂存 ' + chip.unstaged + ' · 未跟踪 ' + chip.untracked + '）'
              : chip.branch,
            onClick: function () { setOpen(function (v) { return !v; }); }
          },
            h('span', { className: 'dgb-glyph' }, BranchIcon(13)),
            h('span', { className: 'dgb-branch' }, displayBranch(chip.branch)),
            chip.dirty
              ? h('i', { className: badgeCls, title: chip.total + ' 处改动' }, chip.total > 9 ? '9+' : String(chip.total))
              : null
          ),
          open ? h('div', { ref: panelRef, className: 'dgb-panel', role: 'dialog', 'aria-label': 'git 灵动岛' },
            h('div', { className: 'dgb-head' },
              h('span', { className: 'dgb-glyph' }, BranchIcon(14)),
              h('b', { title: chip.branch }, chip.branch),
              chip.dirty ? h('span', { className: 'dgb-sub' }, chip.total + ' 处改动') : h('span', { className: 'dgb-sub' }, '干净'),
              h('button', {
                type: 'button', className: 'dgb-iconbtn', title: '刷新', disabled: busy,
                onClick: function () { fetchStatus(); if (tab === TAB_COMMITS) fetchLogs(); }
              }, '↻'),
              h('button', {
                type: 'button', className: 'dgb-iconbtn', title: '关闭',
                onClick: function () { setOpen(false); }
              }, '✕')
            ),
            diffView ? null : h('div', { className: 'dgb-tabs' },
              tabButtons.map(function (t) {
                return h('button', {
                  key: t.id,
                  type: 'button',
                  className: 'dgb-tab' + (tab === t.id ? ' dgb-tab-on' : ''),
                  onClick: function () { setTab(t.id); setDiffView(null); }
                }, t.label + (typeof t.count === 'number' && t.count > 0 ? ' ' + t.count : ''));
              })
            ),
            h('div', { className: 'dgb-body' },
              tab === TAB_BRANCHES ? branchesNode() : (tab === TAB_COMMITS ? commitsNode() : changesNode())
            ),
            checkoutTarget ? h('div', { className: 'dgb-actions' },
              h('span', { className: 'dgb-q' }, '切换到 ' + displayBranch(checkoutTarget, 18) + '？会改动工作区文件'),
              h('button', { type: 'button', className: 'dgb-btn', disabled: busy, onClick: function () { setCheckoutTarget(null); } }, '取消'),
              h('button', { type: 'button', className: 'dgb-btn dgb-btn-primary', disabled: busy, onClick: function () { doCheckout(checkoutTarget); } }, busy ? '切换中…' : '切换')
            ) : null,
            commitConfirm ? h('div', { className: 'dgb-actions' },
              h('span', { className: 'dgb-q' }, '全部暂存 ' + chip.total + ' 处改动并提交？'),
              h('button', { type: 'button', className: 'dgb-btn', disabled: busy, onClick: function () { setCommitConfirm(false); } }, '取消'),
              h('button', { type: 'button', className: 'dgb-btn dgb-btn-primary', disabled: busy, onClick: doCommit }, busy ? '提交中…' : '提交')
            ) : null,
            confirmDiscard ? h('div', { className: 'dgb-actions' },
              h('span', { className: 'dgb-q' }, '丢弃 ' + displayBranch(confirmDiscard, 20) + ' 的改动？不可恢复'),
              h('button', { type: 'button', className: 'dgb-btn', disabled: busy, onClick: function () { setConfirmDiscard(null); } }, '取消'),
              h('button', {
                type: 'button', className: 'dgb-btn dgb-btn-primary', disabled: busy,
                onClick: function () { doDiscardFile({ path: confirmDiscard, xy: ' M' }); },
                style: { borderColor: 'color-mix(in srgb,#ff8f8f 55%,transparent)', background: 'color-mix(in srgb,#ff8f8f 18%,transparent)' }
              }, busy ? '丢弃中…' : '丢弃')
            ) : null,
            (error || diffLoading) ? h('pre', { className: 'dgb-err' }, diffLoading ? '正在读取…' : error) : null
          ) : null
        );
      }

      // ── 插槽注册（与 0.1 完全一致 → 输入灵动岛收编兼容） ──
      function applyGitBranch(ctx) {
        ctx.inject(['slots'], function (scope) {
          scope.slots.inject('conversation.input.left', function () {
            return scope.slots.register({
              name: 'conversation.input.left',
              id: 'dsh-git-branch',
              order: 50,
              inject: function (sessionId) {
                return { sessionId: sessionId || '' };
              }
            }, GitBranchIsland);
          });
        });
      }

      ensureStyles();
      exports.name = 'dsh-git-branch-client';
      exports.inject = ['slots'];
      exports.apply = applyGitBranch;
      return module.exports;
    }
  });
})();
