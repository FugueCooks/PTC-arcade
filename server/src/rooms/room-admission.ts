import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { RedisKeys } from '../redis/redis-keys.js';

export interface AdmissionReservation { roomId: string; token: string; expiresAt: number }
export interface RoomAdmission {
  reserve(roomId: string, capacity: number, now?: number): Promise<AdmissionReservation | undefined>;
  confirm(reservation: AdmissionReservation, playerId: string): Promise<boolean>;
  release(roomId: string, playerId?: string, reservationToken?: string): Promise<void>;
}

const RESERVE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local occupied = redis.call('SCARD', KEYS[1]) + redis.call('ZCARD', KEYS[2])
if occupied >= tonumber(ARGV[2]) then return 0 end
if redis.call('ZADD', KEYS[2], 'NX', ARGV[3], ARGV[4]) == 0 then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1`;
const CONFIRM_SCRIPT = `
if redis.call('ZREM', KEYS[2], ARGV[1]) == 0 then return 0 end
redis.call('SADD', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;

export class RedisRoomAdmission implements RoomAdmission {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys, private readonly reservationTtlMs = 10_000) {}

  async reserve(roomId: string, capacity: number, now = Date.now()): Promise<AdmissionReservation | undefined> {
    const token = randomUUID(); const expiresAt = now + this.reservationTtlMs;
    const result = await this.client.eval(RESERVE_SCRIPT, {
      keys: [this.keys.roomMembers(roomId), this.keys.roomReservations(roomId)],
      arguments: [String(now), String(capacity), String(expiresAt), token, String(this.reservationTtlMs * 3)]
    });
    return Number(result) === 1 ? { roomId, token, expiresAt } : undefined;
  }

  async confirm(reservation: AdmissionReservation, playerId: string): Promise<boolean> {
    const result = await this.client.eval(CONFIRM_SCRIPT, {
      keys: [this.keys.roomMembers(reservation.roomId), this.keys.roomReservations(reservation.roomId)],
      arguments: [reservation.token, playerId, String(this.reservationTtlMs * 3)]
    });
    return Number(result) === 1;
  }

  async release(roomId: string, playerId?: string, reservationToken?: string): Promise<void> {
    const transaction = this.client.multi();
    if (playerId) transaction.sRem(this.keys.roomMembers(roomId), playerId);
    if (reservationToken) transaction.zRem(this.keys.roomReservations(roomId), reservationToken);
    await transaction.exec();
  }
}

export class InMemoryRoomAdmission implements RoomAdmission {
  private readonly members = new Map<string, Set<string>>();
  private readonly reservations = new Map<string, Map<string, number>>();
  constructor(private readonly ttlMs = 10_000) {}

  async reserve(roomId: string, capacity: number, now = Date.now()): Promise<AdmissionReservation | undefined> {
    const reservations = this.reservations.get(roomId) ?? new Map<string, number>();
    for (const [token, expiresAt] of reservations) if (expiresAt <= now) reservations.delete(token);
    this.reservations.set(roomId, reservations);
    if ((this.members.get(roomId)?.size ?? 0) + reservations.size >= capacity) return undefined;
    const token = randomUUID(); const expiresAt = now + this.ttlMs; reservations.set(token, expiresAt);
    return { roomId, token, expiresAt };
  }

  async confirm(reservation: AdmissionReservation, playerId: string): Promise<boolean> {
    const reservations = this.reservations.get(reservation.roomId);
    if (!reservations?.delete(reservation.token) || reservation.expiresAt <= Date.now()) return false;
    const members = this.members.get(reservation.roomId) ?? new Set<string>(); members.add(playerId); this.members.set(reservation.roomId, members);
    return true;
  }

  async release(roomId: string, playerId?: string, reservationToken?: string): Promise<void> {
    if (playerId) this.members.get(roomId)?.delete(playerId);
    if (reservationToken) this.reservations.get(roomId)?.delete(reservationToken);
  }
}
