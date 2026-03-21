/**
 * Simple task scheduler for recurring agent operations.
 *
 * Supports:
 * - Fixed interval tasks (every N minutes/hours)
 * - Named tasks with deduplication
 * - Graceful shutdown (cancel all tasks)
 * - Error isolation (one task failure doesn't affect others)
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("scheduler");

export interface ScheduledTask {
  id: string;
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  errors: number;
  enabled: boolean;
}

class TaskScheduler {
  private tasks = new Map<string, ScheduledTask>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Schedule a recurring task.
   * @param name Unique task name (duplicate names replace the previous task)
   * @param intervalMs Interval in milliseconds
   * @param handler Async function to execute
   * @param runImmediately If true, run the handler immediately before starting the interval
   */
  async schedule(
    name: string,
    intervalMs: number,
    handler: () => Promise<void>,
    runImmediately = false,
  ): Promise<string> {
    // Cancel existing task with same name
    if (this.tasks.has(name)) {
      this.cancel(name);
    }

    const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: ScheduledTask = {
      id,
      name,
      intervalMs,
      handler,
      runCount: 0,
      errors: 0,
      enabled: true,
    };

    this.tasks.set(name, task);

    // Run immediately if requested
    if (runImmediately) {
      await this.executeTask(task);
    }

    // Schedule recurring execution
    const timer = setInterval(async () => {
      if (task.enabled) {
        await this.executeTask(task);
      }
    }, intervalMs);
    timer.unref(); // Don't prevent process exit

    this.timers.set(name, timer);

    const intervalStr =
      intervalMs >= 3600000
        ? `${(intervalMs / 3600000).toFixed(1)}h`
        : intervalMs >= 60000
          ? `${(intervalMs / 60000).toFixed(0)}m`
          : `${(intervalMs / 1000).toFixed(0)}s`;

    log.info(`Scheduled task: ${name}`, { id, interval: intervalStr });
    return id;
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    try {
      task.lastRun = new Date();
      await task.handler();
      task.runCount++;
      task.nextRun = new Date(Date.now() + task.intervalMs);
    } catch (err) {
      task.errors++;
      log.error(`Task failed: ${task.name}`, {
        error: err instanceof Error ? err.message : String(err),
        runCount: task.runCount,
        errorCount: task.errors,
      });
    }
  }

  /** Cancel a scheduled task. */
  cancel(name: string): boolean {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    const removed = this.tasks.delete(name);
    if (removed) {
      log.info(`Cancelled task: ${name}`);
    }
    return removed;
  }

  /** Pause a task (keeps it registered but stops execution). */
  pause(name: string): boolean {
    const task = this.tasks.get(name);
    if (task) {
      task.enabled = false;
      return true;
    }
    return false;
  }

  /** Resume a paused task. */
  resume(name: string): boolean {
    const task = this.tasks.get(name);
    if (task) {
      task.enabled = true;
      return true;
    }
    return false;
  }

  /** Get all scheduled tasks. */
  getTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /** Get a specific task by name. */
  getTask(name: string): ScheduledTask | undefined {
    return this.tasks.get(name);
  }

  /** Cancel all tasks (for graceful shutdown). */
  shutdown(): void {
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      log.info(`Shutdown: cancelled ${name}`);
    }
    this.timers.clear();
    this.tasks.clear();
  }
}

/** Global scheduler instance. */
export const scheduler = new TaskScheduler();
