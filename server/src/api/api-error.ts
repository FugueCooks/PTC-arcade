import type { Response } from 'express';

export interface ApiErrorBody { ok: false; error: { code: string; message: string; requestId: string; details?: unknown } }
export function apiError(response: Response, status: number, requestId: string, code: string, message: string, details?: unknown): void {
  const body: ApiErrorBody = { ok: false, error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
  response.status(status).json(body);
}
