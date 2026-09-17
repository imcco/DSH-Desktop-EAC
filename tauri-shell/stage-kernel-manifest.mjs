import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RELATIVE_KERNEL_PREFIX = 'file:vendor/kernel/';

export function absolutizeKernelFileReferences(source, kernelCache) {
  const absoluteKernel = path.resolve(kernelCache).replaceAll('\\', '/').replace(/\/$/, '');
  return source.replaceAll(RELATIVE_KERNEL_PREFIX, `file:${absoluteKernel}/`);
}

export function withAbsolutizedKernelManifests(manifests, kernelCache, operation) {
  const originals = new Map(manifests.map((manifest) => [manifest, readFileSync(manifest, 'utf8')]));
  try {
    for (const [manifest, source] of originals) {
      writeFileSync(manifest, absolutizeKernelFileReferences(source, kernelCache));
    }
    return operation();
  } finally {
    for (const [manifest, source] of originals) writeFileSync(manifest, source);
  }
}
