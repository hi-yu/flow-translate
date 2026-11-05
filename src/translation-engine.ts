import type { Provider, TranslationInput, TranslationResult } from './types';
import { translateWithProvider } from './providers';

interface Job {
  run: () => Promise<void>;
  reject: (reason: Error) => void;
  owner: string;
  automatic: boolean;
}

interface Pending {
  promise: Promise<TranslationResult>;
  listeners: Set<(text: string) => void>;
  partial: string;
}

export interface CacheSnapshot {
  epoch: number;
  entries: [string, TranslationResult][];
}

/** One inference at a time avoids overloading the local 7B model. */
export class TranslationEngine {
  private queue: Job[] = [];
  private active = false;
  private cache = new Map<string, TranslationResult>();
  private cacheCharacters = 0;
  private pending = new Map<string, Pending>();
  private epoch = 0;

  constructor(
    private translate = translateWithProvider,
    private cacheChanged: () => void = () => {},
  ) {}

  snapshot(): CacheSnapshot {
    return { epoch: this.epoch, entries: [...this.cache] };
  }

  restore(snapshot?: CacheSnapshot): void {
    if (!snapshot) return;
    this.epoch = snapshot.epoch;
    for (const [key, result] of snapshot.entries) this.remember(key, result);
  }

  clearCache(): void {
    this.epoch++;
    this.cache.clear();
    this.cacheCharacters = 0;
    this.cacheChanged();
  }

  private remember(key: string, result: TranslationResult): void {
    const previous = this.cache.get(key);
    if (previous) this.cacheCharacters -= key.length + previous.text.length;
    this.cache.delete(key);
    this.cache.set(key, result);
    this.cacheCharacters += key.length + result.text.length;
    while (this.cache.size > 200 || this.cacheCharacters > 1_000_000) {
      const oldest = this.cache.keys().next().value!;
      this.cacheCharacters -= oldest.length + this.cache.get(oldest)!.text.length;
      this.cache.delete(oldest);
    }
  }

  cancelAutomatic(channel: string): void {
    this.queue = this.queue.filter((job) => {
      if (job.owner.endsWith(':' + channel) && job.automatic) {
        job.reject(new Error('自动翻译已关闭。'));
        return false;
      }
      return true;
    });
  }

  async request(
    input: TranslationInput,
    provider: Provider,
    target: string,
    owner: string,
    onProgress?: (text: string) => void,
  ): Promise<TranslationResult> {
    const text = input.text.trim();
    if (!text || text.length > 12_000)
      throw new Error('每次请选择 1 至 12000 字符；长文章会自动分段。');
    const epoch = this.epoch;
    const key = JSON.stringify([
      epoch,
      provider.id,
      provider.baseUrl,
      provider.model,
      target,
      text,
    ]);
    const cached = !input.bypassCache && this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { ...cached, cached: true };
    }
    const pendingKey = key + ':' + owner;
    const existing = !input.bypassCache && this.pending.get(pendingKey);
    if (existing) {
      if (onProgress) {
        existing.listeners.add(onProgress);
        if (existing.partial) onProgress(existing.partial);
      }
      try {
        return await existing.promise;
      } finally {
        if (onProgress) existing.listeners.delete(onProgress);
      }
    }
    if (this.queue.length >= 100) throw new Error('翻译任务较多，请等待当前任务完成。');
    const listeners = new Set(onProgress ? [onProgress] : []);
    const pending: Pending = { promise: undefined!, listeners, partial: '' };
    pending.promise = new Promise<TranslationResult>((resolve, reject) => {
      const job: Job = {
        owner,
        automatic: Boolean(input.automatic),
        reject,
        run: async () => {
          try {
            // Another tab may have completed the same text while this job was queued.
            const completed = !input.bypassCache && epoch === this.epoch && this.cache.get(key);
            if (completed) {
              resolve({ ...completed, cached: true });
              return;
            }
            const translated = await this.translate(
              provider,
              text,
              target,
              undefined,
              (partial) => {
                pending.partial = partial;
                for (const listener of listeners) listener(partial);
              },
            );
            const result = {
              text: translated,
              providerId: provider.id,
              providerName: provider.name,
              cached: false,
            };
            if (epoch === this.epoch) {
              this.remember(key, result);
              this.cacheChanged();
            }
            resolve(result);
          } catch (error) {
            reject(error);
          }
        },
      };
      const autoIndex = this.queue.findIndex((item) => item.automatic);
      if (!job.automatic && autoIndex >= 0) this.queue.splice(autoIndex, 0, job);
      else this.queue.push(job);
      void this.drain();
    });
    this.pending.set(pendingKey, pending);
    try {
      return await pending.promise;
    } finally {
      if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey);
    }
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) await this.queue.shift()!.run();
    } finally {
      this.active = false;
    }
  }
}
