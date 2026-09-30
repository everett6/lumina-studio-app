import { $, api, downloadAsset, h, modelsFor, on, pickAsset, state, toast } from './lib.js';

const ui = { books: [], detail: null, options: null, timers: new Map(), poll: null, cards: new Map() };
const briefFields = [
  ['title', 'Title', 'input'], ['author', 'Author', 'input'], ['premise', 'Premise — what happens and why it matters', 'textarea'],
  ['audience', 'Audience', 'input'], ['language', 'Language', 'input'], ['genre', 'Genre', 'input'], ['tone', 'Tone', 'input'],
  ['pageCount', 'Pages', 'number'], ['trimSize', 'Trim size', 'trim'], ['illustrationStyle', 'Illustration style', 'textarea'],
];

const guard = (fn) => async (...args) => {
  try { return await fn(...args); } catch (error) { toast(error.message, 'error'); return undefined; }
};

// Debounced save keyed by what is being saved, so fast typing becomes one request.
function later(key, fn, ms = 700) {
  clearTimeout(ui.timers.get(key));
  ui.timers.set(key, setTimeout(guard(fn), ms));
}

async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); } finally { button.disabled = false; button.textContent = original; }
}

function writerOptions(selected) {
  const select = h('select', { 'aria-label': 'Writer model' },
    ...(state.catalog?.directors ?? []).flatMap((d) => d.models.map((m) => h('option', { value: `${d.id}:${m}`, disabled: !d.ready }, `${d.label} · ${m}${d.ready ? '' : ' (add key)'}`))));
  const firstReady = [...select.options].find((o) => !o.disabled)?.value ?? '';
  select.value = [...select.options].some((o) => o.value === selected && !o.disabled) ? selected : firstReady;
  return select;
}

function illustratorSelect() {
  const select = h('select', { 'aria-label': 'Illustration model' },
    ...modelsFor('generate').map(({ provider, model, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${model.label}${provider.ready ? '' : ' (add key)'}`)));
  let saved = null;
  try { saved = localStorage.getItem('lumina-book-illustrator'); } catch { /* ignore */ }
  const ready = [...select.options].filter((o) => !o.disabled).map((o) => o.value);
  select.value = ready.includes(saved) ? saved : ready[0] ?? '';
  select.addEventListener('change', () => { try { localStorage.setItem('lumina-book-illustrator', select.value); } catch { /* ignore */ } });
  return select;
}

// ---------- book list / creation ----------

async function loadBooks(selectId) {
  if (!state.project) return;
  ui.options ??= await api('/api/book-options');
  ui.books = (await api(`/api/projects/${state.project.id}/books`)).books;
  const select = $('#book-select');
  select.replaceChildren(...ui.books.map((b) => h('option', { value: b.id }, `${b.title} (${b.pageCount} pages)`)));
  select.classList.toggle('hidden', !ui.books.length);
  $('#book-delete').classList.toggle('hidden', !ui.books.length);
  if (!ui.books.length) {
    ui.detail = null;
    return renderNewBookForm();
  }
  const id = [selectId, ui.detail?.book.id].find((candidate) => ui.books.some((b) => b.id === candidate)) ?? ui.books[0].id;
  select.value = id;
  await openBook(id);
}

function renderNewBookForm() {
  stopPolling();
  const brief = { ...ui.options.defaultBrief };
  const inputs = {};
  const writer = writerOptions('');
  const form = h('form.panel.new-book', { onsubmit: guard(async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
    const { book } = await api(`/api/projects/${state.project.id}/books`, { method: 'POST', body: { title: values.title, writer: writer.value, brief: values } });
    await loadBooks(book.id);
  }) },
  h('h2', {}, 'Start a picture book'),
  h('p.muted', {}, 'Describe the book. Next you will draft a story bible (characters, setting, style), plan the pages, illustrate them with consistent characters, and export a print-ready PDF.'),
  h('div.brief-grid', {}, ...briefFields.map(([key, label, kind]) => field(key, label, kind, key === 'title' ? '' : brief[key], inputs))),
  h('label', {}, h('span.field-label', {}, 'WRITER MODEL'), writer),
  h('button.button.primary', { type: 'submit' }, 'Create book'));
  $('#book-editor').replaceChildren(form);
}

function field(key, label, kind, value, inputs, onInput) {
  let input;
  if (kind === 'textarea') input = h('textarea', { rows: 3, value: value ?? '' });
  else if (kind === 'number') input = h('input', { type: 'number', min: 1, max: 48, value: value ?? 12 });
  else if (kind === 'trim') {
    input = h('select', {}, ...Object.entries(ui.options.trimSizes).map(([id, t]) => h('option', { value: id }, t.label)));
    input.value = value;
  } else input = h('input', { type: 'text', value: value ?? '', required: key === 'title', placeholder: key === 'title' ? 'The Fox Who Could Not Swim' : '' });
  inputs[key] = input;
  if (onInput) input.addEventListener(kind === 'trim' ? 'change' : 'input', onInput);
  return h(`label${kind === 'textarea' ? '.wide' : ''}`, {}, h('span.field-label', {}, label.toUpperCase()), input);
}

// ---------- editor ----------

async function openBook(id) {
  ui.detail = await api(`/api/books/${id}`);
  renderEditor();
  maybePoll();
}

function renderEditor() {
  const { book } = ui.detail;
  const option = [...$('#book-select').options].find((o) => o.value === book.id);
  if (option) option.textContent = `${book.title} (${ui.detail.pages.length} pages)`;
  const briefInputs = {};
  const saveBrief = () => later('brief', async () => {
    const values = Object.fromEntries(Object.entries(briefInputs).map(([key, input]) => [key, input.value]));
    const { title, ...brief } = values;
    ui.detail.book = (await api(`/api/books/${book.id}`, { method: 'PATCH', body: { title, brief } })).book;
    const option = [...$('#book-select').options].find((o) => o.value === book.id);
    if (option) option.textContent = `${ui.detail.book.title} (${ui.detail.pages.length} pages)`;
  });
  const writer = writerOptions(book.writer);
  writer.addEventListener('change', guard(async () => { ui.detail.book = (await api(`/api/books/${book.id}`, { method: 'PATCH', body: { writer: writer.value } })).book; }));

  const briefPanel = h('details.panel.book-section', { open: !ui.detail.pages.length },
    h('summary', {}, h('b', {}, 'Book brief'), h('span.muted', {}, `${book.brief.audience} · ${book.brief.pageCount} pages · ${ui.options.trimSizes[book.brief.trimSize]?.label ?? ''}`)),
    h('div.brief-grid', {}, ...briefFields.map(([key, label, kind]) => field(key, label, kind, key === 'title' ? book.title : book.brief[key], briefInputs, saveBrief))),
    h('label', {}, h('span.field-label', {}, 'WRITER MODEL'), writer));

  $('#book-editor').replaceChildren(h('div.book-layout', {},
    h('div.book-side', {}, briefPanel, renderBible(writer)),
    h('div.book-main', {}, renderToolbar(writer), h('div.page-list', { id: 'page-list' }))));
  renderPages();
}

function renderBible(writer) {
  const { book } = ui.detail;
  const bible = structuredClone(book.bible ?? {});
  bible.characters ??= [];
  bible.styleReferenceAssetIds ??= [];
  const save = () => later('bible', async () => { ui.detail.book = (await api(`/api/books/${book.id}`, { method: 'PATCH', body: { bible } })).book; });
  const assetPath = (id) => state.detail?.assets.find((a) => a.id === id)?.path;

  const refStrip = (ids, onChange) => h('div.ref-strip', {},
    ...ids.map((id) => h('div.tray-item', {}, assetPath(id) ? h('img', { src: assetPath(id), alt: 'Reference' }) : h('span.muted', {}, '?'),
      h('button', { 'aria-label': 'Remove reference', onclick: () => { ids.splice(ids.indexOf(id), 1); onChange(); } }, '✕'))),
    ids.length < 4 ? h('button.button.secondary.small', { type: 'button', onclick: guard(async () => {
      const asset = await pickAsset({ title: 'Choose a reference image' });
      if (!asset || ids.includes(asset.id)) return;
      ids.push(asset.id);
      await refreshProjectAssets();
      onChange();
    }) }, '+ Reference') : null);

  const container = h('div');
  const draw = () => {
    container.replaceChildren(
      ...bible.characters.map((c, index) => h('div.character-card', {},
        h('div.key-head', {}, h('input', { type: 'text', value: c.name, placeholder: 'Name', 'aria-label': 'Character name', oninput: (e) => { c.name = e.target.value; save(); } }),
          h('button.node-btn', { type: 'button', title: 'Remove character', 'aria-label': 'Remove character', onclick: () => { bible.characters.splice(index, 1); save(); draw(); } }, '✕')),
        h('textarea', { rows: 2, value: c.description, placeholder: 'Personality and role', oninput: (e) => { c.description = e.target.value; save(); } }),
        h('textarea', { rows: 2, value: c.visual, placeholder: 'Fixed look: colors, clothing, features', oninput: (e) => { c.visual = e.target.value; save(); } }),
        refStrip(c.referenceAssetIds ??= [], () => { save(); draw(); }))),
      h('button.button.secondary.small', { type: 'button', onclick: () => { bible.characters.push({ name: '', description: '', visual: '', referenceAssetIds: [] }); draw(); } }, '+ Character'),
      ...[['setting', 'Setting'], ['voice', 'Narrative voice'], ['styleNotes', 'Visual style guide']].map(([key, label]) => h('label', {}, h('span.field-label', {}, label.toUpperCase()),
        h('textarea', { rows: 3, value: bible[key] ?? '', oninput: (e) => { bible[key] = e.target.value; save(); } }))),
      h('span.field-label', {}, 'STYLE REFERENCE IMAGES'),
      refStrip(bible.styleReferenceAssetIds, () => { save(); draw(); }));
  };
  draw();

  const draftButton = h('button.button.secondary.small', { type: 'button' }, bible.characters.length ? 'Redraft with AI' : 'Draft with AI');
  draftButton.addEventListener('click', guard(() => busy(draftButton, 'Writing…', async () => {
    if (bible.characters.length && !confirm('Replace the story bible with a new AI draft? Character reference images are kept for matching names.')) return;
    ui.detail.book = (await api(`/api/books/${book.id}/bible`, { method: 'POST', body: { writer: writer.value } })).book;
    renderEditor();
    toast('Story bible drafted. Edit anything before planning pages.');
  })));

  return h('details.panel.book-section', { open: true },
    h('summary', {}, h('b', {}, 'Story bible'), h('span.muted', {}, `${bible.characters.length} character(s)`)),
    h('p.muted.small-print', {}, 'Canon used for every page and illustration. Add reference images to keep characters looking the same.'),
    draftButton, container);
}

function renderToolbar(writer) {
  const { book } = ui.detail;
  const illustrator = illustratorSelect();
  ui.illustrator = illustrator;
  const plan = h('button.button.primary.small', {}, ui.detail.pages.length ? 'Replan pages with AI' : 'Plan pages with AI');
  plan.addEventListener('click', guard(() => busy(plan, 'Writing pages…', async () => {
    const replace = ui.detail.pages.length > 0;
    if (replace && !confirm(`Replace all ${ui.detail.pages.length} pages with a new AI plan? Page history is lost for removed pages.`)) return;
    if (!book.bible?.characters?.length && !confirm('The story bible is empty. Plan pages anyway?')) return;
    ui.detail = await api(`/api/books/${book.id}/plan`, { method: 'POST', body: { writer: writer.value, replace } });
    renderEditor();
    toast(`Planned ${ui.detail.pages.length} pages.`);
  })));
  const illustrateAll = h('button.button.secondary.small', { onclick: guard(async () => {
    const missing = ui.detail.pages.filter((p) => !p.assetId && !p.illustrations.some((i) => ['queued', 'running'].includes(i.status)));
    if (!missing.length) return toast('Every page already has an illustration.');
    if (!illustrator.value) return toast('Add an image provider key in Settings first.', 'error');
    if (!confirm(`Generate ${missing.length} illustration(s) with ${illustrator.selectedOptions[0].textContent}? This uses your provider credits.`)) return;
    for (const page of missing) await illustrate(page, { quiet: true });
    toast(`Queued ${missing.length} illustration(s).`);
  }) }, 'Illustrate missing pages');
  const addPage = h('button.button.secondary.small', { onclick: guard(async () => {
    await api(`/api/books/${book.id}/pages`, { method: 'POST', body: {} });
    await openBook(book.id);
  }) }, '+ Page');
  return h('div.book-toolbar', {}, plan, addPage, h('span.toolbar-sep'), h('label.inline', {}, h('span.field-label', {}, 'ILLUSTRATOR'), illustrator), illustrateAll,
    h('span.toolbar-sep'),
    h('button.button.secondary.small', { onclick: () => exportBook('pdf') }, 'Export PDF'),
    h('button.button.secondary.small', { onclick: () => exportBook('md') }, 'Export text'));
}

function exportBook(kind) {
  const { book, pages } = ui.detail;
  if (!pages.length) return toast('Plan or add pages first.');
  if (kind === 'pdf' && pages.some((p) => !p.assetId)) toast('Pages without illustrations are exported as text-only pages.');
  downloadAsset(`/api/books/${book.id}/export.${kind}`, `${book.title}.${kind}`);
  return undefined;
}

async function illustrate(page, { quiet = false } = {}) {
  const [provider, model] = (ui.illustrator?.value ?? '').split('|');
  if (!provider) throw new Error('Add an image provider key in Settings first.');
  const result = await api(`/api/pages/${page.id}/illustrate`, { method: 'POST', body: { provider, model } });
  if (result.droppedReferences && !quiet) toast(`This model can't take reference images, so ${result.droppedReferences} reference(s) were not sent. Pick an editing-capable model for closer character consistency.`);
  await refreshPages();
}

// ---------- pages ----------

function renderPages() {
  const list = $('#page-list');
  ui.cards.clear();
  if (!ui.detail.pages.length) {
    list.replaceChildren(h('div.history-empty.muted', {}, 'No pages yet. Draft the story bible, then “Plan pages with AI” — or add pages by hand.'));
    return;
  }
  list.replaceChildren(...ui.detail.pages.map((page) => {
    const media = h('div.page-media');
    const save = (field) => (event) => later(`page-${page.id}`, async () => {
      await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { [field]: event.target.value } });
      page[field] = event.target.value;
    });
    const textArea = h('textarea.page-text', { rows: 4, value: page.text, placeholder: 'Words on this page', oninput: save('text') });
    const briefArea = h('textarea', { rows: 3, value: page.illustrationBrief, placeholder: 'What the illustration shows', oninput: save('illustrationBrief') });
    const revise = h('button.text-button', {}, 'Revise with AI…');
    revise.addEventListener('click', guard(async () => {
      const instruction = prompt('How should this page change? (e.g. "shorter, more rhythm", "Pip should feel braver")');
      if (!instruction?.trim()) return;
      await busy(revise, 'Revising…', async () => {
        const { page: updated } = await api(`/api/pages/${page.id}/revise`, { method: 'POST', body: { instruction, writer: ui.detail.book.writer } });
        Object.assign(page, updated);
        textArea.value = updated.text;
        briefArea.value = updated.illustrationBrief;
      });
    }));
    const history = h('button.text-button', { onclick: guard(async () => {
      const { revisions } = await api(`/api/pages/${page.id}/revisions`);
      showHistory(page, revisions, (rev) => {
        textArea.value = rev.text;
        briefArea.value = rev.illustrationBrief;
        return api(`/api/pages/${page.id}`, { method: 'PATCH', body: { text: rev.text, illustrationBrief: rev.illustrationBrief } });
      });
    }) }, 'History');
    const move = (direction) => guard(async () => {
      await api(`/api/pages/${page.id}/move`, { method: 'POST', body: { direction } });
      await openBook(ui.detail.book.id);
    });
    const card = h('article.panel.page-card', {},
      h('div.page-head', {}, h('b', {}, `Page ${page.position}`),
        h('div.row-actions', {},
          h('button.node-btn', { title: 'Move up', 'aria-label': 'Move page up', onclick: move('up') }, '↑'),
          h('button.node-btn', { title: 'Move down', 'aria-label': 'Move page down', onclick: move('down') }, '↓'),
          h('button.node-btn', { title: 'Insert page after', 'aria-label': 'Insert page after', onclick: guard(async () => {
            await api(`/api/books/${ui.detail.book.id}/pages`, { method: 'POST', body: { position: page.position + 1 } });
            await openBook(ui.detail.book.id);
          }) }, '+'),
          h('button.node-btn', { title: 'Delete page', 'aria-label': 'Delete page', onclick: guard(async () => {
            if (!confirm(`Delete page ${page.position}?`)) return;
            await api(`/api/pages/${page.id}`, { method: 'DELETE' });
            await openBook(ui.detail.book.id);
          }) }, '✕'))),
      h('div.page-body', {},
        media,
        h('div.page-words', {},
          h('span.field-label', {}, 'TEXT'), textArea,
          h('span.field-label', {}, 'ILLUSTRATION BRIEF'), briefArea,
          h('div.row-actions', {}, revise, history))));
    ui.cards.set(page.id, { media, page });
    renderMedia(page);
    return card;
  }));
}

function renderMedia(page) {
  const entry = ui.cards.get(page.id);
  if (!entry) return;
  entry.page = page;
  const pending = page.illustrations.find((i) => ['queued', 'running'].includes(i.status));
  const failed = !pending && page.illustrations[0]?.status === 'failed' ? page.illustrations[0] : null;
  const candidates = page.illustrations.filter((i) => i.status === 'completed');
  entry.media.replaceChildren(...[
    page.assetPath ? h('img.page-image', { src: page.assetPath, alt: `Illustration for page ${page.position}` }) : h('div.node-placeholder', {}, pending ? 'Illustrating…' : 'No illustration yet'),
    pending && page.assetPath ? h('small.muted', {}, 'New version in progress…') : null,
    failed ? h('small.error-text', {}, failed.userError || 'Illustration failed.') : null,
    candidates.length > 1 ? h('div.candidate-strip', {}, ...candidates.map((c) => h(`button.candidate${c.assetId === page.assetId ? '.chosen' : ''}`, {
      title: 'Use this version', onclick: guard(async () => {
        await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { assetId: c.assetId } });
        await refreshPages();
      }) }, h('img', { src: c.assetPath, alt: 'Version' })))) : null,
    h('button.button.secondary.small', { disabled: Boolean(pending), onclick: guard(() => illustrate(page)) }, page.assetPath ? 'New version' : 'Illustrate'),
  ].filter(Boolean));
}

function showHistory(page, revisions, restore) {
  const overlay = h('div.modal-backdrop', { onclick: (event) => event.target === overlay && overlay.remove() },
    h('div.modal', { role: 'dialog', 'aria-label': 'Page history' },
      h('div.modal-head', {}, h('b', {}, `Page ${page.position} history`), h('button.ghost', { onclick: () => overlay.remove(), 'aria-label': 'Close' }, '✕')),
      ...(revisions.length ? revisions.map((rev) => h('div.revision', {},
        h('small.muted', {}, `${new Date(rev.createdAt).toLocaleString()} · ${rev.source}`),
        h('p', {}, rev.text),
        h('button.text-button', { onclick: guard(async () => { await restore(rev); overlay.remove(); toast('Restored.'); }) }, 'Restore this version'))) : [h('p.muted', {}, 'No history yet.')])));
  document.body.append(overlay);
}

// Poll only the illustration state so text being typed is never overwritten.
async function refreshPages() {
  if (!ui.detail) return;
  const fresh = await api(`/api/books/${ui.detail.book.id}`);
  if (fresh.pages.length !== ui.detail.pages.length) {
    ui.detail = fresh;
    renderPages();
  } else {
    fresh.pages.forEach((page, index) => {
      const current = ui.detail.pages[index];
      Object.assign(current, { assetId: page.assetId, assetPath: page.assetPath, illustrations: page.illustrations });
      renderMedia(current);
    });
  }
  maybePoll();
}

function maybePoll() {
  stopPolling();
  const active = ui.detail?.pages.some((p) => p.illustrations.some((i) => ['queued', 'running'].includes(i.status)));
  if (active) ui.poll = setTimeout(guard(refreshPages), 1500);
}

function stopPolling() {
  clearTimeout(ui.poll);
  ui.poll = null;
}

async function refreshProjectAssets() {
  state.detail = await api(`/api/projects/${state.project.id}`);
}

export function initBooks() {
  $('#book-select').addEventListener('change', guard(() => openBook($('#book-select').value)));
  $('#book-new').addEventListener('click', guard(async () => {
    ui.options ??= await api('/api/book-options');
    ui.detail = null;
    $('#book-select').value = '';
    renderNewBookForm();
  }));
  $('#book-delete').addEventListener('click', guard(async () => {
    if (!ui.detail || !confirm(`Delete "${ui.detail.book.title}"? Its illustrations stay in the library.`)) return;
    await api(`/api/books/${ui.detail.book.id}`, { method: 'DELETE' });
    ui.detail = null;
    await loadBooks();
  }));
  on('tab', guard(async (tab) => {
    if (tab === 'books') await loadBooks();
    else stopPolling();
  }));
  on('project', guard(async (detail) => {
    const switched = ui.projectId !== detail.project.id;
    ui.projectId = detail.project.id;
    if (!switched) return;
    ui.detail = null;
    stopPolling();
    if (!$('#books-view').classList.contains('hidden')) await loadBooks();
  }));
}
