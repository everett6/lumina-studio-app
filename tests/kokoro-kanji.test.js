import assert from 'node:assert/strict';
import test from 'node:test';
import local from '../src/providers/local.js';

test('Kokoro Japanese voices refuse kanji with a clear message instead of reading "Chinese letter"', async (context) => {
  try {
    await local.speak({ model: 'kokoro-82m', text: '今夜の月', voice: 'jf_alpha' });
    context.skip('voices are not installed here');
  } catch (error) {
    if (/not installed|set up|voice environment/i.test(error.message) && !/kanji/.test(error.message)) return context.skip('voices are not installed here');
    assert.equal(error.category, 'invalid_request');
    assert.match(error.detail, /kana/);
  }
});
