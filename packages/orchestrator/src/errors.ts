export class ShardRenderError extends Error {
  readonly shardIndex: number;

  constructor(shardIndex: number, message: string, options?: ErrorOptions) {
    super(`shard ${shardIndex}: ${message}`, options);
    this.name = "ShardRenderError";
    this.shardIndex = shardIndex;
  }
}

/** Pass-2 page count disagreed with pass-1 — the adapter broke the
 * determinism contract. Failing loudly beats shipping a corrupt TOC. */
export class DeterminismError extends Error {
  readonly shardIndex: number;

  constructor(shardIndex: number, measured: number, rendered: number) {
    super(
      `shard ${shardIndex}: measured ${measured} pages but rendered ${rendered} — ` +
        "adapter is non-deterministic; refusing to ship a document with a corrupt TOC",
    );
    this.name = "DeterminismError";
    this.shardIndex = shardIndex;
  }
}

export class DuplicateAnchorError extends Error {
  constructor(name: string, shardA: number, shardB: number) {
    super(
      `anchor "${name}" declared by both shard ${shardA} and shard ${shardB}`,
    );
    this.name = "DuplicateAnchorError";
  }
}
