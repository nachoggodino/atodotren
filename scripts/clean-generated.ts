#!/usr/bin/env node
import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

type CleanScope = 'all' | 'build' | 'tests';

async function workspaceDistDirectories(root: string, parent: 'apps' | 'packages'): Promise<string[]> {
  const entries = await readdir(resolve(root, parent), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, parent, entry.name, 'dist'));
}

export async function cleanGeneratedOutput(
  root: string,
  scope: CleanScope,
): Promise<void> {
  const directories =
    scope === 'tests'
      ? [resolve(root, 'tests/dist')]
      : [
          ...(await workspaceDistDirectories(root, 'apps')),
          ...(await workspaceDistDirectories(root, 'packages')),
          ...(scope === 'all'
            ? [resolve(root, 'scripts/dist'), resolve(root, 'tests/dist')]
            : []),
        ];
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

if (import.meta.main) {
  const requested = process.argv[2] ?? 'all';
  if (!['all', 'build', 'tests'].includes(requested)) {
    throw new Error(`Unknown clean scope: ${requested}`);
  }
  await cleanGeneratedOutput(process.cwd(), requested as CleanScope);
}
