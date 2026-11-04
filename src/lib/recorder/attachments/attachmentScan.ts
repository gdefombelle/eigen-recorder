// attachmentScan — turns one scanner session into a queued attachment.
//
// Timeline rules (same referential as every attachment, pauses excluded):
//   start_offset_ms  the audio-clock position when the "Add to record" sheet OPENED (frozen by the caller)
//   end_offset_ms    the audio-clock position when the scanner CLOSED — not when the PDF was finished
//                    being built or read, which can be seconds later.

import type { ScanEngine, ScanResult } from '../scan/scanEngine';
import { ScanTooLargeError } from '../scan/scanEngine';
import { AttachmentTooLargeError } from './attachmentApi';
import type { LocalAttachment } from './localTypes';
import type { AddAttachmentInput } from './attachmentQueue';

export type ScanCaptureOutcome =
  | { status: 'added'; attachment: LocalAttachment; recompressed: boolean }
  | { status: 'cancelled' }
  | { status: 'error'; reason: 'too_large' | 'failed' | 'storage_failed'; sizeBytes?: number };

interface QueueLike { add(input: AddAttachmentInput): Promise<LocalAttachment> }

export async function captureScan(
  deps: { engine: ScanEngine; queue: QueueLike; getOffsetMs: () => Promise<number> },
  opts: { localSessionId: string; startOffsetMs: number; title: string },
): Promise<ScanCaptureOutcome> {
  let endRead: Promise<number | null> | null = null;
  const readEnd = () => { endRead ??= deps.getOffsetMs().catch(() => null); };

  let result: ScanResult | null;
  try {
    result = await deps.engine.scan({ onCaptured: readEnd });
  } catch (e) {
    if (e instanceof ScanTooLargeError) return { status: 'error', reason: 'too_large', sizeBytes: e.bestBytes };
    return { status: 'error', reason: 'failed' };
  }
  if (!result) return { status: 'cancelled' };

  readEnd();                                  // an engine that never signalled the end of capture: read it now
  const rawEnd = await endRead;
  const endOffsetMs = rawEnd != null && rawEnd >= opts.startOffsetMs ? rawEnd : null;

  try {
    const attachment = await deps.queue.add({
      localSessionId: opts.localSessionId,
      file:           result.file,
      filename:       `scan-${Math.round(opts.startOffsetMs)}.pdf`,
      mimeType:       'application/pdf',
      kind:           'document',
      startOffsetMs:  opts.startOffsetMs,
      endOffsetMs,
      sha256:         result.sha256,
      title:          opts.title,
      captureSource:  'scan',
      pageCount:      result.pageCount,
      ...(result.thumbnail ? { thumbnail: result.thumbnail } : {}),
    });
    return { status: 'added', attachment, recompressed: result.recompressed };
  } catch (e) {
    if (e instanceof AttachmentTooLargeError) return { status: 'error', reason: 'too_large', sizeBytes: e.sizeBytes };
    return { status: 'error', reason: 'storage_failed' };
  }
}
