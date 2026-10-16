import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFilm } from '../src/publish.js';

test('the publish description lists the voice cast and every music and sound credit', () => {
  const text = describeFilm('Night Run', {
    voices: [{ name: 'Narrator', voice: 'bm_fable (kokoro-82m)' }, { name: 'Aiko', voice: 'af_heart (kokoro-82m)' }],
    music: [{ credit: '"Calm" by Ana is licensed under CC BY 4.0.', page: 'https://example.org/calm', needsCredit: true }],
    sounds: [{ credit: '"Clash" by B is marked with CC0 1.0.', page: null, needsCredit: false }],
  }, { logline: 'One night, one chance.' });
  assert.match(text, /^Night Run\n\nOne night, one chance\./);
  assert.match(text, /Aiko: af_heart/);
  assert.match(text, /"Calm" by Ana is licensed under CC BY 4\.0\. \(https:\/\/example\.org\/calm\)/);
  assert.match(text, /"Clash" by B/);
  assert.match(text, /Made with Lumina Studio\.$/);
});
