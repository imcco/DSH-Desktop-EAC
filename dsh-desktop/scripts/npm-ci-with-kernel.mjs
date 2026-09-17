#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withAbsolutizedKernelManifests } from '../../tauri-shell/stage-kernel-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveNpmCli() {
  const executableDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

export function runNpmCi(extraArgs = []) {
  const manifests = ['package.json', 'package-lock.json'].map((name) => path.join(ROOT, name));
  const kernelCache = path.join(ROOT, 'vendor', 'kernel');
  return withAbsolutizedKernelManifests(manifests, kernelCache, () => {
    const npmCli = resolveNpmCli();
    const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const args = npmCli ? [npmCli, 'ci', ...extraArgs] : ['ci', ...extraArgs];
    const result = spawnSync(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: !npmCli && process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ci 失败，退出码 ${result.status}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    runNpmCi(process.argv.slice(2));
  } catch (error) {
    console.error('npm-ci-with-kernel:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
