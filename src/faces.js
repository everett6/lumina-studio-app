import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Face identity check, free and local: "is the person in this clip the same person as in the character's
// reference photos?" Uses two open models from OpenCV's model zoo, run with ONNX Runtime (WebAssembly, CPU):
//  - YuNet (MIT licence) finds faces and five landmarks (eyes, nose, mouth corners);
//  - SFace (Apache 2.0) turns an aligned 112×112 face into a 128-number identity vector.
// Two faces whose vectors have a cosine similarity of 0.363 or more are the same person by OpenCV's published
// threshold for SFace. The models are downloaded once (about 39 MB) when the person asks, and checked against
// pinned SHA-256 hashes. Trained on real human faces: for anime or animals no faces are usually found and the
// check reports that instead of guessing.

export const faceModels = {
  detector: {
    file: 'face_detection_yunet_2023mar.onnx', bytes: 232_589,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  },
  recognizer: {
    file: 'face_recognition_sface_2021dec.onnx', bytes: 38_696_353,
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
  },
};
export const samePersonThreshold = 0.363;
const side = 640; // YuNet's input is a fixed 640×640 picture
// Where SFace expects the five landmarks in its 112×112 crop (OpenCV's alignment template).
const template = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

// ---------- pure helpers (tested directly) ----------

// Decode YuNet's raw outputs into faces: { box: [x, y, w, h], landmarks: [[x, y] × 5], score } in input pixels.
export function decodeFaces(outputs, { threshold = 0.6, nms = 0.3 } = {}) {
  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cols = side / stride;
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const box = outputs[`bbox_${stride}`];
    const kps = outputs[`kps_${stride}`];
    for (let i = 0; i < cls.length; i += 1) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < threshold) continue;
      const [r, c] = [Math.floor(i / cols), i % cols];
      const cx = (c + box[i * 4]) * stride;
      const cy = (r + box[i * 4 + 1]) * stride;
      const w = Math.exp(box[i * 4 + 2]) * stride;
      const h = Math.exp(box[i * 4 + 3]) * stride;
      const landmarks = [0, 1, 2, 3, 4].map((n) => [(kps[i * 10 + 2 * n] + c) * stride, (kps[i * 10 + 2 * n + 1] + r) * stride]);
      faces.push({ box: [cx - w / 2, cy - h / 2, w, h], landmarks, score });
    }
  }
  faces.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const face of faces) if (kept.every((other) => overlap(face.box, other.box) <= nms)) kept.push(face);
  return kept;
}

function overlap([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const w = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const h = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const inter = w * h;
  return inter / (aw * ah + bw * bh - inter || 1);
}

// Least-squares similarity transform (scale, rotation, shift) taking `from` points onto `to` points.
// Returns [a, b, tx, ty] for x' = a·x − b·y + tx, y' = b·x + a·y + ty.
export function similarity(from, to) {
  const n = from.length;
  const mean = (pts, k) => pts.reduce((s, p) => s + p[k], 0) / n;
  const [fx, fy, tx, ty] = [mean(from, 0), mean(from, 1), mean(to, 0), mean(to, 1)];
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const [x, y] = [from[i][0] - fx, from[i][1] - fy];
    const [u, v] = [to[i][0] - tx, to[i][1] - ty];
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  const a = num1 / (den || 1);
  const b = num2 / (den || 1);
  return [a, b, tx - (a * fx - b * fy), ty - (b * fx + a * fy)];
}

// The 112×112 aligned face from an RGB picture, as SFace's input tensor (planar RGB, 0–255), bilinear sampling.
export function alignedFace(rgb, width, height, landmarks) {
  const [a, b, tx, ty] = similarity(landmarks, template);
  // Invert x' = A·x + t to sample the source for each output pixel.
  const det = a * a + b * b || 1;
  const out = new Float32Array(3 * 112 * 112);
  for (let y = 0; y < 112; y += 1) {
    for (let x = 0; x < 112; x += 1) {
      const [dx, dy] = [x - tx, y - ty];
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const [fx, fy] = [sx - x0, sy - y0];
      for (let c = 0; c < 3; c += 1) {
        const at = (px, py) => (px < 0 || py < 0 || px >= width || py >= height ? 0 : rgb[(py * width + px) * 3 + c]);
        const value = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
        out[c * 112 * 112 + y * 112 + x] = value;
      }
    }
  }
  return out;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

// ---------- models and pictures ----------

let ortModule = null;
async function ort() {
  if (!ortModule) {
    ortModule = await import('onnxruntime-web');
    ortModule.env.wasm.numThreads = 1; // no worker threads inside the app's server process
    ortModule.env.logLevel = 'error';
  }
  return ortModule;
}

// One picture (an image file, or the frame of a video at `at` seconds) letterboxed into 640×640 RGB.
function picture(file, at = null) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', ...(at != null ? ['-ss', at.toFixed(3)] : []), '-i', file, '-frames:v', '1',
      '-vf', `scale=${side}:${side}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${side}:${side}:0:0,format=rgb24`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: side * side * 3 + 1024, timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

export function createFaceChecker({ binDir, log = console, fetchImpl = fetch }) {
  const dir = path.join(binDir, 'faces');
  const file = (model) => path.join(dir, faceModels[model].file);
  let sessions = null;
  let installing = null;
  const embeddings = new Map(); // reference image path → identity vectors (cached)

  const installed = () => Object.keys(faceModels).every((model) => existsSync(file(model)));

  async function install() {
    if (installed()) return status();
    installing ??= (async () => {
      await mkdir(dir, { recursive: true });
      for (const [model, spec] of Object.entries(faceModels)) {
        if (existsSync(file(model))) continue;
        const response = await fetchImpl(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw new Error(`Could not download the ${model} model (HTTP ${response.status}).`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== spec.sha256) throw new Error(`The downloaded ${model} model does not match its published checksum; it was not installed.`);
        await writeFile(`${file(model)}.part`, bytes);
        await rename(`${file(model)}.part`, file(model));
        log.info?.('Face model installed', { model, bytes: bytes.length });
      }
    })().finally(() => { installing = null; });
    await installing;
    return status();
  }

  async function load() {
    if (!installed()) throw Object.assign(new Error('The face check is not installed yet.'), { needsDownload: true });
    if (!sessions) {
      const runtime = await ort();
      sessions = {
        detector: await runtime.InferenceSession.create(await readFile(file('detector')), { logSeverityLevel: 3 }),
        recognizer: await runtime.InferenceSession.create(await readFile(file('recognizer')), { logSeverityLevel: 3 }),
      };
    }
    return sessions;
  }

  // Identity vectors for every face found in one picture, largest faces first.
  async function facesIn(source, at = null) {
    const { detector, recognizer } = await load();
    const runtime = await ort();
    const rgb = await picture(source, at);
    const input = new Float32Array(3 * side * side);
    for (let i = 0; i < side * side; i += 1) {
      // YuNet takes BGR, 0–255, planar.
      input[i] = rgb[i * 3 + 2];
      input[side * side + i] = rgb[i * 3 + 1];
      input[2 * side * side + i] = rgb[i * 3];
    }
    const raw = await detector.run({ input: new runtime.Tensor('float32', input, [1, 3, side, side]) });
    const outputs = Object.fromEntries(Object.entries(raw).map(([name, tensor]) => [name, tensor.data]));
    const faces = decodeFaces(outputs).filter((f) => f.box[2] >= 24 && f.box[3] >= 24).sort((x, y) => y.box[2] * y.box[3] - x.box[2] * x.box[3]).slice(0, 6);
    const vectors = [];
    for (const face of faces) {
      const aligned = alignedFace(rgb, side, side, face.landmarks);
      const result = await recognizer.run({ data: new runtime.Tensor('float32', aligned, [1, 3, 112, 112]) });
      vectors.push({ vector: Float32Array.from(result.fc1.data), box: face.box, score: face.score });
    }
    return vectors;
  }

  async function referenceVectors(paths) {
    const out = [];
    for (const p of paths) {
      if (!embeddings.has(p)) embeddings.set(p, (await facesIn(p))[0]?.vector ?? null); // the main (largest) face
      if (embeddings.get(p)) out.push(embeddings.get(p));
    }
    return out;
  }

  // Checks for one clip: for each person with reference photos, the best match among the faces seen in frames
  // sampled across the clip. people: [{ name, referencePaths }].
  async function checkClip(clipPath, people, { duration }) {
    const withPhotos = people.filter((p) => p.referencePaths.length);
    if (!withPhotos.length || !installed()) return [];
    const times = [0.15, 0.5, 0.85].map((f) => Math.max(0, duration * f));
    const seen = [];
    for (const at of times) seen.push(...await facesIn(clipPath, at));
    if (!seen.length) {
      return [{ id: 'faces', ok: true, severity: 'warning', detail: 'No human faces found in the clip, so identity was not checked (normal for anime, animals or wide shots)' }];
    }
    const checks = [];
    for (const person of withPhotos) {
      const refs = await referenceVectors(person.referencePaths);
      if (!refs.length) {
        checks.push({ id: `face:${person.name}`, ok: true, severity: 'warning', detail: `No face found in ${person.name}'s reference photos, so identity was not checked` });
        continue;
      }
      const best = Math.max(...seen.map((f) => Math.max(...refs.map((r) => cosine(f.vector, r)))));
      const ok = best >= samePersonThreshold;
      checks.push({
        id: `face:${person.name}`, ok, severity: 'warning', score: best,
        detail: ok ? `${person.name} matches the reference photos (identity ${best.toFixed(2)})`
          : `No face in the clip matches ${person.name}'s reference photos (best ${best.toFixed(2)}, same person ≥ ${samePersonThreshold}): the face may have drifted`,
      });
    }
    return checks;
  }

  function status() {
    return { installed: installed(), installing: Boolean(installing), downloadMb: Math.round(Object.values(faceModels).reduce((s, m) => s + m.bytes, 0) / 1e6) };
  }

  return { install, status, checkClip, facesIn, compare: async (a, b) => {
    const [x, y] = [(await facesIn(a))[0], (await facesIn(b))[0]];
    return x && y ? cosine(x.vector, y.vector) : null;
  } };
}
