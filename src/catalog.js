// OpenRouter's public model catalog (no key needed, nothing billed): video and image models with their real
// durations, aspect ratios, resolutions, start/end-frame support and prices. Fetched on demand and at most
// once a day in the background; the last good copy is kept in settings so Lumina works offline.

const api = 'https://openrouter.ai/api/v1';
const dayMs = 24 * 3600 * 1000;

export function createModelCatalog({ repo, provider, log = console, fetchImpl = (...args) => fetch(...args) }) {
  const statics = new Map(provider?.models.map((m) => [m.id, { ...m }]) ?? []);
  let refreshing = null;

  const cached = () => repo.settings.get('openrouterCatalog', null);

  // Rebuilds the provider's model list: the hand-checked models first (live capabilities applied), then every
  // other live video model. A model that disappeared from the live list is dropped.
  function apply(catalog = cached()) {
    if (!provider || !catalog?.video?.length) return;
    const live = new Map(catalog.video.map((m) => [m.id, m]));
    const models = [];
    for (const model of statics.values()) {
      if (!model.operations.includes('video')) {
        const image = catalog.image?.find((m) => m.id === model.id);
        models.push({
          ...model,
          ...(image?.pricing ? { livePrice: image.pricing } : {}),
          // More reference images means characters and locations can all be shown to the model at once.
          ...(image?.maxReferences ? { maxReferences: image.maxReferences } : {}),
          ...(image?.seed ? { seed: true } : {}),
        });
        continue;
      }
      const entry = live.get(model.id);
      if (entry) models.push(merge(model, entry));
    }
    for (const entry of catalog.video) {
      if (statics.has(entry.id) || !entry.durations?.length) continue;
      models.push(merge({ id: entry.id, label: entry.name || entry.id, operations: ['video'], sizes: [], qualities: [], note: 'From OpenRouter\'s live model list' }, entry));
    }
    provider.models.splice(0, provider.models.length, ...models);
  }

  function merge(model, entry) {
    return {
      ...model,
      durations: entry.durations?.length ? entry.durations : model.durations,
      aspects: entry.aspects?.length ? entry.aspects : model.aspects,
      resolutions: entry.resolutions ?? [],
      maxReferences: entry.frameImages?.includes('first_frame') ? 1 : 0,
      lastFrame: Boolean(entry.frameImages?.includes('last_frame')),
      audio: entry.audio,
      liveSkus: entry.skus ?? null,
      note: model.note,
    };
  }

  async function refresh() {
    refreshing ??= (async () => {
      try {
        const get = async (url) => {
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { 'x-title': 'Lumina Studio' } });
          if (!response.ok) throw new Error(`OpenRouter model list returned HTTP ${response.status}`);
          return response.json();
        };
        const videos = await get(`${api}/videos/models`);
        const video = (videos.data ?? videos).map((m) => ({
          id: m.id, name: m.name, durations: m.supported_durations ?? [], aspects: m.supported_aspect_ratios ?? [],
          resolutions: m.supported_resolutions ?? [], frameImages: m.supported_frame_images ?? [], audio: m.generate_audio ?? null,
          skus: m.pricing_skus ?? null,
        }));
        // Image capabilities come from the image model list; prices from each model's endpoint records (only the
        // image models Lumina offers are looked up).
        const imageList = await get(`${api}/images/models`).catch(() => ({ data: [] }));
        const imageRows = Array.isArray(imageList.data) ? imageList.data : Array.isArray(imageList) ? imageList : [];
        const imageParams = new Map(imageRows.map((m) => [m.id, m.supported_parameters ?? {}]));
        const image = [];
        for (const model of statics.values()) {
          if (!model.operations.includes('generate')) continue;
          try {
            const body = await get(`${api}/images/models/${model.id}/endpoints`);
            const lines = (body.data ?? body).endpoints?.flatMap((e) => e.pricing ?? []).filter((p) => p.billable === 'output_image') ?? [];
            // The dearest endpoint is the safe estimate: OpenRouter may route to any of them.
            const pick = (unit) => Math.max(...lines.filter((p) => p.unit === unit).map((p) => Number(p.cost_usd)));
            const pricing = lines.some((p) => p.unit === 'image') ? { usd: pick('image'), per: 'image' }
              : lines.some((p) => p.unit === 'megapixel') ? { usd: pick('megapixel'), per: 'megapixel' } : null;
            const params = imageParams.get(model.id) ?? {};
            image.push({ id: model.id, pricing, maxReferences: Number(params.input_references?.max) || null, seed: Boolean(params.seed) });
          } catch (error) {
            log.info?.('Image price lookup failed', { model: model.id, detail: error.message });
          }
        }
        const catalog = { fetchedAt: new Date().toISOString(), video, image };
        repo.settings.set('openrouterCatalog', catalog);
        apply(catalog);
        return catalog;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  apply();
  return {
    refresh,
    status: () => {
      const c = cached();
      return c ? { fetchedAt: c.fetchedAt, videoModels: c.video.length } : { fetchedAt: null, videoModels: 0 };
    },
    // Background refresh when the saved copy is missing or older than a day; failures (offline) are only logged.
    refreshIfStale() {
      const c = cached();
      if (c && Date.now() - Date.parse(c.fetchedAt) < dayMs) return;
      refresh().catch((error) => log.info?.('Model list refresh skipped', { detail: error.message }));
    },
  };
}

// Per-second rate for a video request from OpenRouter's pricing SKUs, or null when the model is priced some
// other way (per token, for example). When several SKUs could apply, the highest is used so an estimate is never
// below the real charge. `minimum` and `imageInput` come from their own SKUs.
export function videoRate(skus, { resolution, audio = true, image = false } = {}) {
  if (!skus) return null;
  const res = String(resolution ?? '').toLowerCase();
  const rates = [];
  for (const [key, raw] of Object.entries(skus)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    let m = /^cents_per_video_output_second(?:_([a-z0-9]+))?$/.exec(key) ?? /^cents_per_second_output(?:_([a-z0-9]+))?$/.exec(key);
    if (m) {
      rates.push({ usd: value / 100, res: m[1] ?? null, mode: null, audio: null });
      continue;
    }
    m = /^(text_to_video_|image_to_video_|reference_)?duration_seconds(_with_audio|_without_audio)?(?:_([a-z0-9]+))?$/.exec(key);
    if (m) rates.push({ usd: value, res: m[3] ?? null, mode: m[1] ?? null, audio: m[2] ? m[2] === '_with_audio' : null });
  }
  let pool = rates.filter((r) => r.mode !== 'reference_');
  if (!pool.length) return null;
  const wantMode = image ? 'image_to_video_' : 'text_to_video_';
  pool = pool.filter((r) => r.mode === null || r.mode === wantMode);
  // Rates that name the sound setting beat unlabeled ones (an unlabeled rate may be the cheaper silent one).
  if (pool.some((r) => r.audio === audio)) pool = pool.filter((r) => r.audio === audio);
  else if (pool.some((r) => r.audio !== null)) pool = pool.filter((r) => r.audio === null);
  // An exact resolution match wins; otherwise every remaining rate is a candidate and the highest is taken.
  if (res && pool.some((r) => r.res === res)) pool = pool.filter((r) => r.res === res);
  return {
    perSecond: Math.max(...pool.map((r) => r.usd)),
    imageInput: image && Number.isFinite(Number(skus.cents_per_image_input)) ? Number(skus.cents_per_image_input) / 100 : 0,
    minimum: Number.isFinite(Number(skus.minimum_cents_per_generation)) ? Number(skus.minimum_cents_per_generation) / 100 : 0,
  };
}
