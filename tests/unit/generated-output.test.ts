import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('build and test scripts clean generated output before compilation', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts.build ?? '', /clean-generated\.ts build.*tsc -b/u);
  assert.match(packageJson.scripts['test:compile'] ?? '', /clean-generated\.ts tests.*tsc/u);
  assert.match(packageJson.scripts.clean ?? '', /clean-generated\.ts all/u);
});
