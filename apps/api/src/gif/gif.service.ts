import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GifMeta, GifSearchInput, GifSearchResult } from '@chat/shared';
import type { Env } from '../config/env.js';

const TENOR_BASE = 'https://tenor.googleapis.com/v2';

interface TenorMediaFormat {
  url: string;
  dims: [number, number];
}

interface TenorResult {
  id: string;
  media_formats: Record<string, TenorMediaFormat | undefined>;
}

interface TenorResponse {
  results?: TenorResult[];
  next?: string;
}

/**
 * Tenor proxy.
 *
 * Proxied rather than called from the browser for two reasons: the API key stays
 * on the server instead of being shipped in the bundle where anyone can lift it
 * and spend the quota, and the responses can be normalised to the small shape the
 * client actually needs.
 */
@Injectable()
export class GifService {
  private readonly logger = new Logger(GifService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get apiKey(): string {
    return this.config.get('TENOR_API_KEY', { infer: true });
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(input: GifSearchInput): Promise<GifSearchResult> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException({
        code: 'GIF_NOT_CONFIGURED',
        message: 'GIF search is unavailable because no Tenor API key is configured.',
      });
    }

    // An empty query means "show me something" -> trending.
    const endpoint = input.q ? 'search' : 'featured';
    const params = new URLSearchParams({
      key: this.apiKey,
      limit: String(input.limit),
      client_key: 'chat_web_assignment',
      // Tenor's own content filter, on top of it being a curated library.
      contentfilter: 'medium',
      // Only ask for the formats actually rendered, so responses stay small.
      media_filter: 'tinygif,gif,gifpreview',
    });
    if (input.q) params.set('q', input.q);
    if (input.cursor) params.set('pos', input.cursor);

    let response: Response;
    try {
      response = await fetch(`${TENOR_BASE}/${endpoint}?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      this.logger.warn(`Tenor request failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'GIF_UPSTREAM_ERROR',
        message: 'GIF search is temporarily unavailable.',
      });
    }

    if (!response.ok) {
      this.logger.warn(`Tenor responded ${response.status}`);
      throw new ServiceUnavailableException({
        code: 'GIF_UPSTREAM_ERROR',
        message: 'GIF search is temporarily unavailable.',
      });
    }

    const body = (await response.json()) as TenorResponse;
    return {
      items: (body.results ?? []).flatMap((result) => toGifMeta(result) ?? []),
      nextCursor: body.next && body.next.length > 0 ? body.next : null,
    };
  }
}

/**
 * The picker grid renders `previewUrl` (Tenor's `tinygif`, typically tens of KB)
 * and only the full `gif` once one is actually sent. Loading full-size GIFs into
 * a grid of 24 is what makes a picker feel slow.
 */
function toGifMeta(result: TenorResult): GifMeta | null {
  const full = result.media_formats.gif;
  const preview = result.media_formats.tinygif ?? result.media_formats.gifpreview ?? full;
  if (!full || !preview) return null;

  return {
    provider: 'tenor',
    id: result.id,
    url: full.url,
    previewUrl: preview.url,
    width: full.dims[0],
    height: full.dims[1],
  };
}
