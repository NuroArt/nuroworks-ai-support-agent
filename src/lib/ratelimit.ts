/**
 * Per-user sliding window, in process memory.
 *
 * Deliberately not Redis: this MVP runs as a single instance. If it is ever
 * scaled horizontally this must move to a shared store, or each replica will
 * enforce its own quota and the real limit becomes N times the intended one.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

// Unbounded growth across many users would leak. Sweep idle keys hourly.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, v] of buckets) {
      const kept = v.filter((t) => t > cutoff);
      if (kept.length) buckets.set(k, kept);
      else buckets.delete(k);
    }
  }, 600_000).unref?.();
}
