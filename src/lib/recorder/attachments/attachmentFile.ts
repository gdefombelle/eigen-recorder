// attachmentFile — getting an attachment's bytes, and handing a document to the system.

import { isNative } from '$lib/platform';
import type { AttachmentApiContract, AttachmentRecord } from './types';

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** The server stores the TITLE as the file name, so the extension may be missing — rebuild it from the MIME type. */
export function attachmentFilename(title: string | null | undefined, contentType: string | null | undefined): string {
  const base = (title || 'attachment').replace(/[\\/:*?"<>|]/g, '_').trim() || 'attachment';
  const ext = EXT_BY_MIME[(contentType ?? '').split(';')[0].trim().toLowerCase()];
  if (!ext || base.toLowerCase().endsWith(`.${ext}`)) return base;
  return `${base}.${ext}`;
}

/**
 * The attachment's bytes. The copy on this device wins (it exists when the record was captured here,
 * works offline and costs no download); otherwise the file is fetched from the server.
 */
export async function fetchAttachmentBlob(
  deps: { getLocalBlob: (clientAttachmentId: string) => Promise<Blob | undefined>; api: AttachmentApiContract },
  sessionId: string,
  record: AttachmentRecord,
): Promise<Blob> {
  const local = await deps.getLocalBlob(record.client_attachment_id);
  if (local) return local;
  return deps.api.download(sessionId, record.attachment_id, record.stored_file?.content_type ?? (record.kind === 'photo' ? 'image/jpeg' : undefined));
}

export type OpenOutcome = 'shared' | 'downloaded' | 'cancelled';

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));   // chunked: 25 MB in one call overflows the stack
  return btoa(binary);
}

/**
 * "Open" for a document. On iOS there is no in-app viewer: the file goes to the system share sheet
 * (Open in…, Save to Files, AirDrop). On the web it is downloaded.
 */
export async function openDocument(blob: Blob, filename: string): Promise<OpenOutcome> {
  if (isNative()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const path = `attachment-${Date.now()}-${filename}`;
    let wrote = false;
    try {
      await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: Directory.Cache });
      wrote = true;
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      await Share.share({ url: uri, title: filename });
      return 'shared';
    } catch (err) {
      console.warn('[Attachments] native open failed —', err);
      return 'cancelled';
    } finally {
      if (wrote) Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
