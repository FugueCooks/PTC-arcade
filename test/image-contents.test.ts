import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_DIRECTORIES, ROOT_FILES } from '../server/src/http/static-hosting.js';

/**
 * The runtime image is assembled from an explicit COPY list, so a directory
 * added to the server after the Dockerfile was written is simply absent in
 * production — and absent quietly, because everything that reads it is either
 * off by default or only reached from one page. `ops-dashboard/` shipped that
 * way: `/ops` would have 404'd the first time an operator set
 * OPERATIONS_OPERATORS and went looking for the console.
 *
 * This test holds the image to what the server actually reads at runtime.
 */
const dockerfile = await readFile(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');

/** Every path the final stage copies into the runtime image. */
function copiedPaths(): Set<string> {
  const copied = new Set<string>();
  const [, runtimeStage = ''] = dockerfile.split(/^FROM .* AS runtime$/m);
  for (const line of runtimeStage.split('\n')) {
    const match = /^COPY --from=build\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    // The last token is the destination; everything before it is a source.
    const tokens = match[1].split(/\s+/);
    for (const source of tokens.slice(0, -1)) copied.add(source.replace(/^\/app\//, ''));
  }
  return copied;
}

void test('the image contains every directory the server serves publicly', () => {
  const copied = copiedPaths();
  for (const directory of PUBLIC_DIRECTORIES) {
    assert.ok(copied.has(directory), `${directory}/ is served but never copied into the runtime image`);
  }
});

void test('the image contains every root file the server serves', () => {
  const copied = copiedPaths();
  for (const file of ROOT_FILES) {
    assert.ok(copied.has(file), `${file} is served but never copied into the runtime image`);
  }
});

void test('the image contains the directories the optional subsystems read', () => {
  // Both are off by default, so a missing directory surfaces only once an
  // operator turns the feature on — long after the deploy that dropped it.
  const copied = copiedPaths();
  assert.ok(copied.has('ops-dashboard'), 'the operations console is served from ops-dashboard/');
  assert.ok(copied.has('plugins'), 'first-party plugins are imported from plugins/');
});

void test('the image does not carry server source, tests, or local tooling', () => {
  const copied = copiedPaths();
  for (const excluded of ['server', 'test', 'docs', 'deploy', 'tools', 'cloudflare']) {
    assert.ok(!copied.has(excluded), `${excluded}/ must not ship in the runtime image`);
  }
  assert.ok(copied.has('dist/server'), 'the compiled server is what runs');
});
