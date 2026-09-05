import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';

/**
 * S3-compatible object storage (Cloudflare R2 in production, MinIO locally).
 *
 * Uploads are presigned so the browser PUTs bytes straight to storage. The
 * assignment asks that large files not pass through the application server as
 * oversized request bodies, and this is what satisfies that: the API only ever
 * handles the small JSON that describes the upload, plus a controlled read of the
 * object during moderation.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.client = new S3Client({
      region: config.get('S3_REGION', { infer: true }),
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
      },
    });
  }

  /**
   * A short-lived PUT URL bound to the exact content type and length the client
   * declared. The signature does not cover the body, so these conditions are what
   * stop a client from declaring a 100KB PNG and uploading a 2GB video.
   */
  async presignUpload(key: string, mime: string, size: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mime,
        ContentLength: size,
      }),
      { expiresIn: 300 },
    );
  }

  /**
   * A short-lived GET URL.
   *
   * Media is never served from a public bucket. These are private conversations,
   * and a publicly readable object URL means anyone who obtains the link can read
   * an image they were never a party to. Instead the API authorises the reader
   * against conversation membership and then redirects here, so the signed URL is
   * only ever handed to someone already entitled to see it.
   */
  async presignDownload(key: string, expiresIn = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }

  /** Actual stored size, used to check the client did not lie about it. */
  async headSize(key: string): Promise<number | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return result.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reads an object into memory with a hard byte cap, so a file that is larger
   * than it claimed cannot exhaust the server's memory during moderation.
   */
  async getObject(key: string, maxBytes: number): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) {
          this.logger.warn(`Object ${key} exceeded ${maxBytes} bytes while reading`);
          return null;
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.warn(`Failed to read ${key}: ${(error as Error).message}`);
      return null;
    }
  }

  async putObject(key: string, body: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((error) => this.logger.warn(`Failed to delete ${key}: ${error.message}`));
  }
}
