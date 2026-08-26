import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Imports a browser ES module from the project root.
 *
 * The build compiles only `server/` and `test/` into `dist/`, so a relative
 * import of a client module from a compiled test would resolve into `dist/` and
 * miss. Resolving against the working directory instead lets the shipped browser
 * source be exercised directly, rather than a copy that could drift from it.
 */
export async function importBrowserModule<T = Record<string, unknown>>(relativePath: string): Promise<T> {
  const resolved = pathToFileURL(path.resolve(process.cwd(), relativePath)).href;
  return (await import(resolved)) as T;
}
