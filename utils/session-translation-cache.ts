export class SessionTranslationCache {
  private readonly entries = new Map<string, string>();
  private readonly capacity: number;

  constructor(capacity = 1_000) {
    this.capacity = capacity;
  }

  get(source: string): string | undefined {
    const translation = this.entries.get(source);
    if (translation === undefined) return undefined;
    // Refresh insertion order so frequently toggled UI labels stay cached.
    this.entries.delete(source);
    this.entries.set(source, translation);
    return translation;
  }

  remember(source: string, translation: string): void {
    if (!source) return;
    this.entries.delete(source);
    this.entries.set(source, translation);
    while (this.entries.size > Math.max(1, this.capacity)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
