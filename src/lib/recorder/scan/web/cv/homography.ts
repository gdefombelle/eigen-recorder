/**
 * Perspective warp via Direct Linear Transform (DLT) homography.
 *
 * Given a source quadrilateral (detected document corners) and a target
 * rectangle size, computes the 3×3 homography H that maps destination
 * pixels back to source pixels (inverse warp), then samples via bilinear
 * interpolation.
 *
 * The 8 DOF homography is solved from 4 point correspondences using
 * Gaussian elimination with partial pivoting (8×8 linear system).
 */

import type { Quad } from '../types.js';

export function perspectiveWarp(src: ImageData, quad: Quad, dstW: number, dstH: number): ImageData {
  // Build H that maps dst corners → src quad corners (inverse warp)
  const dstPts = [[0, 0], [dstW, 0], [dstW, dstH], [0, dstH]] as const;
  const srcPts = [
    [quad.tl.x, quad.tl.y],
    [quad.tr.x, quad.tr.y],
    [quad.br.x, quad.br.y],
    [quad.bl.x, quad.bl.y],
  ] as const;
  const H = findHomography(dstPts, srcPts);
  return warp(src, H, dstW, dstH);
}

type Pts4 = ReadonlyArray<readonly [number, number]>;

function findHomography(from: Pts4, to: Pts4): Float64Array {
  const A = new Float64Array(64);
  const b = new Float64Array(8);

  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!;
    const [xp, yp] = to[i]!;

    const r1 = i * 2 * 8;
    A[r1 + 0] = x;  A[r1 + 1] = y;  A[r1 + 2] = 1;
    A[r1 + 6] = -xp * x;  A[r1 + 7] = -xp * y;
    b[i * 2] = xp;

    const r2 = (i * 2 + 1) * 8;
    A[r2 + 3] = x;  A[r2 + 4] = y;  A[r2 + 5] = 1;
    A[r2 + 6] = -yp * x;  A[r2 + 7] = -yp * y;
    b[i * 2 + 1] = yp;
  }

  const h = solve8x8(A, b);
  const H = new Float64Array(9);
  for (let i = 0; i < 8; i++) H[i] = h[i]!;
  H[8] = 1;
  return H;
}

function solve8x8(A: Float64Array, b: Float64Array): Float64Array {
  const n = 8;
  // Augmented matrix [A | b]
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j]!;
    M[i * (n + 1) + n] = b[i]!;
  }

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col, maxVal = Math.abs(M[col * (n + 1) + col]!);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row * (n + 1) + col]!);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxRow !== col) {
      for (let j = 0; j <= n; j++) {
        const t = M[col * (n + 1) + j]!;
        M[col * (n + 1) + j] = M[maxRow * (n + 1) + j]!;
        M[maxRow * (n + 1) + j] = t;
      }
    }
    const pivot = M[col * (n + 1) + col]!;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let row = col + 1; row < n; row++) {
      const f = M[row * (n + 1) + col]! / pivot;
      for (let j = col; j <= n; j++) M[row * (n + 1) + j]! -= f * M[col * (n + 1) + j]!;
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n]!;
    for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j]! * x[j]!;
    const diag = M[i * (n + 1) + i]!;
    x[i] = Math.abs(diag) > 1e-12 ? s / diag : 0;
  }
  return x;
}

function warp(src: ImageData, H: Float64Array, dstW: number, dstH: number): ImageData {
  const { data, width: srcW, height: srcH } = src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);

  const h00 = H[0]!, h01 = H[1]!, h02 = H[2]!;
  const h10 = H[3]!, h11 = H[4]!, h12 = H[5]!;
  const h20 = H[6]!, h21 = H[7]!, h22 = H[8]!;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const w_ = h20 * dx + h21 * dy + h22;
      if (Math.abs(w_) < 1e-10) continue;
      const sx = (h00 * dx + h01 * dy + h02) / w_;
      const sy = (h10 * dx + h11 * dy + h12) / w_;

      const x0 = sx | 0, y0 = sy | 0;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= srcW || y0 + 1 >= srcH) continue;

      const fx = sx - x0, fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx       * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx       * fy;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x0 + 1) * 4;
      const i01 = ((y0 + 1) * srcW + x0) * 4;
      const i11 = ((y0 + 1) * srcW + x0 + 1) * 4;
      const di  = (dy * dstW + dx) * 4;

      out[di]     = w00 * data[i00]!     + w10 * data[i10]!     + w01 * data[i01]!     + w11 * data[i11]!;
      out[di + 1] = w00 * data[i00 + 1]! + w10 * data[i10 + 1]! + w01 * data[i01 + 1]! + w11 * data[i11 + 1]!;
      out[di + 2] = w00 * data[i00 + 2]! + w10 * data[i10 + 2]! + w01 * data[i01 + 2]! + w11 * data[i11 + 2]!;
      out[di + 3] = 255;
    }
  }

  return new ImageData(out, dstW, dstH);
}
