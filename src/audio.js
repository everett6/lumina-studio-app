// Audio helpers for narration: split long text for TTS request limits, join the resulting clips, and make test tones.

// Split at paragraph, then sentence, then word boundaries so each chunk stays under `max` characters.
export function splitForSpeech(text, max = 3800) {
  const chunks = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  const pieces = String(text).split(/(?<=[.!?。！？])\s+|\n{2,}/);
  for (const piece of pieces) {
    if (piece.length > max) {
      push();
      let rest = piece;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max) > max / 2 ? rest.lastIndexOf(' ', max) : max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      current = rest;
    } else if ((current + ' ' + piece).length > max) {
      push();
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  push();
  return chunks;
}

function readWav(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    // Streaming encoders sometimes write 0 or 0xFFFFFFFF as the data size; treat that as "to the end".
    let size = buffer.readUInt32LE(offset + 4);
    if (id === 'data' && (size === 0 || size === 0xffffffff || offset + 8 + size > buffer.length)) size = buffer.length - offset - 8;
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') format = body;
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV file is missing fmt or data');
  return { format, data };
}

export function writeWav(format, data) {
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + 8 + format.length + 8 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk('fmt ', format), chunk('data', data)]);
}

// MP3 frames can simply be concatenated; WAV needs one header over the combined PCM data.
export function joinAudio(clips, mime) {
  if (clips.length === 1) return clips[0];
  if (mime === 'audio/mpeg') return Buffer.concat(clips);
  if (mime === 'audio/wav') {
    const parsed = clips.map(readWav);
    const format = parsed[0].format;
    if (parsed.some((p) => !p.format.equals(format))) throw new Error('Narration clips use different audio formats and cannot be joined.');
    return writeWav(format, Buffer.concat(parsed.map((p) => p.data)));
  }
  throw new Error(`Cannot join ${mime} audio`);
}

// 16-bit mono PCM sine tone; used by the offline mock voice.
export function toneWav(seconds, frequency = 440, sampleRate = 16000) {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 6000), i * 2);
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * 2, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  return writeWav(format, data);
}
