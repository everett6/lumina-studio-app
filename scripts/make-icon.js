// Generates build/icon.png (512x512): a lime rounded tile with a dark lens ring. Run: node scripts/make-icon.js
import { writeFileSync } from 'node:fs';
import { encodePng } from '../src/png.js';

const size = 512;
const lime = [212, 245, 121];
const ink = [23, 24, 18];
const bg = [17, 17, 15];
const radius = 110;

const insideRoundedSquare = (x, y) => {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
};

const png = encodePng(size, size, (x, y) => {
  if (!insideRoundedSquare(x, y)) return bg;
  const d = Math.hypot(x - size / 2, y - size / 2);
  if (d > 118 && d < 158) return ink;
  if (d < 52) return ink;
  return lime;
});
writeFileSync(new URL('../build/icon.png', import.meta.url), png);
