// Generates PNG icons from SVG sources for PWA + iOS Capacitor.
// Run: node scripts/generate-icons.mjs

import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');

const svgSrc = readFileSync(join(root, 'static/icon-512.svg'));

const icons = [
  // PWA / web
  { out: 'static/apple-touch-icon.png', size: 180  },
  { out: 'static/icon-192.png',         size: 192  },
  { out: 'static/icon-512.png',         size: 512  },
  // iOS AppIcon — Contents.json expects this exact filename
  { out: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', size: 1024 },
];

for (const { out, size } of icons) {
  const dest = join(root, out);
  try {
    await sharp(svgSrc)
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(dest);
    console.log(`✓ ${out} (${size}×${size})`);
  } catch (e) {
    console.error(`✗ ${out}: ${e.message}`);
  }
}
