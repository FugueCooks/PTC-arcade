import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'deploy', 'public-assets.manifest.json'), 'utf8'));
const required = ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) throw new Error(`Missing storage configuration: ${missing.join(', ')}`);

const endpoint = process.env.STORAGE_ENDPOINT.trim();
const bucket = process.env.STORAGE_BUCKET.trim();
const region = process.env.STORAGE_REGION?.trim() || 'auto';
const prefix = cleanPrefix(process.env.STORAGE_PREFIX || 'arcade');
const forceUpload = process.env.STORAGE_FORCE_UPLOAD === '1';
const client = new S3Client({
  endpoint,
  region,
  maxAttempts: 12,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === '1',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY.trim()
  }
});

for (const asset of manifest) {
  const directory = asset.kind === 'bios' ? 'bios' : 'games';
  const source = path.join(root, 'assets', directory, asset.file);
  const details = await stat(source);
  if (details.size !== asset.bytes) throw new Error(`Size mismatch for ${asset.file}: expected ${asset.bytes}, found ${details.size}`);
  const key = [prefix, directory, asset.file].filter(Boolean).join('/');
  if (!forceUpload && await alreadyUploaded(key, asset)) {
    console.log(`SKIP ${key} (remote checksum metadata matches)`);
    continue;
  }
  console.log(`UPLOAD ${key} (${details.size} bytes)`);
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(source),
      ContentType: 'application/octet-stream',
      ContentDisposition: 'inline',
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { sha256: asset.sha256, kind: asset.kind }
    },
    // A single multipart stream is slower, but is substantially more reliable
    // on consumer upload connections and avoids saturating the upstream link.
    queueSize: 1,
    partSize: 16 * 1024 * 1024,
    leavePartsOnError: false
  });
  let lastPercent = -1;
  upload.on('httpUploadProgress', ({ loaded = 0, total = details.size }) => {
    const percent = Math.floor(loaded / total * 100);
    if (percent >= lastPercent + 10 || percent === 100) {
      process.stdout.write(`  ${percent}%\n`);
      lastPercent = percent;
    }
  });
  await upload.done();
  console.log(`OK ${key}`);
}

const publicBase = process.env.STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
if (publicBase) {
  const rootUrl = [publicBase, prefix].filter(Boolean).join('/');
  console.log('\nProduction runtime configuration:');
  console.log(`GAME_ASSET_BASE_URL=${rootUrl}/games`);
  console.log(`BIOS_ASSET_URL=${rootUrl}/bios/SCPH1001.BIN`);
}

async function alreadyUploaded(key, asset) {
  try {
    const remote = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return Number(remote.ContentLength) === asset.bytes && remote.Metadata?.sha256 === asset.sha256;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return false;
    throw error;
  }
}

function cleanPrefix(value) {
  return value.trim().replace(/^\/+|\/+$/g, '');
}
