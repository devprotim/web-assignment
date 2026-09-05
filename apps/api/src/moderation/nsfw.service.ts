import { Worker } from 'node:worker_threads';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import type { ClassifyResponse } from './nsfw.worker.js';
import type { Env } from '../config/env.js';

/** The model's input resolution. */
const INPUT_SIZE = 224;

/**
 * Two workers. Enough that one slow image does not block the next, few enough
 * that a burst of uploads cannot starve the process of CPU for actual chat
 * traffic. Each worker holds its own copy of the model (~3.4MB), so this is
 * cheap in memory.
 */
const POOL_SIZE = 2;

export interface NsfwScores {
  neutral: number;
  drawing: number;
  sexy: number;
  hentai: number;
  porn: number;
}

export interface NsfwVerdict {
  safe: boolean;
  scores: NsfwScores;
  /** Which rule fired, for the audit log and for explaining the block. */
  rule: string | null;
  latencyMs: number;
}

export interface NsfwThresholds {
  porn: number;
  hentai: number;
  sexy: number;
  combined: number;
}

/**
 * The decision rule, as a pure function so it can be tested directly. Real
 * explicit imagery is not something to check into a repository, so the rule is
 * verified against score vectors instead of images.
 *
 * Individual thresholds catch a confident single-class prediction. The combined
 * rule catches what they miss: an image scoring 0.4 porn and 0.4 sexy is clearly
 * not safe but trips neither threshold alone.
 *
 * `sexy` sits higher than `porn` and `hentai` because it fires on swimwear and
 * ordinary photographs of people, so a low threshold there blocks innocuous
 * images. `drawing` and `neutral` never block.
 */
export function decideNsfw(
  scores: NsfwScores,
  thresholds: NsfwThresholds,
): { safe: boolean; rule: string | null } {
  if (scores.porn >= thresholds.porn) return { safe: false, rule: `porn>=${thresholds.porn}` };
  if (scores.hentai >= thresholds.hentai) {
    return { safe: false, rule: `hentai>=${thresholds.hentai}` };
  }
  if (scores.sexy >= thresholds.sexy) return { safe: false, rule: `sexy>=${thresholds.sexy}` };

  const total = scores.porn + scores.hentai + scores.sexy;
  if (total >= thresholds.combined) {
    return { safe: false, rule: `porn+hentai+sexy>=${thresholds.combined}` };
  }
  return { safe: true, rule: null };
}

interface Pending {
  resolve: (value: ClassifyResponse) => void;
  reject: (error: Error) => void;
}

@Injectable()
export class NsfwService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NsfwService.name);

  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>[] = [];
  private nextRequestId = 0;
  private nextWorker = 0;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit(): Promise<void> {
    const workerUrl = new URL('./nsfw.worker.js', import.meta.url);

    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(workerUrl);

      this.ready.push(
        new Promise<void>((resolve, reject) => {
          const onReady = (message: { ready?: boolean; error?: string }): void => {
            if (message?.ready === true) {
              worker.off('message', onReady);
              resolve();
            } else if (message?.ready === false) {
              worker.off('message', onReady);
              reject(new Error(message.error ?? 'worker failed to start'));
            }
          };
          worker.on('message', onReady);
          worker.on('error', reject);
        }),
      );

      worker.on('message', (message: ClassifyResponse) => {
        if (message?.id === undefined) return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        waiter.resolve(message);
      });

      worker.on('error', (error) => this.logger.error(`nsfw worker error: ${error.message}`));
      this.workers.push(worker);
    }

    // Loading is deliberately not awaited here: it takes several seconds and the
    // rest of the API has no reason to wait for it. `classify` awaits readiness.
    void Promise.all(this.ready)
      .then(() => this.logger.log(`NSFW model ready in ${POOL_SIZE} workers`))
      .catch((error: Error) => this.logger.error(`NSFW model failed to load: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.terminate()));
  }

  /**
   * Decodes, sanitises and classifies an image.
   *
   * The sharp step is a security control as much as preprocessing: re-encoding
   * from pixels discards EXIF, trailing data and anything else riding along in
   * the container, so a polyglot file that is both a valid PNG and something else
   * cannot survive into storage.
   */
  async classify(image: Buffer): Promise<NsfwVerdict> {
    await Promise.all(this.ready);
    const started = Date.now();

    const pixels = await sharp(image)
      .removeAlpha()
      .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer();

    const id = this.nextRequestId++;
    const worker = this.workers[this.nextWorker++ % this.workers.length];
    if (!worker) throw new Error('NSFW worker pool is empty');

    const response = await new Promise<ClassifyResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, pixels: new Uint8Array(pixels), size: INPUT_SIZE });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('NSFW classification timed out'));
      }, 15_000).unref();
    });

    if (response.error || !response.scores) {
      throw new Error(response.error ?? 'classification failed');
    }

    const scores: NsfwScores = {
      neutral: response.scores.neutral ?? 0,
      drawing: response.scores.drawing ?? 0,
      sexy: response.scores.sexy ?? 0,
      hentai: response.scores.hentai ?? 0,
      porn: response.scores.porn ?? 0,
    };

    return { ...this.decide(scores), scores, latencyMs: Date.now() - started };
  }

  private decide(scores: NsfwScores): { safe: boolean; rule: string | null } {
    return decideNsfw(scores, {
      porn: this.config.get('NSFW_THRESHOLD_PORN', { infer: true }),
      hentai: this.config.get('NSFW_THRESHOLD_HENTAI', { infer: true }),
      sexy: this.config.get('NSFW_THRESHOLD_SEXY', { infer: true }),
      combined: this.config.get('NSFW_THRESHOLD_COMBINED', { infer: true }),
    });
  }

}
