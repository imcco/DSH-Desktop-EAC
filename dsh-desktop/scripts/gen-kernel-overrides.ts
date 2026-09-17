'use strict';

// 把 vendored 内核 tarball 缓存（vendor/kernel/<version>/）接线进 package.json。
//
// Why: @deepseek-ai/dsh 0.1.2-alpha.1 未发布 npm（npmmirror / npmjs 均停在
// 0.1.1-rc.2），内核改由 GitHub tag 源码构建（见 scripts/fetch-kernel.ts），
// 产物 tarball 缓存在 vendor/kernel/<version>/（gitignored）。npm 的规则：
// overrides 指向直接依赖时值必须与依赖 spec 完全一致（EOVERRIDE），因此本
// 脚本把全部 @deepseek-ai/* 直接依赖改写为与 overrides 相同的 file: tarball
// spec，其余内核包走 overrides 兜底，保证整棵依赖树（含 peer 声明）全部解析
// 到同一份本地构建，不与 registry 上的旧版本混装。
//
// 幂等：重复运行按当前 tarball 名单整体重写 @deepseek-ai/* 相关字段。
// 用法：npm run gen-kernel-overrides [-- [vendor 子目录名]]

import fs = require('node:fs');
import path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_KERNEL = path.join(ROOT, 'vendor', 'kernel');

// 内核共享包在 monorepo 里靠 workspace 互链解析，发布面没人在 dependencies
// 里声明（只有裸 import / peerDependencies），legacy-peer-deps 下 npm 不会
// 安装它们。这份清单来自依赖缺口扫描（import 名单 − 已声明名单），按需人工
// 增补；生成器把它们一并写入直接依赖（file: spec）。
const KERNEL_DEP_GAPS = [
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-hook-protocol',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-util-time',
  '@deepseek-ai/dsh-util-workspace-path',
];

/** 从 tarball 文件名解析包名：deepseek-ai-<pkg>-<semver>.tgz → @deepseek-ai/<pkg>。 */
function packageNameOf(filename: string): string | null {
  const m = /^deepseek-ai-(.+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/.exec(filename);
  return m ? `@deepseek-ai/${m[1]}` : null;
}

function main(): void {
  const argVersion = process.argv[2];
  const versions = fs.existsSync(VENDOR_KERNEL)
    ? fs.readdirSync(VENDOR_KERNEL).filter((e) =>
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(e)
      && fs.statSync(path.join(VENDOR_KERNEL, e)).isDirectory())
    : [];
  if (versions.length === 0) {
    console.error('gen-kernel-overrides: vendor/kernel/ 下没有构建缓存；先运行 npm run fetch-kernel');
    process.exit(1);
  }
  const version = argVersion ?? (versions.length === 1 ? versions[0] : null);
  if (!version) {
    console.error(`gen-kernel-overrides: vendor/kernel/ 下有多个版本（${versions.join(', ')}），需显式指定`);
    process.exit(1);
  }
  const dir = path.join(VENDOR_KERNEL, version);
  if (!fs.existsSync(dir)) {
    console.error(`gen-kernel-overrides: 缓存目录不存在: ${dir}`);
    process.exit(1);
  }

  const tarballs = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  const specByName = new Map<string, string>();
  for (const file of tarballs) {
    const name = packageNameOf(file);
    if (!name) {
      console.error(`gen-kernel-overrides: 无法从文件名解析包名，跳过 ${file}`);
      continue;
    }
    specByName.set(name, `file:vendor/kernel/${version}/${file}`);
  }
  if (specByName.size === 0) {
    console.error('gen-kernel-overrides: 缓存目录里没有可识别的 tarball');
    process.exit(1);
  }

  const manifestPath = path.join(ROOT, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  manifest.dependencies = manifest.dependencies ?? {};

  let gapCount = 0;
  for (const gapName of KERNEL_DEP_GAPS) {
    if (manifest.dependencies[gapName] !== undefined) continue;
    const spec = specByName.get(gapName);
    if (!spec) {
      console.error(`gen-kernel-overrides: 缺口包 ${gapName} 在内核缓存里没有 tarball`);
      process.exit(1);
    }
    manifest.dependencies[gapName] = spec;
    gapCount += 1;
  }

  let directCount = 0;
  for (const depName of Object.keys(manifest.dependencies)) {
    if (!depName.startsWith('@deepseek-ai/')) continue;
    const spec = specByName.get(depName);
    if (!spec) {
      console.error(`gen-kernel-overrides: 直接依赖 ${depName} 在内核缓存里没有对应 tarball（包被移除？）`);
      process.exit(1);
    }
    manifest.dependencies[depName] = spec;
    directCount += 1;
  }

  // 保留非 @deepseek-ai 的安全钉与应用级 override。旧实现整体覆盖 overrides，
  // 会在每次重建内核缓存时静默抹掉 glob/qs 等漏洞修复钉。
  const nonKernelOverrides = Object.entries(manifest.overrides ?? {})
    .filter(([name]) => !name.startsWith('@deepseek-ai/'));
  manifest.overrides = Object.fromEntries(
    [...nonKernelOverrides, ...specByName.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`gen-kernel-overrides: 内核 ${version} → 直接依赖 ${directCount} 个改写 + 缺口补 ${gapCount} 个，overrides 共 ${specByName.size} 个包`);
}

main();
