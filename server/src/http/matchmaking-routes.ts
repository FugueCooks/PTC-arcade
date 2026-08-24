import type { Express, Request, Response } from 'express';
import type { ServerConfig } from '../config.js';
import type { RoomDirectory } from '../rooms/room-directory.js';
import type { RoomPlacementService } from '../rooms/room-placement-service.js';
import type { ReconnectDirectory } from '../players/reconnect-directory.js';

const requests = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
let lastBucketPruneAt = 0;

export function installMatchmakingRoutes(
  app: Express,
  placement: RoomPlacementService,
  directory: RoomDirectory,
  reconnects: ReconnectDirectory,
  config: ServerConfig,
  acceptingPlayers: () => boolean = () => true
): void {
  app.use('/api/rooms', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    const key = request.ip || 'unknown'; const now = Date.now();
    pruneBuckets(now);
    const bucket = requests.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && requests.size >= MAX_RATE_LIMIT_BUCKETS) {
        response.status(503).json({ ok: false, reason: 'temporarily-unavailable', retryAfterMs: 1_500 }); return;
      }
      requests.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else if (++bucket.count > MAX_REQUESTS_PER_WINDOW) {
      response.status(429).json({ ok: false, reason: 'rate-limited', retryAfterMs: bucket.resetAt - now }); return;
    }
    next();
  });
  app.get('/api/rooms', async (_request, response) => {
    try {
      const rooms = (await directory.list(['available', 'full']))
        .map((room) => ({ id: room.id, name: room.name, population: room.playerCount, capacity: room.capacity, status: room.status }))
        .sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));
      response.json({ ok: true, rooms });
    } catch {
      response.status(503).json({ ok: false, reason: 'directory-unavailable', retryAfterMs: 1_500 });
    }
  });
  app.post('/api/rooms/quick-join', async (request: Request, response: Response) => {
    if (!acceptingPlayers()) {
      response.status(503).json({ ok: false, reason: 'temporarily-unavailable', retryAfterMs: 1_500 }); return;
    }
    try {
      const requestedRoomId = cleanRoomId(request.body?.roomId);
      const resumeToken = typeof request.body?.resumeToken === 'string' && request.body.resumeToken.length <= 128 ? request.body.resumeToken : undefined;
      const reconnect = resumeToken ? await reconnects.get(resumeToken) : undefined;
      const result = await placement.placePublic({ reconnectRoomId: reconnect?.roomId, requestedRoomId, preferredRegion: cleanRegion(request.body?.preferredRegion) });
      if (!result.ok || !result.room || !result.reservation) {
        response.status(503).json({ ok: false, reason: result.reason ?? 'unavailable', retryAfterMs: 1_500 }); return;
      }
      response.json({ ok: true, roomId: result.room.id, roomName: result.room.name, reservationToken: result.reservation.token,
        expiresAt: result.reservation.expiresAt, realtimeUrl: result.realtimeUrl ?? config.publicRealtimeUrl });
    } catch {
      response.status(503).json({ ok: false, reason: 'placement-unavailable', retryAfterMs: 1_500 });
    }
  });
}

function pruneBuckets(now: number): void {
  if (now - lastBucketPruneAt < 60_000 && requests.size < MAX_RATE_LIMIT_BUCKETS) return;
  for (const [key, bucket] of requests) if (bucket.resetAt <= now) requests.delete(key);
  lastBucketPruneAt = now;
}

function cleanRoomId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : undefined;
}
function cleanRegion(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,32}$/.test(value) ? value : undefined;
}
