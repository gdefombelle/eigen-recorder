// Test-only: Node has no ImageData. A minimal stand-in so the pure pixel code (edges, quad, homography, enhance) runs under vitest.
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(dataOrW: Uint8ClampedArray | number, wOrH: number, h?: number) {
      if (typeof dataOrW === 'number') { this.width = dataOrW; this.height = wOrH; this.data = new Uint8ClampedArray(this.width * this.height * 4); }
      else { this.data = dataOrW; this.width = wOrH; this.height = h ?? dataOrW.length / 4 / wOrH; }
    }
  }
  (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPolyfill;
}
export {};
