// Structured declarations only: prose and generated pixels always require human review.
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const ids = (value) => [...new Set(list(value).map(text).filter(Boolean))];
const choice = (value, allowed) => allowed.includes(value) ? value : null;
const declaration = (value) => {
  const entry = object(value);
  return Object.fromEntries(['type', 'id', 'who', 'what', 'to', 'reason'].map((key) => [key, text(entry[key])]));
};

/** Normalize one endpoint; unknown scalars stay null rather than inventing continuity. */
export function cleanSceneState(input = {}) {
  const state = object(input);
  return {
    characters: list(state.characters).map((value) => {
      const character = object(value);
      const props = object(character.props);
      return {
        id: text(character.id),
        position: choice(character.position, ['left', 'center', 'right', 'offscreen']),
        facing: choice(character.facing, ['left', 'right', 'camera', 'away']),
        wardrobe: text(character.wardrobe),
        props: { held: ids(props.held), worn: ids(props.worn) },
        injuries: ids(character.injuries), knows: ids(character.knows),
      };
    }),
    location: text(state.location ?? state.locationId),
    timeOfDay: choice(state.timeOfDay, ['dawn', 'day', 'dusk', 'night']),
    events: list(state.events).map(declaration),
    transitions: [...list(state.transitions), ...list(state.exceptions)].map(declaration),
  };
}

const checked = ['character-presence', 'wardrobe-change', 'location-change', 'time-change', 'prop-duplicate', 'prop-lost', 'prop-appears', 'prop-transfer', 'speaker-presence', 'injury-persistence', 'injury-change', 'knowledge-before-use', 'knowledge-change', 'setup-payoff'];
const notCheckable = ['eyelines', 'visual identity and wardrobe accuracy', 'physical plausibility', 'facts implied by dialogue or action prose', 'dramatic quality of setups and payoffs'];

/** Return ordered findings; review-scope findings explicitly describe validation limits. */
export function validateContinuity(shots = [], canon = {}) {
  const findings = [];
  const knowledge = new Map();
  const injuries = new Map();
  const occurrences = new Map();
  const sources = new WeakMap();
  let occurrenceOrder = 0;
  let context;
  const recordOccurrence = (id) => {
    if (!id) return;
    const entries = occurrences.get(id) ?? [];
    entries.push({ shotId: context.id, order: occurrenceOrder++ });
    occurrences.set(id, entries);
  };
  const castKnown = (state) => Array.isArray(sources.get(state)?.characters);
  const fieldKnown = (state, who, field) => {
    const character = list(sources.get(state)?.characters).find((c) => text(c?.id) === who);
    return field === 'props'
      ? Array.isArray(character?.props?.held) && Array.isArray(character?.props?.worn)
      : Array.isArray(character?.[field]);
  };
  const add = (rule, message, evidence = {}, review = false) => {
    findings.push({
      id: `continuity:${context.index}:${rule}:${findings.length + 1}`,
      severity: review ? 'warning' : 'blocking', kind: review ? 'needs-review' : 'deterministic',
      shotId: context.id, previousShotId: context.previousId, rule, message, evidence,
    });
  };
  const explains = (declarations, type, who, what, to) => declarations.some((entry) =>
    entry.type === type && entry.reason && (!who || entry.who === who)
    && (!what || entry.what === what) && (!to || !entry.to || entry.to === to));
  const inspect = (state, raw, phase) => {
    const missing = [];
    const source = object(raw);
    if (!Array.isArray(source.characters)) missing.push('characters');
    if (!state.location) missing.push('location');
    if (!state.timeOfDay) missing.push('timeOfDay');
    const seen = new Set();
    const holders = new Map();
    for (const [index, character] of state.characters.entries()) {
      const original = object(source.characters?.[index]);
      for (const key of ['id', 'position', 'facing', 'wardrobe']) {
        if (!character[key]) missing.push(`characters[${index}].${key}`);
      }
      for (const key of ['injuries', 'knows']) if (!Array.isArray(original[key])) missing.push(`characters[${index}].${key}`);
      for (const key of ['held', 'worn']) if (!Array.isArray(original.props?.[key])) missing.push(`characters[${index}].props.${key}`);
      if (character.id && seen.has(character.id)) add('duplicate-character', 'Character occurs more than once in the state.', { phase, who: character.id });
      seen.add(character.id);
      for (const slot of ['held', 'worn']) for (const prop of character.props[slot]) {
        const holder = { who: character.id, slot };
        if (holders.has(prop)) add('prop-duplicate', 'A unique prop has more than one owner or slot.', { phase, what: prop, holders: [holders.get(prop), holder] });
        else holders.set(prop, holder);
      }
    }
    if (missing.length) add('incomplete-state', 'Incomplete structured state limits the checks that can be made.', { phase, missing }, true);
  };
  const compare = (before, after, declarations, boundary) => {
    const evidence = (extra) => ({ boundary, ...extra });
    const castComparable = castKnown(before) && castKnown(after);
    const prior = new Map((castComparable ? before.characters : []).filter((c) => c.id).map((c) => [c.id, c]));
    const next = new Map((castComparable ? after.characters : []).filter((c) => c.id).map((c) => [c.id, c]));
    for (const who of new Set([...prior.keys(), ...next.keys()])) {
      const old = prior.get(who);
      const now = next.get(who);
      if (!old || !now) {
        const type = old ? 'character-exit' : 'character-enter';
        if (!explains(declarations, type, who)) add('character-presence', 'Character presence changes without a declared entrance or exit.', evidence({ who, before: Boolean(old), after: Boolean(now) }));
        continue;
      }
      if (old.wardrobe && now.wardrobe && old.wardrobe !== now.wardrobe && !explains(declarations, 'wardrobe-change', who, now.wardrobe)) {
        add('wardrobe-change', 'Wardrobe changes without an explicit change.', evidence({ who, before: old.wardrobe, after: now.wardrobe }));
      }
      for (const injury of now.injuries.filter((id) => !old.injuries.includes(id))) {
        if (!fieldKnown(before, who, 'injuries') || !fieldKnown(after, who, 'injuries')) continue;
        if (!explains(declarations, 'injury', who, injury)) add('injury-change', 'A new injury needs a declared cause.', evidence({ who, what: injury }));
      }
      const flip = (a, b) => ['left', 'right'].includes(a) && ['left', 'right'].includes(b) && a !== b;
      if (boundary === 'cut' && (flip(old.position, now.position) || flip(old.facing, now.facing)) && !explains(declarations, 'crossing', who)) {
        add('screen-direction', 'Screen direction flips across the cut; review the axis and crossing.', evidence({ who, before: { position: old.position, facing: old.facing }, after: { position: now.position, facing: now.facing } }), true);
      }
    }
    for (const [key, type, rule] of [['location', 'location-change', 'location-change'], ['timeOfDay', 'time-skip', 'time-change']]) {
      if (before[key] && after[key] && before[key] !== after[key] && !explains(declarations, type, null, after[key])) {
        add(rule, `${key} changes without an explicit transition.`, evidence({ before: before[key], after: after[key] }));
      }
    }
    const owners = (state) => {
      const result = new Map();
      for (const c of state.characters) for (const slot of ['held', 'worn']) for (const prop of c.props[slot]) result.set(prop, c.id);
      return result;
    };
    const oldOwners = owners(before);
    const newOwners = owners(after);
    if (!castComparable || [before, after].some((state) => state.characters.some((c) => !fieldKnown(state, c.id, 'props')))) return;
    for (const what of new Set([...oldOwners.keys(), ...newOwners.keys()])) {
      const from = oldOwners.get(what);
      const to = newOwners.get(what);
      if (from === to) continue;
      const type = from == null ? 'prop-appears' : to == null ? 'prop-lost' : 'prop-transfer';
      if (!explains(declarations, type, from ?? to, what, from && to)) add(type, `Prop ownership changes without a declared ${type}.`, evidence({ what, from: from ?? null, to: to ?? null }));
    }
  };
  const remember = (state, declarations, initial, phase) => {
    for (const c of state.characters.filter((c) => c.id)) {
      const known = knowledge.get(c.id) ?? new Set();
      if (!initial) for (const what of c.knows) {
        if (!known.has(what)) add('knowledge-change', 'Knowledge appears without a prior learn event.', { phase, who: c.id, what });
      }
      if (initial) for (const fact of c.knows) known.add(fact);
      knowledge.set(c.id, known);
      const wounds = injuries.get(c.id) ?? new Set();
      if (!fieldKnown(state, c.id, 'injuries')) continue;
      for (const what of [...wounds]) if (!c.injuries.includes(what)) {
        if (explains(declarations, 'injury-healed', c.id, what)) wounds.delete(what);
        else add('injury-persistence', 'An injury disappears without declared healing.', { phase, who: c.id, what });
      }
      for (const wound of c.injuries) wounds.add(wound);
      injuries.set(c.id, wounds);
    }
  };
  const events = (entries, phase) => {
    for (const [eventIndex, event] of entries.entries()) {
      recordOccurrence(event.id);
      if (event.type === 'learn' && event.who && event.what) {
        const known = knowledge.get(event.who) ?? new Set();
        known.add(event.what);
        knowledge.set(event.who, known);
      }
      if (event.type === 'use' && event.who && event.what && !knowledge.get(event.who)?.has(event.what)) {
        add('knowledge-before-use', 'A fact is used before this character learns it.', { phase, eventIndex, who: event.who, what: event.what });
      }
      if (['learn', 'use'].includes(event.type) && (!event.who || !event.what)) add('incomplete-event', 'Knowledge events require who and what.', { phase, eventIndex }, true);
    }
  };
  let previous;
  for (const [index, value] of list(shots).entries()) {
    const shot = object(value);
    context = { index, id: text(shot.id), previousId: previous?.id ?? null };
    const start = cleanSceneState(shot.start);
    const end = cleanSceneState(shot.end);
    sources.set(start, object(shot.start));
    sources.set(end, object(shot.end));
    const shotTransitions = [...list(shot.transitions), ...list(shot.exceptions)].map(declaration);
    const cutTransitions = [...shotTransitions, ...start.transitions];
    const withinTransitions = [...shotTransitions, ...end.transitions];
    recordOccurrence(context.id);
    inspect(start, shot.start, 'start');
    inspect(end, shot.end, 'end');
    if (previous) compare(previous.end, start, cutTransitions, 'cut');
    // Initial knowledge is a premise. Subsequent gains need an ordered learn event.
    if (index === 0) remember(start, cutTransitions, true, 'start');
    events(start.events, 'start');
    if (index !== 0) remember(start, cutTransitions, false, 'start');
    for (const [lineIndex, line] of list(shot.dialogue ?? shot.details?.dialogue).entries()) {
      if (!line?.text) continue;
      const speaker = text(line.speaker);
      if (!start.characters.some((c) => c.id === speaker) && !end.characters.some((c) => c.id === speaker)
        && line.offscreen !== true && line.voiceOver !== true && line.delivery !== 'voice-over' && line.delivery !== 'offscreen' && speaker !== 'narrator') {
        add('speaker-presence', 'Dialogue speaker is absent and has no offscreen or voice-over declaration.', { lineIndex, speaker }, !castKnown(start) || !castKnown(end));
      }
      for (const what of ids(line.uses)) if (!knowledge.get(speaker)?.has(what)) add('knowledge-before-use', 'Dialogue uses a fact before the speaker learns it.', { lineIndex, who: speaker, what });
    }
    events(list(shot.events).map(declaration), 'action');
    events(end.events, 'end');
    compare(start, end, withinTransitions, 'within-shot');
    remember(end, withinTransitions, false, 'end');
    add('review-scope', 'Structured declarations checked; visual and prose judgements still need review.', { checked: [...checked], notCheckable: [...notCheckable] }, true);
    previous = { id: context.id, end };
  }
  for (const [index, setup] of list(canon?.setups).entries()) {
    const setupId = text(setup?.setup);
    const payoffIds = ids(Array.isArray(setup?.payoff) ? setup.payoff : [setup?.payoff]);
    const planted = occurrences.get(setupId)?.[0];
    context = { index: `canon-${index}`, id: planted?.shotId ?? null, previousId: null };
    if (!setupId || !payoffIds.length) {
      add('incomplete-setup', 'Canon setup requires a setup id and payoff id(s).', { setup: setupId }, true);
      continue;
    }
    for (const payoff of payoffIds) {
      const paid = occurrences.get(payoff);
      if (!planted || !paid?.some((entry) => entry.order > planted.order)) add('setup-payoff', 'A canon setup or its subsequent required payoff is missing.', { setup: setupId, payoff, setupPresent: Boolean(planted), payoffPresent: Boolean(paid?.length) });
    }
  }
  return findings;
}
