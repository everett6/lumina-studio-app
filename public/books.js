import { $, api, downloadAsset, h, modelsFor, on, pickAsset, state, toast, askText } from './lib.js';

const ui = { books: [], detail: null, options: null, timers: new Map(), poll: null, cards: new Map() };
const active = (jobs = []) => jobs.some((j) => ['queued', 'running'].includes(j.status));
const lastError = (jobs = []) => (jobs[0]?.status === 'failed' ? jobs[0].userError || 'Failed.' : null);

const guard = (fn) => async (...args) => {
  try { return await fn(...args); } catch (error) { toast(error.message, 'error'); return undefined; }
};

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

const isPicture = () => ui.detail?.book.kind === 'picture_book';

// ---------- selects ----------

function writerSelect(selected) {
  const select = h('select', { 'aria-label': 'Writer model' },
    ...(state.catalog?.directors ?? []).flatMap((d) => d.models.map((m) => h('option', { value: `${d.id}:${m}`, disabled: !d.ready }, `${d.label} · ${m}${d.ready ? '' : ' (add key)'}`))));
  const firstReady = [...select.options].find((o) => !o.disabled)?.value ?? '';
  select.value = [...select.options].some((o) => o.value === selected && !o.disabled) ? selected : firstReady;
  return select;
}

function modelSelect(operation, storageKey) {
  const select = h('select', { 'aria-label': `${operation} model` },
    ...modelsFor(operation).map(({ provider, model, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${model.label}${provider.ready ? '' : ' (add key)'}`)));
  let saved = null;
  try { saved = localStorage.getItem(storageKey); } catch { /* ignore */ }
  const ready = [...select.options].filter((o) => !o.disabled).map((o) => o.value);
  select.value = ready.includes(saved) ? saved : ready[0] ?? '';
  select.addEventListener('change', () => { try { localStorage.setItem(storageKey, select.value); } catch { /* ignore */ } });
  return select;
}
const choice = (select) => {
  const [provider, model] = (select?.value ?? '').split('|');
  if (!provider) throw new Error('Add a key for a provider that offers this in Settings.');
  return { provider, model };
};

// ---------- list / new book ----------

async function loadBooks(selectId) {
  if (!state.project) return;
  ui.options ??= await api('/api/book-options');
  ui.books = (await api(`/api/projects/${state.project.id}/books`)).books;
  const select = $('#book-select');
  select.replaceChildren(...ui.books.map((b) => h('option', { value: b.id }, `${b.title} · ${ui.options.bookKinds[b.kind]?.label ?? b.kind}`)));
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

function briefFields(kind) {
  const size = kind === 'picture_book'
    ? [['pageCount', 'Pages', 'number', 1, 48]]
    : [['chapterCount', 'Chapters', 'number', 1, 60], ['wordsPerChapter', 'Words per chapter', 'number', 200, 8000]];
  return [
    ['title', 'Title', 'input'], ['author', 'Author', 'input'],
    ['premise', kind === 'nonfiction' ? 'What the book argues or teaches' : 'Premise — what happens and why it matters', 'textarea'],
    ['audience', 'Audience', 'input'], ['language', 'Language', 'input'], ['genre', 'Genre', 'input'], ['tone', 'Tone', 'input'],
    ...size, ['trimSize', 'Trim size', 'trim'],
    ...(kind === 'picture_book' ? [['layout', 'Page layout', 'layout']] : []),
    ['bleed', 'Print bleed (0.125 in)', 'checkbox'],
    ['illustrationStyle', 'Illustration / cover style', 'textarea'],
  ];
}

function field([key, label, kind, min, max], value, inputs, onInput) {
  let input;
  if (kind === 'textarea') input = h('textarea', { rows: 3, value: value ?? '' });
  else if (kind === 'number') input = h('input', { type: 'number', min, max, value: value ?? min });
  else if (kind === 'checkbox') input = h('input', { type: 'checkbox', checked: Boolean(value) });
  else if (kind === 'trim') {
    input = h('select', {}, ...Object.entries(ui.options.trimSizes).map(([id, t]) => h('option', { value: id }, t.label)));
    input.value = value;
  } else if (kind === 'layout') {
    input = h('select', {}, h('option', { value: 'art-top' }, 'Art above text'), h('option', { value: 'full-bleed' }, 'Full-page art, text panel'));
    input.value = value;
  } else input = h('input', { type: 'text', value: value ?? '', required: key === 'title' });
  inputs[key] = input;
  if (onInput) input.addEventListener(['trim', 'layout', 'checkbox'].includes(kind) ? 'change' : 'input', onInput);
  if (kind === 'checkbox') return h('label.check', {}, input, h('span', {}, label));
  return h(`label${kind === 'textarea' ? '.wide' : ''}`, {}, h('span.field-label', {}, label.toUpperCase()), input);
}

const readInputs = (inputs) => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value]));

function renderNewBookForm() {
  stopPolling();
  let kind = 'picture_book';
  const container = h('div');
  const draw = () => {
    const inputs = {};
    const writer = writerSelect('');
    const brief = ui.options.briefs[kind];
    container.replaceChildren(h('form.panel.new-book', { onsubmit: guard(async (event) => {
      event.preventDefault();
      const { title, ...values } = readInputs(inputs);
      const { book } = await api(`/api/projects/${state.project.id}/books`, { method: 'POST', body: { title, kind, writer: writer.value, brief: values } });
      await loadBooks(book.id);
    }) },
    h('h2', {}, 'Start a book'),
    h('div.segmented', { role: 'tablist' }, ...Object.entries(ui.options.bookKinds).map(([id, k]) => h(`button${id === kind ? '.selected' : ''}`, { type: 'button', onclick: () => { kind = id; draw(); } }, k.label))),
    h('p.muted', {}, kind === 'picture_book'
      ? 'Brief → story bible → page plan → consistent illustrations → PDF, EPUB, Word, narration.'
      : kind === 'novel'
        ? 'Brief → story bible → chapter outline with scenes → draft and revise chapters → cover → PDF, EPUB, Word, audiobook.'
        : 'Brief → book plan (thesis, key concepts) → chapter outline with sections → draft and revise → PDF, EPUB, Word, audiobook.'),
    h('div.brief-grid', {}, ...briefFields(kind).map((f) => field(f, f[0] === 'title' ? '' : brief[f[0]], inputs))),
    h('label', {}, h('span.field-label', {}, 'WRITER MODEL'), writer),
    h('button.button.primary', { type: 'submit' }, 'Create book')));
  };
  draw();
  $('#book-editor').replaceChildren(container);
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
  if (option) option.textContent = `${book.title} · ${ui.options.bookKinds[book.kind]?.label}`;
  const inputs = {};
  const narration = { ...book.brief.narration };
  const saveBrief = () => later('brief', async () => {
    const { title, ...values } = readInputs(inputs);
    ui.detail.book = { ...ui.detail.book, ...(await api(`/api/books/${book.id}`, { method: 'PATCH', body: { title, brief: { ...values, narration } } })).book };
  });
  const writer = writerSelect(book.writer);
  writer.addEventListener('change', guard(async () => { await api(`/api/books/${book.id}`, { method: 'PATCH', body: { writer: writer.value } }); ui.detail.book.writer = writer.value; }));
  ui.writer = writer;

  const summary = isPicture() ? `${ui.detail.pages.length}/${book.brief.pageCount} pages` : `${ui.detail.chapters.length} chapters · ${ui.detail.totalWords.toLocaleString()} words`;
  const briefPanel = h('details.panel.book-section', { open: isPicture() ? !ui.detail.pages.length : !ui.detail.chapters.length },
    h('summary', {}, h('b', {}, 'Book brief'), h('span.muted', {}, `${ui.options.bookKinds[book.kind].label} · ${summary}`)),
    h('div.brief-grid', {}, ...briefFields(book.kind).map((f) => field(f, f[0] === 'title' ? book.title : book.brief[f[0]], inputs, saveBrief))),
    h('label', {}, h('span.field-label', {}, 'CUSTOM FONT FILE (OPTIONAL, FOR PDF)'),
      (inputs.fontFile = h('input', { type: 'text', value: book.brief.fontFile ?? '', placeholder: '/usr/share/fonts/…/MyFont.ttf', oninput: saveBrief }))),
    h('p.muted.small-print', {}, 'Non-Latin scripts use installed system fonts automatically; set a file to force one typeface.'),
    h('label', {}, h('span.field-label', {}, 'WRITER MODEL'), writer),
    narrationSettings(narration, saveBrief));

  $('#book-editor').replaceChildren(h('div.book-layout', {},
    h('div.book-side', {}, briefPanel, coverPanel(), renderBible()),
    h('div.book-main', {}, renderToolbar(), h('div.page-list', { id: 'unit-list' }))));
  renderUnits();
}

function narrationSettings(narration, save) {
  const models = modelsFor('speech');
  const voice = h('select', { 'aria-label': 'Voice' });
  const model = h('select', { 'aria-label': 'Narration model' }, h('option', { value: '' }, 'Choose a voice model…'),
    ...models.map(({ provider, model: m, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${m.label}${provider.ready ? '' : ' (add key)'}`)));
  model.value = narration.provider ? `${narration.provider}|${narration.model}` : '';
  const fillVoices = () => {
    const found = models.find((m) => m.value === model.value);
    voice.replaceChildren(...(found?.model.voices ?? []).map((v) => h('option', { value: v }, v)));
    if (found?.model.voices?.includes(narration.voice)) voice.value = narration.voice;
    narration.voice = voice.value;
  };
  fillVoices();
  model.addEventListener('change', () => {
    [narration.provider, narration.model] = model.value ? model.value.split('|') : ['', ''];
    fillVoices();
    save();
  });
  voice.addEventListener('change', () => { narration.voice = voice.value; save(); });
  const style = h('input', { type: 'text', value: narration.style ?? '', placeholder: 'e.g. warm storyteller, measured pace', oninput: (e) => { narration.style = e.target.value; save(); } });
  return h('div.narration-settings', {}, h('span.field-label', {}, 'NARRATION'), model, voice, style);
}

function coverPanel() {
  const { book } = ui.detail;
  const select = modelSelect('generate', 'lumina-book-illustrator');
  const pending = active(book.coverJobs);
  const make = h('button.button.secondary.small', { disabled: pending }, pending ? 'Generating…' : book.coverPath ? 'New cover' : 'Generate cover');
  make.addEventListener('click', guard(async () => {
    if (!confirm('Generate a cover image? This uses your image provider credits.')) return;
    await api(`/api/books/${book.id}/cover`, { method: 'POST', body: choice(select) });
    await refresh();
  }));
  const choose = h('button.button.secondary.small', { onclick: guard(async () => {
    const asset = await pickAsset({ title: 'Choose a cover image' });
    if (!asset) return;
    await api(`/api/books/${book.id}`, { method: 'PATCH', body: { coverAssetId: asset.id } });
    await openBook(book.id);
  }) }, 'Use an image…');
  return h('details.panel.book-section', { open: false },
    h('summary', {}, h('b', {}, 'Cover'), h('span.muted', {}, book.coverPath ? 'set' : 'none')),
    book.coverPath ? h('img.cover-image', { src: book.coverPath, alt: 'Cover' }) : h('div.node-placeholder', {}, pending ? 'Generating…' : 'No cover yet'),
    lastError(book.coverJobs) ? h('small.error-text', {}, lastError(book.coverJobs)) : null,
    h('p.muted.small-print', {}, 'The title is set as text over the art in PDF; EPUB and Word use the art as the cover image.'),
    select, h('div.row-actions', {}, make, choose));
}

function renderBible() {
  const { book } = ui.detail;
  const bible = structuredClone(book.bible ?? {});
  bible.characters ??= [];
  bible.styleReferenceAssetIds ??= [];
  const save = () => later('bible', async () => { ui.detail.book.bible = (await api(`/api/books/${book.id}`, { method: 'PATCH', body: { bible } })).book.bible; });
  const assetPath = (id) => state.detail?.assets.find((a) => a.id === id)?.path;
  const nonfiction = book.kind === 'nonfiction';

  const refStrip = (ids, onChange) => h('div.ref-strip', {},
    ...ids.map((id) => h('div.tray-item', {}, assetPath(id) ? h('img', { src: assetPath(id), alt: 'Reference' }) : h('span.muted', {}, '?'),
      h('button', { 'aria-label': 'Remove reference', onclick: () => { ids.splice(ids.indexOf(id), 1); onChange(); } }, '✕'))),
    ids.length < 4 ? h('button.button.secondary.small', { type: 'button', onclick: guard(async () => {
      const asset = await pickAsset({ title: 'Choose a reference image' });
      if (!asset || ids.includes(asset.id)) return;
      ids.push(asset.id);
      state.detail = await api(`/api/projects/${state.project.id}`);
      onChange();
    }) }, '+ Reference') : null);

  const container = h('div');
  const draw = () => {
    container.replaceChildren(
      ...bible.characters.map((c, index) => h('div.character-card', {},
        h('div.key-head', {}, h('input', { type: 'text', value: c.name, placeholder: 'Name', 'aria-label': 'Name', oninput: (e) => { c.name = e.target.value; save(); } }),
          h('button.node-btn', { type: 'button', title: 'Remove', 'aria-label': 'Remove entry', onclick: () => { bible.characters.splice(index, 1); save(); draw(); } }, '✕')),
        h('textarea', { rows: 2, value: c.description, placeholder: nonfiction ? 'Why it matters' : 'Personality, goals, arc', oninput: (e) => { c.description = e.target.value; save(); } }),
        h('textarea', { rows: 2, value: c.visual, placeholder: 'Fixed look for illustrations (optional)', oninput: (e) => { c.visual = e.target.value; save(); } }),
        refStrip(c.referenceAssetIds ??= [], () => { save(); draw(); }))),
      h('button.button.secondary.small', { type: 'button', onclick: () => { bible.characters.push({ name: '', description: '', visual: '', referenceAssetIds: [] }); draw(); } }, nonfiction ? '+ Entry' : '+ Character'),
      ...[
        ['setting', nonfiction ? 'Scope' : 'Setting / world'], ['voice', 'Narrative voice'],
        ['notes', nonfiction ? 'Thesis and key arguments' : 'Themes and continuity notes'], ['styleNotes', 'Visual style guide'],
      ].map(([key, label]) => h('label', {}, h('span.field-label', {}, label.toUpperCase()),
        h('textarea', { rows: key === 'notes' ? 4 : 3, value: bible[key] ?? '', oninput: (e) => { bible[key] = e.target.value; save(); } }))),
      h('span.field-label', {}, 'STYLE REFERENCE IMAGES'),
      refStrip(bible.styleReferenceAssetIds, () => { save(); draw(); }));
  };
  draw();

  const draftButton = h('button.button.secondary.small', { type: 'button' }, bible.characters.length ? 'Redraft with AI' : 'Draft with AI');
  draftButton.addEventListener('click', guard(() => busy(draftButton, 'Writing…', async () => {
    if (bible.characters.length && !confirm('Replace the current notes with a new AI draft? Reference images are kept for matching names.')) return;
    ui.detail.book = { ...ui.detail.book, ...(await api(`/api/books/${book.id}/bible`, { method: 'POST', body: { writer: ui.writer.value } })).book };
    renderEditor();
    toast('Drafted. Edit anything before continuing.');
  })));

  return h('details.panel.book-section', { open: true },
    h('summary', {}, h('b', {}, nonfiction ? 'Book plan' : 'Story bible'), h('span.muted', {}, `${bible.characters.length} entr${bible.characters.length === 1 ? 'y' : 'ies'}`)),
    h('p.muted.small-print', {}, 'Canon used for every page, chapter and illustration.'),
    draftButton, container);
}

function renderToolbar() {
  const { book } = ui.detail;
  const picture = isPicture();
  const illustrator = modelSelect('generate', 'lumina-book-illustrator');
  const animator = modelSelect('video', 'lumina-book-animator');
  ui.illustrator = illustrator;
  ui.animator = animator;
  const count = picture ? ui.detail.pages.length : ui.detail.chapters.length;
  const plan = h('button.button.primary.small', {}, picture ? (count ? 'Replan pages' : 'Plan pages with AI') : (count ? 'Re-outline' : 'Outline with AI'));
  plan.addEventListener('click', guard(() => busy(plan, 'Writing…', async () => {
    if (count && !confirm(`Replace all ${count} ${picture ? 'pages' : 'chapters'} with a new AI ${picture ? 'plan' : 'outline'}? Existing text is removed.`)) return;
    if (!book.bible?.characters?.length && !confirm('The story bible is empty. Continue anyway?')) return;
    ui.detail = await api(`/api/books/${book.id}/${picture ? 'plan' : 'outline'}`, { method: 'POST', body: { writer: ui.writer.value, replace: count > 0 } });
    renderEditor();
    toast(picture ? `Planned ${ui.detail.pages.length} pages.` : `Outlined ${ui.detail.chapters.length} chapters.`);
  })));
  const add = h('button.button.secondary.small', { onclick: guard(async () => {
    await api(`/api/books/${book.id}/${picture ? 'pages' : 'chapters'}`, { method: 'POST', body: {} });
    await openBook(book.id);
  }) }, picture ? '+ Page' : '+ Chapter');

  const bulk = [];
  if (picture) {
    bulk.push(h('button.button.secondary.small', { onclick: guard(async () => {
      const missing = ui.detail.pages.filter((p) => !p.assetId && !active(p.illustrations));
      if (!missing.length) return toast('Every page already has an illustration.');
      choice(illustrator);
      if (!confirm(`Generate ${missing.length} illustration(s) with ${illustrator.selectedOptions[0].textContent}? This uses your provider credits.`)) return;
      for (const page of missing) await api(`/api/pages/${page.id}/illustrate`, { method: 'POST', body: choice(illustrator) });
      await refresh();
    }) }, 'Illustrate missing'));
  } else {
    bulk.push(h('button.button.secondary.small', { onclick: guard(async (event) => {
      const empty = ui.detail.chapters.filter((c) => !c.text.trim());
      if (!empty.length) return toast('Every chapter has text.');
      if (!confirm(`Draft ${empty.length} empty chapter(s) one after another? Each takes a minute or more and uses your writer credits.`)) return;
      await busy(event.target, 'Drafting…', async () => {
        for (const [index, c] of empty.entries()) {
          event.target.textContent = `Drafting ${index + 1}/${empty.length}…`;
          await api(`/api/chapters/${c.id}/draft`, { method: 'POST', body: { writer: ui.writer.value } });
        }
      });
      await openBook(book.id);
    }) }, 'Draft empty chapters'));
  }
  bulk.push(h('button.button.secondary.small', { onclick: guard(async () => {
    const items = picture ? ui.detail.pages : ui.detail.chapters;
    const missing = items.filter((i) => (picture ? i.text : i.text).trim() && !i.narrationAssetId && !active(i.narrationJobs));
    if (!missing.length) return toast('Nothing left to narrate.');
    if (!book.brief.narration?.provider) return toast('Choose a narration voice in the brief first.', 'error');
    if (!confirm(`Narrate ${missing.length} ${picture ? 'page' : 'chapter'}(s)? This uses your voice provider credits.`)) return;
    for (const item of missing) await api(`/api/${picture ? 'pages' : 'chapters'}/${item.id}/narrate`, { method: 'POST', body: {} });
    await refresh();
  }) }, 'Narrate all'));

  const exports = h('div.export-group', {}, h('span.field-label', {}, 'EXPORT'),
    ...[['pdf', 'PDF'], ['epub', isPicture() ? 'EPUB (reflowable)' : 'EPUB'], ...(isPicture() ? [['epub-fixed', 'EPUB (fixed layout)']] : []), ['docx', 'Word'], ['md', 'Text'], ['audio', 'Audiobook']].map(([format, label]) => h('button.button.secondary.small', { onclick: () => exportBook(format) }, label)));

  return h('div.book-toolbar', {}, plan, add, ...bulk, h('span.toolbar-sep'),
    h('label.inline', {}, h('span.field-label', {}, 'ART'), illustrator),
    picture ? h('label.inline', {}, h('span.field-label', {}, 'VIDEO'), animator) : null,
    h('span.toolbar-sep'), exports);
}

// Fetch first so failures and warnings show as messages instead of a broken download.
const exportBook = guard(async (format) => {
  const { book } = ui.detail;
  toast('Preparing export…');
  const response = await fetch(`/api/books/${book.id}/export.${format === 'epub-fixed' ? 'epub?layout=fixed' : format}`);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Export failed.');
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `${book.title}.${format}`);
  const url = URL.createObjectURL(await response.blob());
  downloadAsset(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const notes = [];
  const missingNarration = Number(response.headers.get('x-lumina-missing-narration') ?? 0);
  if (missingNarration) notes.push(`${missingNarration} ${isPicture() ? 'page(s)' : 'chapter(s)'} not narrated yet were skipped.`);
  if (Number(response.headers.get('x-lumina-skipped-webp') ?? 0)) notes.push('WebP images cannot go into PDF and were left out.');
  if (response.headers.get('x-lumina-missing-scripts')) notes.push(`No installed font covers: ${response.headers.get('x-lumina-missing-scripts')}. Set a font file in the brief.`);
  toast(notes.length ? `Exported. ${notes.join(' ')}` : 'Exported.');
});

// ---------- units: pages or chapters ----------

function renderUnits() {
  const list = $('#unit-list');
  ui.cards.clear();
  const items = isPicture() ? ui.detail.pages : ui.detail.chapters;
  if (!items.length) {
    list.replaceChildren(h('div.history-empty.muted', {}, isPicture()
      ? 'No pages yet. Draft the story bible, then “Plan pages with AI” — or add pages by hand.'
      : 'No chapters yet. Draft the notes, then “Outline with AI” — or add chapters by hand.'));
    return;
  }
  list.replaceChildren(...items.map((item) => (isPicture() ? pageCard(item) : chapterCard(item))));
}

function unitActions(kind, item) {
  const path = kind === 'page' ? 'pages' : 'chapters';
  const reload = () => openBook(ui.detail.book.id);
  return h('div.row-actions', {},
    h('button.node-btn', { title: 'Move up', 'aria-label': 'Move up', onclick: guard(async () => { await api(`/api/${path}/${item.id}/move`, { method: 'POST', body: { direction: 'up' } }); await reload(); }) }, '↑'),
    h('button.node-btn', { title: 'Move down', 'aria-label': 'Move down', onclick: guard(async () => { await api(`/api/${path}/${item.id}/move`, { method: 'POST', body: { direction: 'down' } }); await reload(); }) }, '↓'),
    h('button.node-btn', { title: 'Insert after', 'aria-label': 'Insert after', onclick: guard(async () => { await api(`/api/books/${ui.detail.book.id}/${path}`, { method: 'POST', body: { position: item.position + 1 } }); await reload(); }) }, '+'),
    h('button.node-btn', { title: 'Delete', 'aria-label': 'Delete', onclick: guard(async () => {
      if (!confirm(`Delete ${kind} ${item.position}?`)) return;
      await api(`/api/${path}/${item.id}`, { method: 'DELETE' });
      await reload();
    }) }, '✕'));
}

function narrationBlock(kind, item) {
  const pending = active(item.narrationJobs);
  const error = lastError(item.narrationJobs);
  return h('div.media-row', {},
    item.narrationPath ? h('audio', { controls: true, preload: 'none', src: item.narrationPath }) : null,
    error ? h('small.error-text', {}, error) : null,
    h('button.text-button', { disabled: pending, onclick: guard(async () => {
      await api(`/api/${kind === 'page' ? 'pages' : 'chapters'}/${item.id}/narrate`, { method: 'POST', body: {} });
      await refresh();
    }) }, pending ? 'Narrating…' : item.narrationPath ? 'Re-narrate' : 'Narrate'));
}

function historyButton(kind, item, apply) {
  return h('button.text-button', { onclick: guard(async () => {
    const { revisions } = await api(`/api/${kind === 'page' ? 'pages' : 'chapters'}/${item.id}/revisions`);
    showHistory(`${kind === 'page' ? 'Page' : 'Chapter'} ${item.position} history`, revisions, apply);
  }) }, 'History');
}

function pageCard(page) {
  const media = h('div.page-media');
  const save = (fieldName) => (event) => later(`page-${page.id}`, async () => {
    await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { [fieldName]: event.target.value } });
    page[fieldName] = event.target.value;
  });
  const textArea = h('textarea.page-text', { rows: 4, value: page.text, placeholder: 'Words on this page', oninput: save('text') });
  const briefArea = h('textarea', { rows: 3, value: page.illustrationBrief, placeholder: 'What the illustration shows', oninput: save('illustrationBrief') });
  const revise = h('button.text-button', {}, 'Revise with AI…');
  revise.addEventListener('click', guard(async () => {
    const instruction = await askText('Revise this page', { label: 'How should it change?', placeholder: 'e.g. shorter, more rhythm', multiline: true, okLabel: 'Revise' });
    if (!instruction?.trim()) return;
    await busy(revise, 'Revising…', async () => {
      const { page: updated } = await api(`/api/pages/${page.id}/revise`, { method: 'POST', body: { instruction, writer: ui.writer.value } });
      Object.assign(page, updated);
      textArea.value = updated.text;
      briefArea.value = updated.illustrationBrief;
    });
  }));
  const narration = h('div');
  const card = h('article.panel.page-card', {},
    h('div.page-head', {}, h('b', {}, `Page ${page.position}`), unitActions('page', page)),
    h('div.page-body', {}, media,
      h('div.page-words', {},
        h('span.field-label', {}, 'TEXT'), textArea,
        h('span.field-label', {}, 'ILLUSTRATION BRIEF'), briefArea,
        h('div.row-actions', {}, revise, historyButton('page', page, (rev) => {
          textArea.value = rev.text;
          briefArea.value = rev.illustrationBrief;
          return api(`/api/pages/${page.id}`, { method: 'PATCH', body: { text: rev.text, illustrationBrief: rev.illustrationBrief } });
        })),
        narration)));
  ui.cards.set(page.id, { kind: 'page', media, narration, item: page });
  renderPageMedia(page);
  return card;
}

function renderPageMedia(page) {
  const entry = ui.cards.get(page.id);
  if (!entry) return;
  entry.item = page;
  const pending = active(page.illustrations);
  const failed = !pending && page.illustrations[0]?.status === 'failed' ? page.illustrations[0].userError || 'Illustration failed.' : null;
  const candidates = page.illustrations.filter((i) => i.status === 'completed');
  const animating = active(page.videoJobs);
  entry.media.replaceChildren(...[
    page.videoPath ? h('video.page-image', { src: page.videoPath, controls: true, loop: true, muted: true, poster: page.assetPath ?? undefined, preload: 'metadata' })
      : page.assetPath ? h('img.page-image', { src: page.assetPath, alt: `Illustration for page ${page.position}` })
        : h('div.node-placeholder', {}, pending ? 'Illustrating…' : 'No illustration yet'),
    pending && page.assetPath ? h('small.muted', {}, 'New version in progress…') : null,
    failed ? h('small.error-text', {}, failed) : null,
    lastError(page.videoJobs) ? h('small.error-text', {}, lastError(page.videoJobs)) : null,
    candidates.length > 1 ? h('div.candidate-strip', {}, ...candidates.map((c) => h(`button.candidate${c.assetId === page.assetId ? '.chosen' : ''}`, {
      title: 'Use this version', onclick: guard(async () => {
        await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { assetId: c.assetId } });
        await refresh();
      }) }, h('img', { src: c.assetPath, alt: 'Version' })))) : null,
    h('div.row-actions', {},
      h('button.button.secondary.small', { disabled: pending, onclick: guard(async () => {
        const result = await api(`/api/pages/${page.id}/illustrate`, { method: 'POST', body: choice(ui.illustrator) });
        if (result.droppedReferences) toast(`This model can't take reference images, so ${result.droppedReferences} reference(s) were not sent.`);
        await refresh();
      }) }, page.assetPath ? 'New version' : 'Illustrate'),
      page.assetPath ? h('button.button.secondary.small', { disabled: animating, onclick: guard(async () => {
        if (!confirm('Animate this illustration into a short video clip? Video generation is slow and costs more than images.')) return;
        await api(`/api/pages/${page.id}/animate`, { method: 'POST', body: choice(ui.animator) });
        await refresh();
      }) }, animating ? 'Animating…' : page.videoPath ? 'Re-animate' : 'Animate') : null),
  ].filter(Boolean));
  entry.narration.replaceChildren(narrationBlock('page', page));
}

function chapterCard(chapter) {
  const save = (fieldName, transform = (v) => v) => (event) => later(`chapter-${chapter.id}-${fieldName}`, async () => {
    const value = transform(event.target.value);
    const { chapter: updated } = await api(`/api/chapters/${chapter.id}`, { method: 'PATCH', body: { [fieldName]: value } });
    chapter[fieldName] = updated[fieldName];
    count.textContent = `${(updated.text.match(/\S+/g) ?? []).length.toLocaleString()} words`;
  }, fieldName === 'text' ? 1200 : 700);
  const title = h('input.chapter-title', { type: 'text', value: chapter.title, placeholder: 'Chapter title', 'aria-label': 'Chapter title', oninput: save('title') });
  const summaryArea = h('textarea', { rows: 2, value: chapter.summary, placeholder: 'What this chapter does', oninput: save('summary') });
  const beatsArea = h('textarea', { rows: 4, value: chapter.beats.join('\n'), placeholder: ui.detail.book.kind === 'nonfiction' ? 'One section per line' : 'One scene per line', oninput: save('beats', (v) => v.split('\n').map((b) => b.trim()).filter(Boolean)) });
  const textArea = h('textarea.chapter-text', { rows: 16, value: chapter.text, placeholder: 'Chapter text — draft it with AI or write it yourself', oninput: save('text') });
  const count = h('span.muted', {}, `${chapter.words.toLocaleString()} words`);
  const draft = h('button.button.secondary.small', {}, chapter.text ? 'Redraft with AI' : 'Draft with AI');
  draft.addEventListener('click', guard(async () => {
    if (chapter.text.trim() && !confirm('Replace this chapter\'s text with a new AI draft? The current text stays in History.')) return;
    const instructions = chapter.text.trim() ? await askText('Redraft this chapter', { label: 'Anything the new draft should do differently? (optional)', multiline: true, optional: true, okLabel: 'Redraft' }) : '';
    if (instructions === null) return;
    await busy(draft, 'Drafting…', async () => {
      const { chapter: updated } = await api(`/api/chapters/${chapter.id}/draft`, { method: 'POST', body: { writer: ui.writer.value, instructions } });
      Object.assign(chapter, updated);
      textArea.value = updated.text;
      count.textContent = `${(updated.text.match(/\S+/g) ?? []).length.toLocaleString()} words`;
    });
  }));
  const revise = h('button.text-button', {}, 'Revise with AI…');
  revise.addEventListener('click', guard(async () => {
    const instruction = await askText('Revise this chapter', { label: 'How should it change?', placeholder: 'e.g. tighten the opening, more dialogue in scene 2', multiline: true, okLabel: 'Revise' });
    if (!instruction?.trim()) return;
    await busy(revise, 'Revising…', async () => {
      const { chapter: updated } = await api(`/api/chapters/${chapter.id}/revise`, { method: 'POST', body: { instruction, writer: ui.writer.value } });
      Object.assign(chapter, updated);
      textArea.value = updated.text;
    });
  }));
  const art = h('div.chapter-art');
  const narration = h('div');
  const card = h('details.panel.page-card.chapter-card', { open: ui.detail.chapters.length <= 3 },
    h('summary.page-head', {}, h('b', {}, `Chapter ${chapter.position}`), h('span.chapter-summary-title', {}, chapter.title), count, unitActions('chapter', chapter)),
    h('div.chapter-body', {},
      h('div.chapter-plan', {},
        h('span.field-label', {}, 'TITLE'), title,
        h('span.field-label', {}, 'SUMMARY'), summaryArea,
        h('span.field-label', {}, ui.detail.book.kind === 'nonfiction' ? 'SECTIONS' : 'SCENES'), beatsArea,
        art, narration),
      h('div.chapter-writing', {}, h('div.row-actions', {}, draft, revise, historyButton('chapter', chapter, (rev) => {
        textArea.value = rev.text;
        return api(`/api/chapters/${chapter.id}`, { method: 'PATCH', body: { text: rev.text, title: rev.title, summary: rev.summary, beats: rev.beats } });
      })), textArea)));
  ui.cards.set(chapter.id, { kind: 'chapter', art, narration, item: chapter });
  renderChapterMedia(chapter);
  return card;
}

function renderChapterMedia(chapter) {
  const entry = ui.cards.get(chapter.id);
  if (!entry) return;
  entry.item = chapter;
  const pending = active(chapter.artJobs);
  entry.art.replaceChildren(...[
    chapter.assetPath ? h('img.page-image', { src: chapter.assetPath, alt: 'Chapter art' }) : null,
    lastError(chapter.artJobs) ? h('small.error-text', {}, lastError(chapter.artJobs)) : null,
    h('button.text-button', { disabled: pending, onclick: guard(async () => {
      await api(`/api/chapters/${chapter.id}/illustrate`, { method: 'POST', body: choice(ui.illustrator) });
      await refresh();
    }) }, pending ? 'Illustrating…' : chapter.assetPath ? 'New chapter art' : 'Add chapter art'),
  ].filter(Boolean));
  entry.narration.replaceChildren(narrationBlock('chapter', chapter));
}

function showHistory(title, revisions, restore) {
  const overlay = h('div.modal-backdrop', { onclick: (event) => event.target === overlay && overlay.remove() },
    h('div.modal', { role: 'dialog', 'aria-label': title },
      h('div.modal-head', {}, h('b', {}, title), h('button.ghost', { onclick: () => overlay.remove(), 'aria-label': 'Close' }, '✕')),
      ...(revisions.length ? revisions.map((rev) => h('div.revision', {},
        h('small.muted', {}, `${new Date(rev.createdAt).toLocaleString()} · ${rev.source}`),
        h('p', {}, rev.text.length > 1200 ? `${rev.text.slice(0, 1200)}…` : rev.text || '(empty)'),
        h('button.text-button', { onclick: guard(async () => { await restore(rev); overlay.remove(); toast('Restored.'); }) }, 'Restore this version'))) : [h('p.muted', {}, 'No history yet.')])));
  document.body.append(overlay);
}

// ---------- polling media jobs (text being typed is never overwritten) ----------

async function refresh() {
  if (!ui.detail) return;
  const fresh = await api(`/api/books/${ui.detail.book.id}`);
  const picture = isPicture();
  const before = picture ? ui.detail.pages : ui.detail.chapters;
  const after = picture ? fresh.pages : fresh.chapters;
  const coverChanged = fresh.book.coverPath !== ui.detail.book.coverPath || active(fresh.book.coverJobs) !== active(ui.detail.book.coverJobs);
  if (after.length !== before.length || after.some((item, i) => item.id !== before[i].id)) {
    ui.detail = fresh;
    renderEditor();
  } else {
    const mediaKeys = picture ? ['assetId', 'assetPath', 'illustrations', 'narrationAssetId', 'narrationPath', 'narrationJobs', 'videoAssetId', 'videoPath', 'videoJobs']
      : ['assetId', 'assetPath', 'artJobs', 'narrationAssetId', 'narrationPath', 'narrationJobs'];
    after.forEach((item, index) => {
      const current = before[index];
      for (const key of mediaKeys) current[key] = item[key];
      if (picture) renderPageMedia(current); else renderChapterMedia(current);
    });
    Object.assign(ui.detail.book, { coverAssetId: fresh.book.coverAssetId, coverPath: fresh.book.coverPath, coverJobs: fresh.book.coverJobs });
    if (coverChanged) renderEditor();
  }
  maybePoll();
}

function maybePoll() {
  stopPolling();
  const d = ui.detail;
  if (!d) return;
  const jobs = [d.book.coverJobs, ...d.pages.flatMap((p) => [p.illustrations, p.narrationJobs, p.videoJobs]), ...d.chapters.flatMap((c) => [c.artJobs, c.narrationJobs])];
  if (jobs.some(active)) ui.poll = setTimeout(guard(refresh), 1500);
}

function stopPolling() {
  clearTimeout(ui.poll);
  ui.poll = null;
}

export function initBooks() {
  $('#book-select').addEventListener('change', guard(() => openBook($('#book-select').value)));
  $('#book-new').addEventListener('click', guard(async () => {
    ui.options ??= await api('/api/book-options');
    ui.detail = null;
    $('#book-select').value = '';
    renderNewBookForm();
  }));
  $('#book-import').addEventListener('change', guard(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a file under 25 MB.');
    const kind = confirm(`Import "${file.name}" as a novel?\n\nOK = novel · Cancel = nonfiction`) ? 'novel' : 'nonfiction';
    const body = { fileName: file.name, kind };
    if (/\.docx$/i.test(file.name)) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read this file.'));
        reader.readAsDataURL(file);
      });
      body.dataBase64 = String(dataUrl).split(',')[1] ?? '';
    } else {
      body.text = await file.text();
    }
    const writer = (state.catalog?.directors ?? []).find((d) => d.ready);
    if (writer) body.writer = `${writer.id}:${writer.models[0]}`;
    toast('Importing…');
    const detail = await api(`/api/projects/${state.project.id}/books/import`, { method: 'POST', body });
    toast(`Imported ${detail.chapters.length} chapter(s). Revise any chapter, or add one and draft it to continue the book.`);
    await loadBooks(detail.book.id);
  }));
  $('#book-delete').addEventListener('click', guard(async () => {
    if (!ui.detail || !confirm(`Delete "${ui.detail.book.title}"? Its images and audio stay in the library.`)) return;
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
