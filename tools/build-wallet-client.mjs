import { build } from 'esbuild';
import path from 'node:path';

await build({
  entryPoints: [path.resolve('wallet/wallet-standard-client-entry.js')],
  outfile: path.resolve('wallet/wallet-standard-bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: true,
  legalComments: 'none'
});
