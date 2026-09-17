import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CLIENT_CSS_REGION_BUILD_PATH =
  /(^[ \t]*\/\/#region \\0dsh-(?:inline-)?css:)(?:[A-Za-z]:)?[^\r\n]*?[\\/](deepseek-harness-[^\\/\r\n]+)[\\/](.+)$/gm;

export function copyKernelCacheForTarget(source, destination, targetPlatform) {
  const buildTree = path.resolve(source, '.build');
  cpSync(source, destination, {
    recursive: true,
    // .build is the package-generation workspace, not a runtime cache. Shipping
    // it adds tens of thousands of pnpm files and can overflow tauri-build while
    // it recursively emits cargo:rerun-if-changed entries on Windows.
    filter: (entry) => path.resolve(entry) !== buildTree,
  });
}

export function sanitizeClientBuildPaths(nodeModules) {
  const scope = path.join(nodeModules, '@deepseek-ai');
  if (!existsSync(scope)) return 0;

  let changed = 0;
  for (const packageName of readdirSync(scope)) {
    const file = path.join(scope, packageName, 'lib', 'client.js');
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const source = readFileSync(file, 'utf8');
    const sanitized = source.replace(
      CLIENT_CSS_REGION_BUILD_PATH,
      (_match, prefix, kernelPackage, relativePath) =>
        `${prefix}${kernelPackage}/${relativePath.replaceAll('\\', '/')}`,
    );
    if (sanitized === source) continue;
    writeFileSync(file, sanitized);
    changed += 1;
  }
  return changed;
}
