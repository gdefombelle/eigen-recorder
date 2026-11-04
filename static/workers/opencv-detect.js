/**
 * Classic Web Worker — loads OpenCV.js via importScripts (not available in
 * ES module workers). Runs Canny + findContours + approxPolyDP on the
 * captured image to find the document quadrilateral.
 *
 * Protocol:
 *   in:  { id, buffer: ArrayBuffer, width, height }
 *   out: { id, quad: { tl, tr, br, bl } | null }
 *        { id, error: string }
 */

'use strict';

const OPENCV_URL = 'https://docs.opencv.org/4.8.0/opencv.js';

let cvReady = false;
const pending = [];

// Set up the Module object BEFORE importScripts so OpenCV picks it up
self.Module = {
  onRuntimeInitialized() {
    cvReady = true;
    for (const msg of pending) handle(msg);
    pending.length = 0;
  },
  printErr() {}, // suppress WASM log spam
};

try {
  importScripts(OPENCV_URL);
} catch (e) {
  // If loading fails, every incoming message will get an error response
  self.addEventListener('message', (ev) => {
    self.postMessage({ id: ev.data.id, error: 'OpenCV load failed: ' + e.message });
  });
}

self.addEventListener('message', (ev) => {
  if (!cvReady) { pending.push(ev); }
  else { handle(ev); }
});

function handle(ev) {
  const { id, buffer, width, height } = ev.data;
  try {
    const quad = detect(buffer, width, height);
    self.postMessage({ id, quad });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
}

function detect(buffer, width, height) {
  const cv = self.cv;
  const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);

  // ── 1. Build Mat ────────────────────────────────────────────────────────────
  const src = cv.matFromImageData(imageData);

  // ── 2. Grayscale + blur ─────────────────────────────────────────────────────
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  // ── 3. Canny edges ──────────────────────────────────────────────────────────
  const edges = new cv.Mat();
  cv.Canny(blurred, edges, 50, 180);

  // Dilate to close small gaps in the document boundary
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const dilated = new cv.Mat();
  cv.dilate(edges, dilated, kernel);

  // ── 4. Find contours ────────────────────────────────────────────────────────
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const minArea = width * height * 0.05; // at least 5% of frame
  let bestMat = null, bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < minArea) { c.delete(); continue; }

    const peri = cv.arcLength(c, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.02 * peri, true);

    if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
      bestArea = area;
      if (bestMat) bestMat.delete();
      bestMat = approx;
    } else {
      approx.delete();
    }
    c.delete();
  }

  // ── 5. Extract and order 4 corners ─────────────────────────────────────────
  let quad = null;
  if (bestMat) {
    const pts = [];
    for (let i = 0; i < 4; i++) {
      // approxPolyDP returns CV_32S integer points
      pts.push({ x: bestMat.data32S[i * 2], y: bestMat.data32S[i * 2 + 1] });
    }
    bestMat.delete();

    // Order corners: TL=min(x+y), TR=max(x-y), BR=max(x+y), BL=min(x-y)
    quad = {
      tl: pts.reduce((a, b) => (a.x + a.y) < (b.x + b.y) ? a : b),
      tr: pts.reduce((a, b) => (a.x - a.y) > (b.x - b.y) ? a : b),
      br: pts.reduce((a, b) => (a.x + a.y) > (b.x + b.y) ? a : b),
      bl: pts.reduce((a, b) => (a.x - a.y) < (b.x - b.y) ? a : b),
    };
  }

  // ── 6. Cleanup ──────────────────────────────────────────────────────────────
  src.delete(); gray.delete(); blurred.delete(); edges.delete();
  kernel.delete(); dilated.delete(); contours.delete(); hierarchy.delete();

  return quad;
}
