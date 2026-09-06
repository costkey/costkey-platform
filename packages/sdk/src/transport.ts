import type { CostKeyEvent, TransportPayload } from "@costkey/shared";
import { SDK_VERSION } from "./version.js";

export interface TransportOptions {
  /** Ingest endpoint URL (parsed from DSN) */
  endpoint: string;
  /** Auth key (parsed from DSN) */
  authKey: string;
  /** Max events per batch */
  maxBatchSize: number;
  /** Flush interval in ms */
  flushInterval: number;
  /** Debug logging */
  debug: boolean;
  /** Release version for sourcemap translation */
  release?: string;
}

/**
 * Batched, async, non-blocking transport.
 * Queues events in memory and flushes them periodically or when the batch is full.
 * Never throws into user code. Never blocks the event loop.
 */
export class Transport {
  private queue: CostKeyEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxQueueSize = 500;
  private hasConfirmedConnection = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: TransportOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushInterval);

    // Don't keep the process alive just for flushing
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Enqueue an event for sending. Never throws. */
  enqueue(event: CostKeyEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      // Drop oldest to prevent OOM
      this.queue.shift();
      if (this.options.debug) {
        console.warn("[costkey] Queue full, dropping oldest event");
      }
    }

    this.queue.push(event);

    if (this.queue.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /** Flush all queued events. Best-effort, never throws. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve();
    this.inFlight = this.sendBatch().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async sendBatch(): Promise<void> {
    try {
      const batch = this.queue.splice(0, this.options.maxBatchSize);
      const payload: TransportPayload = {
        sdkVersion: SDK_VERSION,
        release: this.options.release,
        events: batch,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      try {
        const response = await fetch(this.options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.authKey}`,
            "User-Agent": `costkey-sdk/${SDK_VERSION}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.status === 429) {
          // Rate limited — put events back and let the interval retry
          this.queue.unshift(...batch);
          if (this.options.debug) {
            console.warn("[costkey] Rate limited, will retry");
          }
          return;
        }

        if (response.status === 401 || response.status === 403) {
          // Auth failures always log — developer needs to know their DSN is wrong
          console.warn(
            `[costkey] Authentication failed (${response.status}). Check your DSN at https://app.costkey.dev/settings`,
          );
          return;
        }

        if (!response.ok && this.options.debug) {
          console.warn(
            `[costkey] Ingest returned ${response.status}: ${response.statusText}`,
          );
        }

        // One-time connection confirmation on first successful delivery
        if (response.ok && !this.hasConfirmedConnection) {
          this.hasConfirmedConnection = true;
          console.log("[costkey] Connected. Tracking AI calls.");
        }
      } finally {
        clearTimeout(timeout);
      }

      return;
    } catch (err) {
      // Network error — fire and forget. Never crash user's app.
      if (this.options.debug) {
        console.warn("[costkey] Failed to send events:", err);
      }
    }
  }
}
