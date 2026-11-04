// attachmentPicker — platform glue for choosing/capturing files.
//
//   Camera + photo library: @capacitor/camera on iOS (the camera is a native view
//   controller presented over the WebView — audio keeps running in the native
//   recorder; see the device test in the PR notes). Web/PWA fall back to <input>.
//   Documents: always <input type="file">.
//
// Every function resolves to [] when the user cancels.

import { isNative } from '$lib/platform';
import type { CapturedFile } from './attachmentCapture';
import { DOCUMENT_EXTENSIONS } from './attachmentCapture';

export type PickSource = 'camera' | 'library' | 'files' | 'scan';

export class PickerPermissionError extends Error {
  constructor() { super('Camera permission denied'); this.name = 'PickerPermissionError'; }
}

const isCancel = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e));
const isDenied = (e: unknown) => /denied|permission/i.test(e instanceof Error ? e.message : String(e));

/** Opens a hidden <input type=file>. `cancel` is fired by current WebKit; if a browser never fires it the promise stays pending, which is harmless. */
function pickWithInput(opts: { accept: string; multiple: boolean; capture?: 'environment' }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = opts.accept;
    input.multiple = opts.multiple;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}

const asPhotos = (files: File[]): CapturedFile[] => files.map((f) => ({ blob: f, filename: f.name, kind: 'photo' as const }));

async function blobFromWebPath(webPath: string): Promise<Blob> {
  return (await fetch(webPath)).blob();
}

export async function takePhoto(): Promise<CapturedFile[]> {
  if (!isNative()) return asPhotos(await pickWithInput({ accept: 'image/*', multiple: false, capture: 'environment' }));
  try {
    const { Camera } = await import('@capacitor/camera');
    const res = await Camera.takePhoto({ saveToGallery: false, correctOrientation: true });
    if (!res.webPath) return [];
    return [{ blob: await blobFromWebPath(res.webPath), filename: 'photo.jpg', kind: 'photo' }];
  } catch (e) {
    if (isCancel(e)) return [];
    if (isDenied(e)) throw new PickerPermissionError();
    throw e;
  }
}

export async function choosePhotos(): Promise<CapturedFile[]> {
  if (!isNative()) return asPhotos(await pickWithInput({ accept: 'image/*', multiple: true }));
  try {
    const { Camera, MediaTypeSelection } = await import('@capacitor/camera');
    const res = await Camera.chooseFromGallery({ mediaType: MediaTypeSelection.Photo, allowMultipleSelection: true, limit: 10 });
    const out: CapturedFile[] = [];
    for (const [i, r] of res.results.entries()) {
      if (r.webPath) out.push({ blob: await blobFromWebPath(r.webPath), filename: `photo-${i + 1}.jpg`, kind: 'photo' });
    }
    return out;
  } catch (e) {
    if (isCancel(e)) return [];
    if (isDenied(e)) throw new PickerPermissionError();
    throw e;
  }
}

export async function chooseDocuments(): Promise<CapturedFile[]> {
  const accept = DOCUMENT_EXTENSIONS.map((e) => `.${e}`).join(',');
  const files = await pickWithInput({ accept, multiple: true });
  return files.map((f) => ({ blob: f, filename: f.name, kind: 'document' as const }));
}
