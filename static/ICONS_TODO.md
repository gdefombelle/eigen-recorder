# Icons needed for full PWA + iOS support

Generate these PNG files (e.g. with Inkscape, Figma export, or `sharp` script):

- `apple-touch-icon.png`  — 180×180 px  (iOS home screen)
- `icon-192.png`           — 192×192 px  (PWA manifest + Android)
- `icon-512.png`           — 512×512 px  (PWA manifest splash)
- `icon-maskable-512.png`  — 512×512 px  (Android adaptive icon, safe zone 80%)

Use the same design as icon-192.svg / icon-512.svg.

Quick generation with sharp (Node):
  npx sharp-cli -i icon-512.svg -o apple-touch-icon.png resize 180
  npx sharp-cli -i icon-512.svg -o icon-192.png resize 192
  npx sharp-cli -i icon-512.svg -o icon-512.png resize 512
