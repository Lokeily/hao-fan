const DEFAULT_CANCELLED_JOB_LIMIT = 500;

function cancellationError(): Error {
  const error = new Error('翻译任务已取消');
  error.name = 'AbortError';
  return error;
}

export class TranslationJobRegistry {
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly cancelled = new Set<string>();
  private readonly cancelledJobLimit: number;

  constructor(cancelledJobLimit = DEFAULT_CANCELLED_JOB_LIMIT) {
    this.cancelledJobLimit = cancelledJobLimit;
  }

  async run<T>(
    jobId: string | undefined,
    task: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!jobId) return task();
    if (this.cancelled.has(jobId)) throw cancellationError();

    const controller = new AbortController();
    const controllers = this.active.get(jobId) || new Set<AbortController>();
    controllers.add(controller);
    this.active.set(jobId, controllers);
    try {
      return await task(controller.signal);
    } finally {
      controllers.delete(controller);
      // A cancelled job is removed from the map immediately. Do not let an old
      // request's cleanup delete a newer set that happens to use the same ID.
      if (controllers.size === 0 && this.active.get(jobId) === controllers) {
        this.active.delete(jobId);
      }
    }
  }

  cancel(jobId: string): void {
    if (!this.cancelled.has(jobId)) {
      this.cancelled.add(jobId);
      while (this.cancelled.size > Math.max(1, this.cancelledJobLimit)) {
        const oldest = this.cancelled.values().next().value;
        if (typeof oldest !== 'string') break;
        this.cancelled.delete(oldest);
      }
    }
    this.active.get(jobId)?.forEach((controller) => controller.abort());
    this.active.delete(jobId);
  }
}
