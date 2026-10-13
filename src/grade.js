import { execFile } from 'node:child_process';

// Shot-to-shot colour matching, free and local. AI video models each pick their own exposure, white balance and
// saturation, so cuts between shots of the same scene can jump in colour. Each clip's colour statistics (mean and
// spread of red, green and blue over frames sampled across the clip) are measured, and the clip is mapped onto the
// statistics of a reference shot with a per-channel linear curve (a simple form of Reinhard colour transfer). The
// curve is applied inside the encode that already happens when the film is joined, so it costs no extra
// generation. Gains are clamped and the correction is blended (`strength`) so a deliberate change of light inside a
// scene is softened, not erased.

const sampleSize = [64, 36];

export async function colourStats(file, { fps = 2 } = {}) {
  const bytes = await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${sampleSize[0]}:${sampleSize[1]}:flags=area,format=rgb24`, '-frames:v', '120', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 300_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  if (!bytes.length) throw new Error('No frames could be read for colour matching.');
  const sum = [0, 0, 0];
  const squares = [0, 0, 0];
  const pixels = bytes.length / 3;
  for (let i = 0; i < bytes.length; i += 3) {
    for (let c = 0; c < 3; c += 1) {
      sum[c] += bytes[i + c];
      squares[c] += bytes[i + c] * bytes[i + c];
    }
  }
  const mean = sum.map((s) => s / pixels);
  const std = squares.map((s, c) => Math.sqrt(Math.max(0, s / pixels - mean[c] * mean[c])));
  return { mean, std };
}

// The per-channel curve that moves `source` towards `reference`: out = (in - mS) * gain + mR, blended with the
// original by `strength`. Returns null when the shots already match (nothing worth re-mapping).
export function matchCurve(source, reference, { strength = 0.75, maxGain = 1.35 } = {}) {
  const channels = [0, 1, 2].map((c) => {
    const gain = Math.min(maxGain, Math.max(1 / maxGain, (reference.std[c] || 1) / (source.std[c] || 1)));
    // Blend the mapping with identity: k = 1 + s(g - 1), offset so the source mean lands s of the way to the reference.
    const k = 1 + strength * (gain - 1);
    const target = source.mean[c] + strength * (reference.mean[c] - source.mean[c]);
    return { k, offset: target - source.mean[c] * k };
  });
  const shift = Math.max(...channels.map(({ k, offset }, c) => Math.abs(source.mean[c] * k + offset - source.mean[c]) + Math.abs(k - 1) * 64));
  return shift < 1.5 ? null : channels;
}

// An ffmpeg filter fragment applying a curve (8-bit RGB lookup tables, clipped).
export function curveFilter(curve) {
  if (!curve) return '';
  const expr = ({ k, offset }) => `clip(val*${k.toFixed(5)}${offset >= 0 ? '+' : ''}${offset.toFixed(3)}\\,0\\,255)`;
  return `format=rgb24,lutrgb=r=${expr(curve[0])}:g=${expr(curve[1])}:b=${expr(curve[2])}`;
}
