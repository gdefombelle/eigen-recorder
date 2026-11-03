// attachmentCapture — turns files picked by the user into queued attachments.
//
// Every file of a multi-selection gets its own UUID (queue.add) and the SAME
// offset: the moment the user opened the sheet, not the moment the picker
// returned (which could be a minute later).

import { prepareDocument, preparePhoto, type PreparedFile } from './imagePrep';
import { AttachmentTooLargeError } from './attachmentApi';
import type { AttachmentKind } from './types';
import type { LocalAttachment } from './localTypes';
import type { AddAttachmentInput } from './attachmentQueue';

export interface CapturedFile {
  blob:     Blob;
  filename: string;
  kind:     AttachmentKind;
}

export type CaptureErrorReason = 'too_large' | 'unsupported' | 'prepare_failed' | 'storage_failed';
export interface CaptureError { filename: string; reason: CaptureErrorReason }
export interface CaptureResult { added: LocalAttachment[]; errors: CaptureError[] }

export const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] as const;

const DOCUMENT_MIME: Record<string, string> = {
  pdf:  'application/pdf',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:  'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function documentExtension(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

interface QueueLike { add(input: AddAttachmentInput): Promise<LocalAttachment> }

export async function addCaptured(
  queue: QueueLike,
  opts: {
    localSessionId: string;
    offsetMs:       number;
    files:          CapturedFile[];
    /** Localized default title for a file without a meaningful name (photos). */
    titleFor:       (file: CapturedFile) => string;
  },
): Promise<CaptureResult> {
  const result: CaptureResult = { added: [], errors: [] };

  for (const f of opts.files) {
    try {
      let prepared: PreparedFile;
      let filename = f.filename;
      let mimeType: string;

      if (f.kind === 'photo') {
        try { prepared = await preparePhoto(f.blob); }
        catch { result.errors.push({ filename: f.filename, reason: 'prepare_failed' }); continue; }
        filename = `photo-${Math.round(opts.offsetMs)}.jpg`;
        mimeType = 'image/jpeg';
      } else {
        const ext = documentExtension(f.filename);
        if (!ext) { result.errors.push({ filename: f.filename, reason: 'unsupported' }); continue; }
        prepared = await prepareDocument(f.blob);
        mimeType = DOCUMENT_MIME[ext];
      }

      result.added.push(await queue.add({
        localSessionId: opts.localSessionId,
        file: prepared.blob,
        filename,
        mimeType,
        kind: f.kind,
        startOffsetMs: opts.offsetMs,
        sha256: prepared.sha256,
        title: f.kind === 'photo' ? opts.titleFor(f) : f.filename.replace(/\.[^.]+$/, '') || f.filename,
      }));
    } catch (e) {
      result.errors.push({
        filename: f.filename,
        reason: e instanceof AttachmentTooLargeError ? 'too_large' : 'storage_failed',
      });
    }
  }
  return result;
}
