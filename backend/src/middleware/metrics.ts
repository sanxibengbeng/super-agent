/**
 * In-memory metrics collection for request observability.
 * Exposes counters and a rolling 1-minute average response time.
 * No external dependencies — all state lives in process memory.
 */

/**
 * Represents a snapshot of server metrics.
 */
export interface MetricsSnapshot {
  /** Total requests handled since process start */
  totalRequests: number;
  /** Currently in-flight requests */
  activeConnections: number;
  /** Total 4xx responses */
  clientErrors: number;
  /** Total 5xx responses */
  serverErrors: number;
  /** Rolling 1-minute average response time in ms */
  avgResponseTimeMs: number;
  /** Process uptime in seconds */
  uptimeSeconds: number;
}

/**
 * Internal entry for the rolling response time window.
 */
interface ResponseTimeEntry {
  timestamp: number;
  durationMs: number;
}

const ROLLING_WINDOW_MS = 60_000; // 1 minute

class MetricsCollector {
  private _totalRequests = 0;
  private _activeConnections = 0;
  private _clientErrors = 0;
  private _serverErrors = 0;
  private _responseTimes: ResponseTimeEntry[] = [];

  /**
   * Increment total request count and active connections.
   * Call when a new request begins.
   */
  onRequestStart(): void {
    this._totalRequests++;
    this._activeConnections++;
  }

  /**
   * Decrement active connections and record response time + status category.
   * Call when a response is sent.
   */
  onRequestEnd(statusCode: number, durationMs: number): void {
    this._activeConnections = Math.max(0, this._activeConnections - 1);

    if (statusCode >= 400 && statusCode < 500) {
      this._clientErrors++;
    } else if (statusCode >= 500) {
      this._serverErrors++;
    }

    this._responseTimes.push({ timestamp: Date.now(), durationMs });
  }

  /**
   * Prune entries older than the rolling window.
   */
  private pruneOldEntries(): void {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    // Binary-style linear scan (array is append-only, so entries are time-ordered)
    let i = 0;
    while (i < this._responseTimes.length && this._responseTimes[i].timestamp < cutoff) {
      i++;
    }
    if (i > 0) {
      this._responseTimes = this._responseTimes.slice(i);
    }
  }

  /**
   * Return a snapshot of all tracked metrics.
   */
  getSnapshot(): MetricsSnapshot {
    this.pruneOldEntries();

    let avgResponseTimeMs = 0;
    if (this._responseTimes.length > 0) {
      const sum = this._responseTimes.reduce((acc, e) => acc + e.durationMs, 0);
      avgResponseTimeMs = Math.round((sum / this._responseTimes.length) * 100) / 100;
    }

    return {
      totalRequests: this._totalRequests,
      activeConnections: this._activeConnections,
      clientErrors: this._clientErrors,
      serverErrors: this._serverErrors,
      avgResponseTimeMs,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}

/**
 * Singleton metrics collector instance.
 */
export const metricsCollector = new MetricsCollector();
