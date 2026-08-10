/**
 * Worker entrypoint (forked by pool.ts, one task per process). Loads the
 * adapter module, runs measure or render, replies over IPC, exits. Adapter
 * crashes take down this process only — the pool retries with a fresh one.
 */

import { pathToFileURL } from "node:url";
import type { WorkerRequest, WorkerResponse } from "./pool.ts";
import type { RendererAdapter } from "./types.ts";

async function loadAdapter(
  spec: WorkerRequest["adapter"],
): Promise<RendererAdapter> {
  const specifier = spec.module.startsWith(".")
    ? spec.module // relative specifiers are resolved by the caller before this
    : pathToFileURL(spec.module).href;
  const mod = (await import(specifier)) as Record<string, unknown>;
  const candidate =
    spec.export !== undefined ? mod[spec.export] : (mod.default ?? mod.adapter);
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as RendererAdapter).measure !== "function" ||
    typeof (candidate as RendererAdapter).render !== "function"
  ) {
    throw new Error(
      `adapter module ${spec.module} (export ${spec.export ?? "default"}) does not implement RendererAdapter`,
    );
  }
  return candidate as RendererAdapter;
}

function reply(response: WorkerResponse): void {
  if (process.send === undefined) throw new Error("worker requires IPC");
  process.send(response, () => process.exit(0));
}

process.once("message", (request: WorkerRequest) => {
  void (async () => {
    try {
      const adapter = await loadAdapter(request.adapter);
      if (request.kind === "measure") {
        const result = await adapter.measure(request.shard, request.ctx);
        reply({ ok: true, result });
      } else {
        await adapter.render(request.shard, request.ctx);
        reply({ ok: true, result: null });
      }
    } catch (err) {
      reply({
        ok: false,
        error:
          err instanceof Error
            ? {
                name: err.name,
                message: err.message,
                ...(err.stack !== undefined && { stack: err.stack }),
              }
            : { name: "Error", message: String(err) },
      });
    }
  })();
});
