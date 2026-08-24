export class RequestRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maximum: number, private readonly windowMs: number, private readonly maxBuckets = 20_000) {}

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.buckets.size >= this.maxBuckets) return { allowed: false, retryAfterMs: this.windowMs };
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    bucket.count += 1;
    return { allowed: bucket.count <= this.maximum, retryAfterMs: Math.max(1, bucket.resetAt - now) };
  }

  private prune(now: number): void {
    if (this.buckets.size < this.maxBuckets / 2) return;
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}
