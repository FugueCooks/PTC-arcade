import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const values = new Map(process.argv.slice(2).map(argument => {
  const separator = argument.indexOf('=');
  return separator < 0 ? [argument, ''] : [argument.slice(0, separator), argument.slice(separator + 1)];
}));
const source = path.resolve(values.get('--source') || '');
const file = values.get('--file') || '';
const bytes = Number(values.get('--bytes'));
const sha256 = values.get('--sha256') || '';
if (!source || !/^[A-Za-z0-9._-]+$/.test(file) || !Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
  throw new Error('Usage: --source=PATH --file=SAFE_NAME --bytes=INTEGER --sha256=HEX');
}
const required = ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error(`Missing storage configuration: ${missing.join(', ')}`);
const details = await stat(source);
if (details.size !== bytes) throw new Error(`Size mismatch for ${source}: expected ${bytes}, found ${details.size}`);

const prefix = (process.env.STORAGE_PREFIX || 'arcade').trim().replace(/^\/+|\/+$/g, '');
const key = [prefix, 'games', file].filter(Boolean).join('/');
const client = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT.trim(),
  region: process.env.STORAGE_REGION?.trim() || 'auto',
  maxAttempts: 12,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === '1',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY.trim()
  }
});

try {
  const remote = await client.send(new HeadObjectCommand({ Bucket: process.env.STORAGE_BUCKET.trim(), Key: key }));
  if (Number(remote.ContentLength) === bytes && remote.Metadata?.sha256 === sha256) {
    console.log(`SKIP ${key} (remote checksum metadata matches)`);
    process.exit(0);
  }
} catch (error) {
  const status = error?.$metadata?.httpStatusCode;
  if (status !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchKey') throw error;
}

console.log(`UPLOAD ${key} (${bytes} bytes)`);
const upload = new Upload({
  client,
  params: {
    Bucket: process.env.STORAGE_BUCKET.trim(),
    Key: key,
    Body: createReadStream(source),
    ContentType: 'application/octet-stream',
    ContentDisposition: 'inline',
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: { sha256, kind: 'game', system: 'ps2' }
  },
  queueSize: 1,
  partSize: 16 * 1024 * 1024,
  leavePartsOnError: false
});
let lastPercent = -1;
upload.on('httpUploadProgress', ({ loaded = 0 }) => {
  const percent = Math.floor(loaded / bytes * 100);
  if (percent >= lastPercent + 5 || percent === 100) {
    console.log(`${percent}%`);
    lastPercent = percent;
  }
});
await upload.done();
console.log(`OK ${key}`);
