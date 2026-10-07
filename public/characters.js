import { $, api, emit, h, on, pickAsset, state, toast, askText } from './lib.js';

// Characters: defined once (name, look, up to 4 reference photos), attached to generations by id.
const local = { selected: new Set(), context: { mode: 'image', model: null } };
const kinds = { character: 'Person or creature', product: 'Product or object' };

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
        else if (local.selected.size >= 4) return toast('Use at most 4 characters at once.');
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
  const name = h('input', { type: 'text', value: character.name, maxLength: 80, 'aria-label': 'Name', onchange: () => name.value.trim() && save({ name: name.value }) });
  const kind = h('select', { 'aria-label': 'Kind', onchange: () => save({ kind: kind.value }) }, ...Object.entries(kinds).map(([value, label]) => h('option', { value }, label)));
  kind.value = character.kind;
  const description = h('textarea', {
    rows: 4, maxLength: 1500, value: character.description, 'aria-label': 'Look',
    placeholder: character.kind === 'product' ? 'What must stay the same: shape, materials, colours, label, proportions…' : 'What must stay the same: face, hair, build, age, clothing, colours…',
    onchange: () => save({ description: description.value }),
  });
  const ids = character.references.map((r) => r.id);
  return h('section.panel.character-card', {},
    h('div.character-refs', {},
      ...character.references.map((ref) => h('div.tray-item', {}, h('img', { src: ref.path, alt: `${character.name} reference` }),
        h('button', { title: 'Remove photo', 'aria-label': 'Remove photo', onclick: () => save({ referenceAssetIds: ids.filter((id) => id !== ref.id) }) }, '✕'))),
      character.references.length < 4 ? h('button.character-add-photo', { onclick: guard(async () => {
        const asset = await pickAsset({ title: `Reference photo for ${character.name}` });
        if (asset) await save({ referenceAssetIds: [...ids, asset.id] });
      }) }, '+ Photo') : null),
    h('div.character-fields', {},
      h('div.character-head', {}, name, kind),
      h('label', {}, h('span.field-label', {}, 'LOOK (SENT WITH EVERY PROMPT)'), description),
      h('div.key-row', {},
        h('button.button.secondary.small', { onclick: () => { local.selected.add(character.id); emit('characters-selected'); emit('open-tab', 'create'); } }, 'Use in Create'),
        h('span.muted', {}, `${character.references.length}/4 reference photos`),
        h('button.text-button.danger', { onclick: guard(async () => {
          if (!confirm(`Delete the character "${character.name}"? Its photos stay in the library.`)) return;
          await api(`/api/characters/${character.id}`, { method: 'DELETE' });
          await loadCharacters();
        }) }, 'Delete'))));
}

function renderView() {
  const list = state.characters ?? [];
  $('#character-grid').replaceChildren(...(list.length ? list.map(card) : [h('div.history-empty.muted', {},
    'No characters yet. Create one, describe the look, and add up to four clear photos. Models that edit images (GPT Image, Gemini, FLUX Kontext) use the photos; others use the description.')]));
}

export function initCharacters() {
  $('#character-new').addEventListener('click', guard(async () => {
    const name = await askText('New character or product', { label: 'Name', placeholder: 'e.g. Mira, or “Blue sneaker”', okLabel: 'Create' });
    if (!name?.trim()) return;
    await api('/api/characters', { method: 'POST', body: { name } });
    await loadCharacters();
  }));
  on('characters', () => { renderView(); renderCharacterRow(); });
  on('characters-selected', () => renderCharacterRow());
  on('tab', (tab) => { if (tab === 'characters') loadCharacters().catch((error) => toast(error.message, 'error')); });
  // Deleting a photo or a project can remove a character's references.
  on('assets-changed', () => loadCharacters().catch(() => {}));
  loadCharacters().catch(() => {});
}
