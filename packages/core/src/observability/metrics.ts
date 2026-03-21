/**
 * Simple in-memory metrics collector — zero dependencies.
 *
 * Tracks counters, gauges, and histograms.
 * Exposed via GET /api/metrics endpoint in the webhook server.
 *
 * Usage:
 *   import { metrics } from "./observability/index.js";
 *   metrics.increment("webhook.received");
 *   metrics.observe("api.latency_ms", 42);
 *   metrics.gauge("agents.active", 3);
 */

interface MetricEntry {
  name: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  updatedAt: string;
}

const MAX_HISTOGRAM_SIZE = 1000;

class MetricsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  /** Increment a counter by the given amount (default 1). */
  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }

  /** Set a gauge to an absolute value. */
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record an observation for a histogram (e.g. latency in ms). */
  observe(name: string, value: number): void {
    const existing = this.histograms.get(name) || [];
    existing.push(value);
    // Keep last N observations to bound memory
    if (existing.length > MAX_HISTOGRAM_SIZE) existing.shift();
    this.histograms.set(name, existing);
  }

  /** Return all metrics as a flat array of entries. */
  getAll(): MetricEntry[] {
    const entries: MetricEntry[] = [];
    const now = new Date().toISOString();

    for (const [name, value] of this.counters) {
      entries.push({ name, type: "counter", value, updatedAt: now });
    }
    for (const [name, value] of this.gauges) {
      entries.push({ name, type: "gauge", value, updatedAt: now });
    }
    for (const [name, values] of this.histograms) {
      const avg =
        values.length > 0
          ? values.reduce((a, b) => a + b, 0) / values.length
          : 0;
      entries.push({
        name,
        type: "histogram",
        value: Math.round(avg),
        updatedAt: now,
      });
    }

    return entries;
  }

  /** Serialize metrics to a JSON-friendly object for the /api/metrics endpoint. */
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [name, value] of this.counters) {
      result[name] = value;
    }
    for (const [name, value] of this.gauges) {
      result[name] = value;
    }
    for (const [name, values] of this.histograms) {
      const avg =
        values.length > 0
          ? values.reduce((a, b) => a + b, 0) / values.length
          : 0;
      result[name] = {
        avg: Math.round(avg),
        count: values.length,
        last: values[values.length - 1],
      };
    }

    return result;
  }

  /** Reset all metrics (useful for testing). */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const metrics = new MetricsCollector();
