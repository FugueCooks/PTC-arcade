import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';

const requestIds = new WeakMap<Request, string>();
export function installRequestContext(app: Express): void {
  app.use((request, response, next) => {
    const supplied = request.header('x-request-id');const requestId = supplied && /^[A-Za-z0-9._:-]{1,96}$/.test(supplied) ? supplied : randomUUID();
    requestIds.set(request, requestId);response.setHeader('X-Request-Id', requestId);next();
  });
}
export function requestId(request: Request): string { return requestIds.get(request) ?? randomUUID(); }
