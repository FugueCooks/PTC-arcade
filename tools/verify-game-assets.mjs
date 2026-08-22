import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'deploy', 'public-assets.manifest.json'), 'utf8'));
let failed = false;

for (const expected of manifest) {
  const directory = expected.kind === 'bios' ? 'bios' : 'games';
  const filePath = path.join(root, 'assets', directory, expected.file);
  try {
    const details = await stat(filePath);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    const digest = hash.digest('hex');
    const valid = details.size === expected.bytes && digest === expected.sha256;
    console.log(`${valid ? 'OK' : 'FAIL'} ${expected.file} (${details.size} bytes)`);
    failed ||= !valid;
  } catch (error) {
    failed = true;
    console.error(`MISSING ${expected.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exitCode = 1;
