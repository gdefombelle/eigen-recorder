// shareAudio — merge IndexedDB chunks → Blob, then Web Share API or download fallback.
//
// WebM chunks from a single MediaRecorder session can be safely concatenated:
// the first chunk carries the EBML/Segment header; subsequent chunks are raw clusters.
// mp4/m4a (Safari) does NOT support safe concatenation — we warn the user and still
// attempt it, which works for short recordings but may produce corrupt files for long ones.
// The Capacitor iOS build will handle this properly via native AVAssetExportSession.

import { offlineStorage } from './offlineStorage';
import { isNative } from '$lib/platform';
import { EigenAudio } from '$lib/plugins/eigenAudio';

export interface ExportResult {
  blob:     Blob;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

function extForMime(mime: string): string {
  if (mime.includes('x-caf') || mime.includes('caf')) return 'caf';
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('webm')) return 'webm';
  return 'caf'; // native iOS default
}

function slugify(str: string): string {
  return str.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 60);
}

export async function buildExport(sessionId: string): Promise<ExportResult> {
  const session = await offlineStorage.getSession(sessionId);
  if (!session) throw new Error('Session not found');

  const date = new Date(session.created_at).toISOString().slice(0, 10);

  // ── Native path: merge M4A chunks via AVAssetExportSession ──────────────
  if (isNative()) {
    const result = await EigenAudio.mergeChunks({ sessionId });
    const bytes   = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
    const blob    = new Blob([bytes], { type: result.mimeType });
    const filename = `${slugify(session.title)}_${date}.m4a`;
    return { blob, filename, mimeType: result.mimeType, sizeBytes: result.sizeBytes };
  }

  // ── Web path: concatenate blobs (works for webm/opus) ───────────────────
  const chunks = await offlineStorage.getChunksMeta(sessionId);
  if (chunks.length === 0) throw new Error('No audio chunks recorded for this session');

  const blobs: Blob[] = [];
  for (const chunk of chunks) {
    const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
    if (blob) blobs.push(blob);
  }
  if (blobs.length === 0) throw new Error('Audio data missing from local storage');

  const mimeType = chunks[0].mime_type || 'audio/webm';
  const filename = `${slugify(session.title)}_${date}.${extForMime(mimeType)}`;
  const merged   = new Blob(blobs, { type: mimeType });
  return { blob: merged, filename, mimeType, sizeBytes: merged.size };
}

export async function shareOrDownload(sessionId: string): Promise<ShareOutcome> {
  const { blob, filename } = await buildExport(sessionId);
  const file = new File([blob], filename, { type: blob.type });

  // Web Share API — native sheet on iOS / Android / modern desktop
  if (
    typeof navigator !== 'undefined' &&
    'canShare' in navigator &&
    (navigator as Navigator & { canShare: (d: ShareData) => boolean }).canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      // User cancelled the share sheet — not an error
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
      // Fall through to download if share fails for another reason
    }
  }

  // Fallback: trigger browser download
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  return 'downloaded';
}

export function canWebShare(): boolean {
  return typeof navigator !== 'undefined' && 'share' in navigator;
}

export function isSafariMp4Warning(mimeType: string): boolean {
  return mimeType.includes('mp4') || mimeType.includes('aac');
}
