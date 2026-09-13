import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ShardRenderError } from "./errors.ts";
import type {
  AdapterRef,
  GlobalContext,
  MeasureContext,
  MeasureResult,
  Shard,
} from "./types.ts";

export type WorkerRequest =
  | {
      kind: "measure";
      adapter: AdapterRef;
      shard: Shard;
      ctx: MeasureContext;
    }
  | {
      kind: "render";
      adapter: AdapterRef;
      shard: Shard;
      ctx: GlobalContext;
    };

export type WorkerResponse =
  | { ok: true; result: MeasureResult | null }
  | { ok: false; error: string };

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * One child process per task (design spec: a crashing shard kills and
 * restarts that shard only — and a finished worker returns its memory to the
 * OS instead of to a long-lived pool process). Concurrency is a simple
 * semaphore; retries are per task with fresh processes.
 *
 * Call `dispose()` when the pool is no longer needed so the abort listener
 * is removed from the caller's signal. A pool is single-use per `generate()`.
 */
export class WorkerPool {
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly signal: AbortSignal | undefined;
  private readonly active = new Set<ChildProcess>();
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly onAbort = (): void => {
    for (const child of this.active) child.kill("SIGKILL");
  };

  constructor(options: {
    concurrency: number;
    retries: number;
    signal?: AbortSignal;
  }) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.retries = Math.max(0, Math.floor(options.retries));
    this.signal = options.signal;
    this.signal?.addEventListener("abort", this.onAbort);
  }

  /** Kills any live workers and detaches from the abort signal. */
  dispose(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
    for (const child of this.active) child.kill("SIGKILL");
    this.active.clear();
  }

  async run(task: WorkerRequest): Promise<MeasureResult | null> {
    await this.acquire();
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        this.signal?.throwIfAborted();
        try {
          return await this.runOnce(task);
        } catch (err) {
          lastError = err;
        }
      }
      throw new ShardRenderError(
        task.shard.index,
        `${task.kind} failed after ${this.retries + 1} attempt(s)`,
        { cause: lastError },
      );
    } finally {
      this.release();
    }
  }

  private runOnce(task: WorkerRequest): Promise<MeasureResult | null> {
    return new Promise((resolve, reject) => {
      const child = fork(WORKER_PATH, [], {
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      this.active.add(child);
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.active.delete(child);
        fn();
      };

      child.once("message", (message: WorkerResponse) => {
        if (message.ok) {
          settle(() => resolve(message.result));
        } else {
          settle(() => reject(new Error(message.error)));
        }
        child.kill();
      });
      child.once("error", (err) => settle(() => reject(err)));
      child.once("exit", (code, exitSignal) => {
        settle(() =>
          reject(
            new Error(
              `worker exited before replying (code=${code}, signal=${exitSignal})`,
            ),
          ),
        );
      });
      child.send(task);
    });
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot directly to the waiter: `running` stays constant, so
      // a concurrent acquire() cannot slip in between release and resume.
      next();
      return;
    }
    this.running--;
  }
}
