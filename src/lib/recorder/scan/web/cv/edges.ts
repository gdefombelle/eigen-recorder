/**
 * Edge detection pipeline: grayscale → Gaussian blur → Canny.
 * Runs in a Web Worker on a downscaled image for speed.
 */

function toGrayscale(img: ImageData): Uint8Array {
  const { data, width, height } = img;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i]! * 77 + data[i + 1]! * 150 + data[i + 2]! * 29) >> 8;
  }
  return gray;
}

// Separable 5-tap binomial kernel [1,4,6,4,1]/16
const K5 = [1, 4, 6, 4, 1] as const;

function gaussianBlur5(gray: Uint8Array, w: number, h: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 5; k++) {
        s += K5[k]! * gray[y * w + Math.min(Math.max(x + k - 2, 0), w - 1)]!;
      }
      tmp[y * w + x] = s >> 4;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 5; k++) {
        s += K5[k]! * tmp[Math.min(Math.max(y + k - 2, 0), h - 1) * w + x]!;
      }
      out[y * w + x] = s >> 4;
    }
  }
  return out;
}

function canny(gray: Uint8Array, w: number, h: number): Uint8Array {
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);

  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[(y - 1) * w + (x - 1)]! - 2 * gray[y * w + (x - 1)]! - gray[(y + 1) * w + (x - 1)]! +
         gray[(y - 1) * w + (x + 1)]! + 2 * gray[y * w + (x + 1)]! + gray[(y + 1) * w + (x + 1)]!;
      const gy =
        -gray[(y - 1) * w + (x - 1)]! - 2 * gray[(y - 1) * w + x]! - gray[(y - 1) * w + (x + 1)]! +
         gray[(y + 1) * w + (x - 1)]! + 2 * gray[(y + 1) * w + x]! + gray[(y + 1) * w + (x + 1)]!;
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[y * w + x] = m;
      if (m > maxMag) maxMag = m;
      const angle = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
      dir[y * w + x] =
        angle < 22.5 || angle >= 157.5 ? 0 :
        angle < 67.5 ? 1 :
        angle < 112.5 ? 2 : 3;
    }
  }

  if (maxMag === 0) return new Uint8Array(w * h);
  const high = maxMag * 0.2;
  const low = maxMag * 0.08;

  // Non-maximum suppression
  const nms = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      let n1: number, n2: number;
      switch (dir[i]) {
        case 0:  n1 = mag[i - 1]!;                   n2 = mag[i + 1]!;                   break;
        case 1:  n1 = mag[(y - 1) * w + (x + 1)]!;   n2 = mag[(y + 1) * w + (x - 1)]!;  break;
        case 2:  n1 = mag[(y - 1) * w + x]!;         n2 = mag[(y + 1) * w + x]!;         break;
        default: n1 = mag[(y - 1) * w + (x - 1)]!;   n2 = mag[(y + 1) * w + (x + 1)]!;
      }
      nms[i] = m >= n1 && m >= n2 ? m : 0;
    }
  }

  // Hysteresis: BFS from strong edges to connect weak ones
  const WEAK = 1, STRONG = 2;
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < nms.length; i++) {
    if (nms[i]! >= high) edge[i] = STRONG;
    else if (nms[i]! >= low) edge[i] = WEAK;
  }

  const queue = new Int32Array(w * h);
  let qs = 0, qe = 0;
  for (let i = 0; i < edge.length; i++) {
    if (edge[i] === STRONG) queue[qe++] = i;
  }
  while (qs < qe) {
    const i = queue[qs++]!;
    const y = (i / w) | 0, x = i % w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dy && !dx) continue;
        const ny = y + dy, nx = x + dx;
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        const ni = ny * w + nx;
        if (edge[ni] === WEAK) { edge[ni] = STRONG; queue[qe++] = ni; }
      }
    }
  }

  const result = new Uint8Array(w * h);
  for (let i = 0; i < edge.length; i++) {
    if (edge[i] === STRONG) result[i] = 255;
  }
  return result;
}

export { toGrayscale };

export function detectEdgesFromGray(gray: Uint8Array, w: number, h: number): Uint8Array {
  const blurred = gaussianBlur5(gray, w, h);
  return canny(blurred, w, h);
}

export function detectEdges(img: ImageData): Uint8Array {
  const gray = toGrayscale(img);
  return detectEdgesFromGray(gray, img.width, img.height);
}
