export function isRetryableTranslationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /请求超时|网络|network|failed to fetch|\(408\)|\(425\)|\(429\)|\(5\d\d\)/i.test(message);
}

export class NoticeCycleGate {
  private readonly cycles = new Set<string>();
  private readonly capacity: number;

  constructor(capacity = 32) {
    this.capacity = Math.max(1, capacity);
  }

  shouldShow(cycleId: string): boolean {
    if (this.cycles.has(cycleId)) return false;
    if (this.cycles.size >= this.capacity) {
      const oldest = this.cycles.values().next().value;
      if (oldest) this.cycles.delete(oldest);
    }
    this.cycles.add(cycleId);
    return true;
  }
}
