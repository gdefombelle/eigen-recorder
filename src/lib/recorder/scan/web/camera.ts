/**
 * Camera service: wraps getUserMedia for document scanning.
 *
 * Ported from DocScan (scanner-app, src/lib/camera/camera.ts). In Eigen Pocket this is the PWA / browser path only:
 * the iOS app uses the native VisionKit scanner, so the Capacitor permission branch was dropped.
 * Video only (`audio: false`): the record's microphone is never touched by the scanner.
 */

export interface CameraConstraints {
  /** Preferred max width. Browsers will downscale if device can't deliver. */
  readonly idealWidth: number;
  readonly idealHeight: number;
  readonly facingMode: 'environment' | 'user';
}

export const DEFAULT_CAMERA_CONSTRAINTS: CameraConstraints = {
  idealWidth: 3840,
  idealHeight: 2160,
  facingMode: 'environment'
};

export class CameraService {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private imageCapture: ImageCapture | null = null;

  async start(constraints: CameraConstraints = DEFAULT_CAMERA_CONSTRAINTS): Promise<MediaStream> {
    if (this.stream) return this.stream;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Camera API not available. Make sure the page is served over HTTPS or localhost.'
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: constraints.facingMode },
          width: { ideal: constraints.idealWidth },
          height: { ideal: constraints.idealHeight },
          // @ts-expect-error non-standard but widely supported on mobile
          focusMode: 'continuous',
          whiteBalanceMode: 'continuous',
          exposureMode: 'continuous'
        }
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error(
          'Camera access denied. On macOS, go to System Settings → Privacy & Security → Camera and enable your browser.'
        );
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('No camera found. Make sure a camera is connected and not in use by another app.');
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new Error('Camera is already in use by another application.');
      }
      throw err;
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0] ?? null;
    if (this.track && 'ImageCapture' in globalThis) {
      // ImageCapture isn't in TS lib by default
      const Ctor = (globalThis as unknown as { ImageCapture: new (t: MediaStreamTrack) => ImageCapture })
        .ImageCapture;
      this.imageCapture = new Ctor(this.track);
    }
    return stream;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
  }

  /** Grab a still photo at full sensor resolution if possible. */
  async grabStill(): Promise<ImageBitmap> {
    if (!this.track) throw new Error('Camera not started');
    if (this.imageCapture) {
      try {
        const blob = await this.imageCapture.takePhoto();
        return await createImageBitmap(blob);
      } catch {
        // fall through to grabFrame
      }
      try {
        return await this.imageCapture.grabFrame();
      } catch {
        // fall through to canvas capture
      }
    }
    // Fallback: draw the current video frame to a canvas.
    const settings = this.track.getSettings();
    const w = settings.width ?? 1920;
    const h = settings.height ?? 1080;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context');
    // Caller must have a <video> playing the stream; we expose a helper
    throw new Error('grabStill fallback requires a HTMLVideoElement; use grabStillFromVideo()');
  }

  /**
   * Grab a sharp still from the camera, capped at MAX_PX on the long side.
   *
   * Priority:
   *   1. ImageCapture.takePhoto() — real sensor exposure, proper autofocus.
   *   2. ImageCapture.grabFrame() — better than video frame.
   *   3. Canvas draw from live video — fallback.
   *
   * Capped at 2048 px: the pipeline worker transfers this as an ArrayBuffer
   * (via postMessage). A 12 MP image = 48 MB would cause silent OOM crashes
   * in the worker on mobile devices. 2048 px gives ~4 MP which is plenty
   * for OCR-quality documents (A4 at ~200 DPI).
   */
  /**
   * Grab a fast video frame for the detection loop (NOT for final capture).
   * Always reads from the live stream — no ImageCapture, no photo.
   * Keep maxPx low (640) to run at detection speed.
   */
  grabVideoFrame(video: HTMLVideoElement, maxPx = 640): ImageData {
    const { videoWidth: vw, videoHeight: vh } = video;
    const scale = Math.min(1, maxPx / Math.max(vw, vh));
    const dw = Math.round(vw * scale);
    const dh = Math.round(vh * scale);
    const canvas = new OffscreenCanvas(dw, dh);
    canvas.getContext('2d')!.drawImage(video, 0, 0, dw, dh);
    return canvas.getContext('2d')!.getImageData(0, 0, dw, dh);
  }

  async grabStillFromVideo(video: HTMLVideoElement): Promise<ImageData> {
    const MAX_PX = 2048;

    let bitmap: ImageBitmap | null = null;

    if (this.imageCapture) {
      try {
        // 8s timeout — takePhoto() can hang if camera is in a bad state
        const blob = await Promise.race([
          this.imageCapture.takePhoto({ fillLightMode: 'auto' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('takePhoto timeout')), 8_000)),
        ]);
        bitmap = await createImageBitmap(blob);
      } catch { /* fall through to grabFrame or video */ }

      if (!bitmap) {
        try { bitmap = await this.imageCapture.grabFrame(); }
        catch { /* fall through */ }
      }
    }

    if (bitmap) {
      const scale = Math.min(1, MAX_PX / Math.max(bitmap.width, bitmap.height));
      const dw = Math.round(bitmap.width  * scale);
      const dh = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(dw, dh);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, dw, dh);
      bitmap.close();
      return canvas.getContext('2d')!.getImageData(0, 0, dw, dh);
    }

    // Fallback: video frame, also capped
    const { videoWidth: vw, videoHeight: vh } = video;
    const scale = Math.min(1, MAX_PX / Math.max(vw, vh));
    const dw = Math.round(vw * scale);
    const dh = Math.round(vh * scale);
    const canvas = new OffscreenCanvas(dw, dh);
    canvas.getContext('2d')!.drawImage(video, 0, 0, dw, dh);
    return canvas.getContext('2d')!.getImageData(0, 0, dw, dh);
  }

  async setTorch(on: boolean): Promise<void> {
    if (!this.track) return;
    const capabilities = this.track.getCapabilities() as MediaTrackCapabilities & {
      torch?: boolean;
    };
    if (!capabilities.torch) return;
    await this.track.applyConstraints({
      // @ts-expect-error non-standard
      advanced: [{ torch: on }]
    });
  }

  hasTorch(): boolean {
    if (!this.track) return false;
    const c = this.track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    return c.torch === true;
  }
}

// Minimal type for ImageCapture (not in standard lib.dom yet)
interface ImageCapture {
  takePhoto(options?: { fillLightMode?: 'auto' | 'off' | 'flash' }): Promise<Blob>;
  grabFrame(): Promise<ImageBitmap>;
}
