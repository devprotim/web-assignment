import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { ALLOWED_IMAGE_MIME, MAX_UPLOAD_BYTES, type AttachmentView, type PresignResult } from '@chat/shared';
import { firstValueFrom } from 'rxjs';

export type UploadResult =
  | { ok: true; attachment: AttachmentView }
  | { ok: false; message: string };

@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly http = inject(HttpClient);

  /**
   * presign -> PUT direct to storage -> ask the server to moderate.
   *
   * The bytes never pass through the API. The client-side checks here are only a
   * courtesy so obvious mistakes fail instantly; the server re-validates the type
   * from magic bytes and the size from the stored object, and refuses to attach
   * anything that has not been approved.
   */
  async upload(file: File): Promise<UploadResult> {
    if (!ALLOWED_IMAGE_MIME.includes(file.type as never)) {
      return { ok: false, message: 'Only JPEG, PNG and WebP images can be sent.' };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { ok: false, message: 'Images must be 8MB or smaller.' };
    }

    try {
      const presigned = await firstValueFrom(
        this.http.post<PresignResult>('/api/attachments/presign', {
          mime: file.type,
          size: file.size,
        }),
      );

      const put = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: presigned.requiredHeaders,
        body: file,
      });
      if (!put.ok) return { ok: false, message: 'Upload failed. Please try again.' };

      const attachment = await firstValueFrom(
        this.http.post<AttachmentView>(
          `/api/attachments/${presigned.attachmentId}/moderate`,
          {},
        ),
      );
      return { ok: true, attachment };
    } catch (error) {
      return { ok: false, message: readError(error) };
    }
  }
}

function readError(error: unknown): string {
  const body = (error as { error?: { message?: string } })?.error;
  return body?.message ?? 'Upload failed. Please try again.';
}
