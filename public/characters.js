import { $, api, emit, h, modelsFor, on, pickAsset, state, toast, askText } from './lib.js';

// Characters, products and locations: defined once (name, look, up to 6 reference photos, a voice), attached to
// generations and storyboard shots by id. Locking one freezes its look so a film can't drift by accident.
const local = { selected: new Set(), context: { mode: 'image', model: null } };
const kinds = { character: 'Person or creature', product: 'Product or object', location: 'Location or set' };
const maxPhotos = 6;

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message, 'error'); }
};

export const selectedCharacters = () => [...local.selected].filter((id) => state.characters?.some((c) => c.id === id));

export async function loadCharacters() {
  state.characters = (await api('/api/characters')).characters;
  for (const id of local.selected) if (!state.characters.some((c) => c.id === id)) local.selected.delete(id);
  emit('characters', state.characters);
}

// The row under the prompt on Create: one toggle chip per character.
export function renderCharacterRow(context = local.context) {
  local.context = context;
  const row = $('#character-row');
  const { mode, model } = context;
  row.classList.toggle('hidden', mode === 'speech');
  if (mode === 'speech') return;
  const list = state.characters ?? [];
  const chosen = list.filter((c) => local.selected.has(c.id));
  const photosUnused = chosen.some((c) => c.references.length) && (mode === 'video' || !model?.operations.includes('edit'));
  row.replaceChildren(...[
    h('span.field-label', {}, 'CHARACTERS'),
    ...list.map((c) => h(`button.character-chip${local.selected.has(c.id) ? '.selected' : ''}`, {
      'aria-pressed': String(local.selected.has(c.id)), title: c.description || 'No description yet',
      onclick: () => {
        if (local.selected.has(c.id)) local.selected.delete(c.id);
        else if (local.selected.size >= 8) return toast('Use at most 8 characters and locations at once.');
        else local.selected.add(c.id);
        emit('characters-selected');
        return undefined;
      },
    }, c.references[0] ? h('img', { src: c.references[0].path, alt: '' }) : null, c.name)),
    h('button.text-button', { onclick: () => emit('open-tab', 'characters') }, list.length ? 'Manage →' : '＋ Add a character to keep someone looking the same →'),
    photosUnused ? h('small.muted.character-note', {}, mode === 'video' ? 'Video uses the description only; a video\'s input image is its first frame.' : 'This model can\'t take reference photos, so only the description is sent. Pick a model that edits images to use the photos.') : null,
  ].filter(Boolean));
}

function card(character) {
  const save = guard(async (fields) => {
    await api(`/api/characters/${character.id}`, { method: 'PATCH', body: fields });
    await loadCharacters();
  });
  const locked = Boolean(character.locked);
  const name = h('input', { type: 'text', value: character.name, maxLength: 80, disabled: locked, 'aria-label': 'Name', onchange: () => name.value.trim() && save({ name: name.value }) });
  const kind = h('select', { 'aria-label': 'Kind', disabled: locked, onchange: () => save({ kind: kind.value }) }, ...Object.entries(kinds).map(([value, label]) => h('option', { value }, label)));
  kind.value = character.kind;
  const placeholders = {
    product: 'What must stay the same: shape, materials, colours, label, proportions…',
    location: 'What must stay the same: layout, architecture, landmarks, props, time of day, light…',
    character: 'What must stay the same: face, hair, build, age, clothing, colours…',
  };
  const description = h('textarea', {
    rows: 4, maxLength: 2500, value: character.description, disabled: locked, 'aria-label': 'Look', placeholder: placeholders[character.kind] ?? placeholders.character,
    onchange: () => save({ description: description.value }),
  });
  const designTags = h('input', {
    type: 'text', value: character.designTags ?? '', maxLength: 400, disabled: locked, 'aria-label': 'Design tags (anime)',
    placeholder: '1girl, silver hair, long hair, red eyes, black coat, red lining', onchange: () => save({ designTags: designTags.value }),
  });
  // Character sheet: queue one generation, poll it, and the server adds the result as the first reference photo.
  const sheetButtons = [];
  const makeSheet = (expressions) => guard(async () => {
    const projectId = state.project?.id;
    if (!projectId) throw new Error('Open a project first.');
    // The anime model on this computer is the server's default; otherwise use the first ready text-to-image model.
    const options = modelsFor('generate').filter(({ provider }) => provider.ready);
    const anime = options.find(({ provider, model }) => provider.id === 'local' && model.id === 'animagine-xl-4');
    const choice = anime ? {} : { provider: options[0]?.provider.id, model: options[0]?.model.id };
    if (!anime && !choice.provider) throw new Error('Add an image provider key (or install the local anime model) first.');
    sheetButtons.forEach((b) => { b.disabled = true; });
    try {
      const { generation } = await api(`/api/characters/${character.id}/sheet`, { method: 'POST', body: { projectId, expressions, ...choice } });
      toast(expressions ? 'Making the expression sheet…' : 'Making the character sheet…');
      let current = generation;
      while (['queued', 'running'].includes(current.status)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        current = (await api(`/api/generations/${generation.id}`)).generation;
      }
      if (current.status !== 'completed') throw new Error(current.userError || 'The sheet could not be made.');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await loadCharacters();
      toast('Sheet added to the references.');
    } finally {
      sheetButtons.forEach((b) => { b.disabled = false; });
    }
  })();
  // Bake: a LoRA of this character for the local anime model, trained on this computer (~15-25 minutes).
  // Two phases: the GPU draws training pictures first, then you throw out the bad ones before it learns from them.
  const bakeLabel = h('span.muted', {}, '');
  const bakePanel = h('div.bake-review', { hidden: true });
  let bakeRequest = 0;
  const bakeError = (error) => {
    bakePanel.hidden = false;
    bakePanel.replaceChildren(h('p.error-text', { role: 'status' }, `Bake status unavailable: ${error.message || 'Could not load bake status.'}`),
      h('button.button.secondary.small', { onclick: async () => {
        const request = ++bakeRequest;
        try { const next = await api(bakeUrl); if (request === bakeRequest) showBake(next); }
        catch (nextError) { if (request === bakeRequest) bakeError(nextError); }
      } }, 'Retry status'));
  };
  const bakeButton = h('button.button.secondary.small', { title: 'Teach the local anime model this exact character from its sheet (free, your GPU, about 15-25 minutes; other GPU work waits). It draws pictures first so you can approve them.' }, 'Bake character');
  const bakeUrl = `/api/characters/${character.id}/bake`;
  const bakeCall = async (suffix, body) => {
    const request = ++bakeRequest;
    try {
      const status = await api(`${bakeUrl}${suffix}`, { method: 'POST', body });
      if (request === bakeRequest) showBake(status);
    } catch (error) {
      if (request === bakeRequest) bakeError(error);
      return null;
    }
  };
  const showBake = (status) => {
    const job = status.job;
    const pictures = status.pictures ?? [];
    bakePanel.hidden = !pictures.length;
    bakePanel.replaceChildren();
    if (job?.busy) {
      bakeButton.disabled = true;
      bakeLabel.textContent = `Baking: ${job.stage === 'drawing' ? 'drawing pictures' : 'training'} ${job.total ? `${job.done}/${job.total}` : '…'}`;
      setTimeout(async () => {
        const request = ++bakeRequest;
        try {
          const next = await api(bakeUrl);
          if (request === bakeRequest) showBake(next);
        } catch (error) { if (request === bakeRequest) bakeError(error); }
      }, 4000);
    } else {
      bakeButton.disabled = locked || job?.state === 'review';
      bakeButton.textContent = status.baked ? 'Re-bake character' : 'Bake character';
      bakeLabel.textContent = job?.state === 'failed' ? `Baking failed: ${job.error}` : job?.state === 'review' ? 'Check the pictures below, then train.'
        : status.baked ? `Baked ✓ (${new Date(status.baked.bakedAt).toLocaleDateString()})` : '';
    }
    if (!pictures.length) return;
    const idle = !job?.busy;
    const review = status.review;
    const rejected = pictures.filter((p) => p.approved === false);
    const approved = pictures.filter((p) => p.approved === true);
    const mark = (p, ok) => bakeCall('/review', ok ? { approved: [p.index] } : { rejected: [p.index] });
    bakePanel.append(
      h('p.muted', {}, 'These pictures are what the character is taught from. Approve the ones that look right (✓), reject wrong hair or eyes, extra limbs or a different outfit (✗). “Flip” also trains the mirrored picture: turn it off for asymmetric costumes.'),
      h('div.bake-grid', {}, ...pictures.map((p) => h(`figure.bake-picture${p.approved === true ? '.approved' : p.approved === false ? '.rejected' : ''}`, {},
        h('img', { src: p.url, alt: `Training picture ${p.index + 1}: ${p.framing}`, loading: 'lazy' }),
        h('figcaption', {}, h('small.muted', {}, p.framing),
          h('div.key-row', {},
            h('button.button.small', { disabled: !idle, 'aria-pressed': String(p.approved === true), title: 'Approve', onclick: guard(() => mark(p, true)) }, '✓'),
            h('button.button.small', { disabled: !idle, 'aria-pressed': String(p.approved === false), title: 'Reject', onclick: guard(() => mark(p, false)) }, '✗'),
            h('label.muted', { title: 'Also train the mirrored copy of this picture' },
              h('input', { type: 'checkbox', checked: p.mirror, disabled: !idle, onchange: guard((event) => bakeCall('/review', { mirror: { [p.index]: event.target.checked } })) }), ' Flip')))))),
      h('div.key-row', {},
        h('label.muted', {}, h('input', { type: 'checkbox', checked: review?.mirrorOk !== false, disabled: !idle,
          onchange: guard((event) => bakeCall('/review', { mirrorOk: event.target.checked })) }), ' Symmetric design (train flipped copies)'),
        h('button.button.secondary.small', { disabled: !idle, onclick: guard(() => bakeCall('/review', { approved: pictures.map((p) => p.index) })) }, 'Approve all'),
        h('button.button.secondary.small', { disabled: !idle || !rejected.length, onclick: guard(() => bakeCall('/redraw', {})) }, `Redraw rejected (${rejected.length})`),
        h('button.button.small', { disabled: !idle || approved.length < (review?.minApproved ?? 8), title: `Needs at least ${review?.minApproved ?? 8} approved pictures`,
          onclick: guard(() => bakeCall('/train', {})) }, `Train on approved (${approved.length})`)));
  };
  bakeButton.onclick = guard(async () => {
    if (!character.references.length) throw new Error('Make a character sheet first; baking learns the character from it.');
    if (await bakeCall('', {})) toast('Drawing training pictures on your GPU. You will review them before it trains.');
  });
  if (character.kind === 'character') {
    const request = ++bakeRequest;
    api(bakeUrl).then((status) => { if (request === bakeRequest) showBake(status); })
      .catch((error) => { if (request === bakeRequest) bakeError(error); });
  }
  // A voice for this character's dialogue in storyboards.
  const voices = modelsFor('speech').flatMap(({ provider, model }) => (model.voices?.length ? model.voices : [null])
    .map((voice) => ({ value: JSON.stringify({ provider: provider.id, model: model.id, voice }), label: `${provider.label} · ${model.label}${voice ? ` · ${voice}` : ''}`, ready: provider.ready })));
  const voice = h('select', { 'aria-label': 'Voice', onchange: () => save({ voice: voice.value ? JSON.parse(voice.value) : null }) },
    h('option', { value: '' }, 'No voice'), ...voices.map((o) => h('option', { value: o.value, disabled: !o.ready }, o.label + (o.ready ? '' : ' (add key)'))));
  voice.value = character.voice ? JSON.stringify({ provider: character.voice.provider, model: character.voice.model, voice: character.voice.voice ?? null }) : '';
  const ids = character.references.map((r) => r.id);
  return h(`section.panel.character-card${locked ? '.locked' : ''}`, {},
    h('div.character-refs', {},
      ...character.references.map((ref) => h('div.tray-item', {}, h('img', { src: ref.path, alt: `${character.name} reference` }),
        locked ? null : h('button', { title: 'Remove photo', 'aria-label': 'Remove photo', onclick: () => save({ referenceAssetIds: ids.filter((id) => id !== ref.id) }) }, '✕'))),
      !locked && character.references.length < maxPhotos ? h('button.character-add-photo', { onclick: guard(async () => {
        const asset = await pickAsset({ title: `Reference photo for ${character.name}` });
        if (asset) await save({ referenceAssetIds: [...ids, asset.id] });
      }) }, '+ Photo') : null),
    h('div.character-fields', {},
      h('div.character-head', {}, name, kind),
      h('label', {}, h('span.field-label', {}, 'LOOK (SENT WITH EVERY PROMPT)'), description),
      character.kind === 'character' ? h('label', {}, h('span.field-label', {}, 'DESIGN TAGS (ANIME)'), designTags,
        h('small.muted', {}, 'A fixed tag block (hair, eyes, outfit) reused for every sheet and anime frame so the design stays the same.')) : null,
      character.kind === 'location' ? null : h('label', {}, h('span.field-label', {}, 'VOICE (FOR DIALOGUE)'), voice),
      h('div.key-row', {},
        h('button.button.secondary.small', { onclick: () => { local.selected.add(character.id); emit('characters-selected'); emit('open-tab', 'create'); } }, 'Use in Create'),
        h('button.button.secondary.small', { title: locked ? 'Unlock to change the look on purpose' : 'Freeze the look (name, description, photos) so it cannot change by accident',
          onclick: () => save({ locked: !locked }) }, locked ? '🔒 Locked — unlock' : 'Lock look'),
        character.kind === 'character' ? sheetButtons.push(
          h('button.button.secondary.small', { disabled: locked, title: 'Front, side and back views on one sheet', onclick: () => makeSheet(false) }, 'Make character sheet'),
          h('button.button.secondary.small', { disabled: locked, title: 'Smiling, angry, sad, surprised…', onclick: () => makeSheet(true) }, 'Expression sheet')) && sheetButtons : null,
        character.kind === 'character' ? bakeButton : null, character.kind === 'character' ? bakeLabel : null,
        h('span.muted', {}, `${character.references.length}/${maxPhotos} reference photos`),
        h('button.text-button.danger', { onclick: guard(async () => {
          if (!confirm(`Delete "${character.name}"? Its photos stay in the library.`)) return;
          await api(`/api/characters/${character.id}`, { method: 'DELETE' });
          await loadCharacters();
        }) }, 'Delete')),
      character.kind === 'character' ? bakePanel : null));
}

function renderView() {
  const list = state.characters ?? [];
  $('#character-grid').replaceChildren(...(list.length ? list.map(card) : [h('div.history-empty.muted', {},
    'Nothing here yet. Create a character, product or location, describe what must stay the same, and add up to six clear photos (front, side, three-quarter, back, close-up, full body). Models that take reference images use the photos; others use the description.')]));
}

export function initCharacters() {
  $('#character-new').addEventListener('click', guard(async () => {
    const name = await askText('New character, product or location', { label: 'Name', placeholder: 'e.g. Mira, “Blue sneaker”, or “Harbour at night”', okLabel: 'Create' });
    if (!name?.trim()) return;
    await api('/api/characters', { method: 'POST', body: { name } });
    await loadCharacters();
  }));
  on('characters', () => { renderView(); renderCharacterRow(); });
  on('characters-selected', () => renderCharacterRow());
  on('catalog', () => renderView());
  on('tab', (tab) => { if (tab === 'characters') loadCharacters().catch((error) => toast(error.message, 'error')); });
  // Deleting a photo or a project can remove a character's references.
  on('assets-changed', () => loadCharacters().catch(() => {}));
  loadCharacters().catch(() => {});
}
