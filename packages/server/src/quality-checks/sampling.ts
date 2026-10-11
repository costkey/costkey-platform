import { createHash } from "node:crypto";

/**
 * Deterministic sampling by run id. A run's bucket is the first 32 bits of
 * md5(trace id) mapped onto [0, 100). A check with sample rate R evaluates the
 * runs whose bucket is below R, so the same run is always in or out, and a run
 * sampled at 10% is also sampled at 50%. `SAMPLE_BUCKET_SQL` is the same
 * function in Postgres; tests hold the two together.
 */
export function sampleBucket(traceId: string): number {
  const hex = createHash("md5").update(traceId, "utf8").digest("hex").slice(0, 8);
  return (Number.parseInt(hex, 16) / 4_294_967_296) * 100;
}

export function isSampled(traceId: string, sampleRate: number): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return false;
  if (sampleRate >= 100) return true;
  return sampleBucket(traceId) < sampleRate;
}

/** Postgres twin of `sampleBucket` for an expression that yields the trace id. */
export function sampleBucketSql(traceIdExpression: string): string {
  return `(('x' || substr(md5(${traceIdExpression}), 1, 8))::bit(32)::bigint::double precision / 4294967296.0 * 100)`;
}
