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
  | { ok: false; error: { name: string; message: string; stack?: string } };

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * One child process per task (design spec: a crashing shard kills and
 * restarts that shard only — and a finished worker returns its memory to the
 * OS instead of to a long-lived pool process). Concurrency is a simple
 * semaphore; retries are per task with fresh processes.
 */
export class WorkerPool {
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly signal: AbortSignal | undefined;
  private active = new Set<ChildProcess>();
  private running = 0;
  private waiters: (() => void)[] = [];

  private readonly onRetry:
    | ((task: WorkerRequest, attempt: number, error: unknown) => void)
    | undefined;

  constructor(options: {
    concurrency: number;
    retries: number;
    signal?: AbortSignal;
    /** Called before each re-attempt (attempt is 2-based: the retry number). */
    onRetry?: (task: WorkerRequest, attempt: number, error: unknown) => void;
  }) {
    this.concurrency = Math.max(1, options.concurrency);
    this.retries = Math.max(0, options.retries);
    this.signal = options.signal;
    this.onRetry = options.onRetry;
    this.signal?.addEventListener("abort", () => {
      for (const child of this.active) child.kill("SIGKILL");
    });
  }

  async run(task: WorkerRequest): Promise<MeasureResult | null> {
    await this.acquire();
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        this.signal?.throwIfAborted();
        if (attempt > 0) this.onRetry?.(task, attempt + 1, lastError);
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
          // Rehydrate so DeterminismError etc. keep their name across IPC.
          const error = new Error(message.error.message);
          error.name = message.error.name;
          if (message.error.stack !== undefined)
            error.stack = message.error.stack;
          settle(() => reject(error));
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

  private async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.running++;
  }

  private release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}
