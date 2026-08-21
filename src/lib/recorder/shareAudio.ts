// shareAudio — merge IndexedDB chunks → Blob, then share via native iOS sheet
// or Web Share API or download fallback (in that priority order).
//
// iOS native (Capacitor): writes blob to Cache directory then invokes
// @capacitor/share → UIActivityViewController (real AirDrop / Messages sheet).
//
// Web/PWA: uses Web Share API Level 2 (files) when available, falls back to
// a browser download link.

import { offlineStorage } from './offlineStorage';
import { isNative }       from '$lib/platform';
import { EigenAudio }     from '$lib/plugins/eigenAudio';
import { Share }          from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

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
  return 'm4a'; // iOS default
}

function slugify(str: string): string {
  return str.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 60);
}

/** Convert a Blob to a base64 string (without data: prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]); // strip "data:...;base64,"
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function buildExport(sessionId: string): Promise<ExportResult> {
  const session = await offlineStorage.getSession(sessionId);
  if (!session) throw new Error('Session not found');

  const date = new Date(session.created_at).toISOString().slice(0, 10);

  // ── Native path: try AVAssetExportSession merge (needs files on disk) ───
  // Falls back to IndexedDB if the native filesystem directory is missing —
  // which is the normal case: NativeAudioRecorder delivers chunks as base64
  // at stop() time and does not persist them to EigenChunks/{sessionId}/.
  if (isNative()) {
    try {
      const result   = await EigenAudio.mergeChunks({ sessionId });
      const bytes    = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
      const blob     = new Blob([bytes], { type: result.mimeType });
      const filename = `${slugify(session.title)}_${date}.m4a`;
      return { blob, filename, mimeType: result.mimeType, sizeBytes: result.sizeBytes };
    } catch (nativeErr) {
      // Directory missing → fall through to IndexedDB blob path below.
      console.warn('[EigenMeeting] mergeChunks: falling back to IndexedDB blobs —', nativeErr);
    }
  }

  // ── Web path (and iOS fallback): concatenate blobs from IndexedDB ────────
  const chunks = await offlineStorage.getChunksMeta(sessionId);
  if (chunks.length === 0) throw new Error('No audio chunks recorded for this session');

  const blobs: Blob[] = [];
  for (const chunk of chunks) {
    const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
    if (blob) blobs.push(blob);
  }
  if (blobs.length === 0) throw new Error('Audio data missing from local storage');

  const mimeType = chunks[0].mime_type || 'audio/mp4';
  const filename = `${slugify(session.title)}_${date}.${extForMime(mimeType)}`;
  const merged   = new Blob(blobs, { type: mimeType });
  return { blob: merged, filename, mimeType, sizeBytes: merged.size };
}

export async function shareOrDownload(sessionId: string): Promise<ShareOutcome> {
  const { blob, filename } = await buildExport(sessionId);

  // ── iOS Capacitor: write to cache dir, open native UIActivityViewController ──
  if (isNative()) {
    let wrote = false;
    try {
      const base64 = await blobToBase64(blob);
      await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache });
      wrote = true;
      const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
      await Share.share({ url: uri, title: filename, dialogTitle: 'Share recording' });
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
      // Share was dismissed or failed — not a hard error for the user
      console.warn('[EigenMeeting] native share failed —', err);
      return 'cancelled';
    } finally {
      if (wrote) {
        Filesystem.deleteFile({ path: filename, directory: Directory.Cache }).catch(() => {});
      }
    }
  }

  // ── Web: Web Share API Level 2 (files) ────────────────────────────────────
  const file = new File([blob], filename, { type: blob.type });
  if (
    typeof navigator !== 'undefined' &&
    'canShare' in navigator &&
    (navigator as Navigator & { canShare: (d: ShareData) => boolean }).canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
    }
  }

  // ── Web fallback: browser download ────────────────────────────────────────
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
