import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJson } from '../src/books.js';
import { startTestApp, tinyPngDataUrl } from './helpers.js';

const writer = 'mock:mock-director';

async function waitFor(check, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

test('extractJson tolerates prose and fences around the object', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson('no json here'), /structured output/);
  assert.throws(() => extractJson('{broken'), /structured output|malformed/);
});

test('picture book: brief → bible → page plan → edit history → revise → illustrate → export', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Books' })).body;
    const created = await t.call('POST', `/api/projects/${project.id}/books`, {
      title: 'Pip and the Lake', writer, brief: { premise: 'A fox learns to swim', pageCount: 4, trimSize: '8x8', author: 'Test Author', pageCountJunk: 1 },
    });
    assert.equal(created.status, 201);
    const book = created.body.book;
    assert.equal(book.brief.pageCount, 4);
    assert.equal(book.brief.language, 'English');

    // A character reference image survives re-drafting the bible.
    const { asset: foxRef } = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl(), label: 'Pip sheet' })).body;
    await t.call('PATCH', `/api/books/${book.id}`, { bible: { characters: [{ name: 'Pip', description: 'x', visual: 'y', referenceAssetIds: [foxRef.id] }] } });
    const bible = (await t.call('POST', `/api/books/${book.id}/bible`, {})).body.book.bible;
    assert.equal(bible.characters.length, 2);
    assert.deepEqual(bible.characters.find((c) => c.name === 'Pip').referenceAssetIds, [foxRef.id]);
    assert.match(bible.styleNotes, /watercolor/);

    const planned = (await t.call('POST', `/api/books/${book.id}/plan`, {})).body;
    assert.equal(planned.pages.length, 4);
    assert.deepEqual(planned.pages.map((p) => p.position), [1, 2, 3, 4]);
    assert.equal((await t.call('POST', `/api/books/${book.id}/plan`, {})).status, 409);

    const [first, second] = planned.pages;
    await t.call('PATCH', `/api/pages/${first.id}`, { text: 'Hand-edited opening line.' });
    const revisions = (await t.call('GET', `/api/pages/${first.id}/revisions`)).body.revisions;
    assert.deepEqual(revisions.map((r) => r.source), ['edit', 'plan']);

    const revised = (await t.call('POST', `/api/pages/${second.id}/revise`, { instruction: 'make it funnier' })).body.page;
    assert.match(revised.text, /make it funnier/);
    assert.equal((await t.call('POST', `/api/pages/${second.id}/revise`, { instruction: ' ' })).status, 400);

    await t.call('POST', `/api/pages/${second.id}/move`, { direction: 'up' });
    let detail = (await t.call('GET', `/api/books/${book.id}`)).body;
    assert.equal(detail.pages[0].id, second.id);
    const added = (await t.call('POST', `/api/books/${book.id}/pages`, { position: 2, text: 'Inserted page' })).body.page;
    assert.equal(added.position, 2);
    await t.call('DELETE', `/api/pages/${added.id}`);
    detail = (await t.call('GET', `/api/books/${book.id}`)).body;
    assert.deepEqual(detail.pages.map((p) => p.position), [1, 2, 3, 4]);

    // Illustration: character canon goes into the prompt; the reference image rides along as an input.
    const illustrated = (await t.call('POST', `/api/pages/${second.id}/illustrate`, { provider: 'mock', model: 'mock-image' })).body;
    assert.match(illustrated.generation.prompt, /Pip — small red fox/);
    assert.match(illustrated.generation.prompt, /Do not include any text/);
    assert.deepEqual(illustrated.generation.inputAssetIds, [foxRef.id]);
    assert.equal(illustrated.generation.params.size, '1024x1024');
    const page = await waitFor(async () => {
      const current = (await t.call('GET', `/api/books/${book.id}`)).body.pages.find((p) => p.id === second.id);
      return current.assetId ? current : null;
    });
    assert.equal(page.illustrations[0].status, 'completed');
    assert.equal(page.assetId, page.illustrations[0].assetId);

    const pdf = await fetch(`${t.app.origin}/api/books/${book.id}/export.pdf`, { headers: { authorization: `Bearer ${t.app.token}` } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-disposition'), /Pip-and-the-Lake\.pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    const pageCount = (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    assert.equal(pageCount, 5, 'title page + 4 book pages');
    assert.ok(bytes.toString('latin1').includes('/Subtype /Image'), 'illustration embedded');

    const md = await t.call('GET', `/api/books/${book.id}/export.md`);
    assert.match(md.text, /^# Pip and the Lake/);
    assert.match(md.text, /Hand-edited opening line\./);
  } finally {
    await t.close();
  }
});

test('writer errors are clear: missing key, unknown model', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Keys' })).body;
    const { book } = (await t.call('POST', `/api/projects/${project.id}/books`, { title: 'X', writer: 'anthropic:claude-opus-5-5' })).body;
    const noKey = await t.call('POST', `/api/books/${book.id}/bible`, {});
    assert.equal(noKey.status, 400);
    assert.match(noKey.body.error, /Anthropic Claude key/);
    const bad = await t.call('POST', `/api/books/${book.id}/plan`, { writer: 'openai:nope' });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
  }
});
