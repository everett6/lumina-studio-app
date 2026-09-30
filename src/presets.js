// Preset library for Create: camera moves (video), effects and styles. Each preset adds a prompt fragment;
// `tile` tells the UI how to draw its animated preview (motion = camera/effect animation, look = palette/filter).
// At most one preset per group can be applied to a generation.

export const presetGroups = {
  camera: { label: 'Camera', blurb: 'How the camera moves through the shot.' },
  effect: { label: 'Effects', blurb: 'Time, weather and atmosphere.' },
  style: { label: 'Styles', blurb: 'The overall look.' },
};

const cameraLooks = ['dusk', 'day', 'night', 'mist', 'winter', 'storm'];
let cameraCount = 0;
const camera = (id, label, blurb, fragment) => ({
  id, group: 'camera', modes: ['video'], label, blurb, fragment, tile: { motion: id, look: cameraLooks[cameraCount++ % cameraLooks.length] },
});
const effect = (id, label, blurb, fragment, modes = ['image', 'video'], look = 'dusk') => ({ id, group: 'effect', modes, label, blurb, fragment, tile: { motion: id, look } });
const style = (id, label, blurb, fragment) => ({ id, group: 'style', modes: ['image', 'video'], label, blurb, fragment, tile: { motion: 'still', look: id } });

export const presets = [
  camera('dolly-in', 'Dolly in', 'Slow push toward the subject.', 'Camera: a smooth, slow dolly push-in toward the subject, steady and deliberate.'),
  camera('dolly-out', 'Dolly out', 'Pull back to reveal the scene.', 'Camera: a smooth dolly pull-back that gradually reveals the wider surroundings.'),
  camera('orbit-left', 'Orbit left', 'Arc around the subject.', 'Camera: a slow arc to the left around the subject, keeping it centered as the background shifts behind it.'),
  camera('orbit-right', 'Orbit right', 'Arc the other way.', 'Camera: a slow arc to the right around the subject, keeping it centered as the background shifts behind it.'),
  camera('crane-up', 'Crane up', 'Rise high above the scene.', 'Camera: rises on a crane from near ground level to a high vantage point, revealing the scene below.'),
  camera('crane-down', 'Crane down', 'Descend into the moment.', 'Camera: descends on a crane from high above down to eye level with the subject.'),
  camera('truck-left', 'Track left', 'Glide sideways, parallel.', 'Camera: tracks sideways to the left, parallel to the subject, with foreground elements sliding past.'),
  camera('truck-right', 'Track right', 'Glide the other way.', 'Camera: tracks sideways to the right, parallel to the subject, with foreground elements sliding past.'),
  camera('pan-left', 'Pan', 'Turn to scan the horizon.', 'Camera: stays in place and pans slowly across the scene from right to left.'),
  camera('tilt-up', 'Tilt up', 'From the ground to the sky.', 'Camera: stays in place and tilts upward, from the ground to the sky above the subject.'),
  camera('fpv', 'FPV drone', 'Fast, banking fly-through.', 'Camera: a fast first-person drone flight weaving close through the scene with banking turns and a sense of speed.'),
  camera('aerial', 'Aerial glide', 'High flyover.', 'Camera: a high aerial drone shot gliding forward over the landscape, smooth and expansive.'),
  camera('handheld', 'Handheld', 'Documentary feel.', 'Camera: handheld, documentary style, with subtle natural sway as it follows the action.'),
  camera('crash-zoom', 'Crash zoom', 'Sudden punch-in.', 'Camera: a sudden, fast zoom in onto the subject for dramatic emphasis, then holds.'),
  camera('dolly-zoom', 'Dolly zoom', 'Warping background, fixed subject.', 'Camera: a dolly zoom — the camera moves back while zooming in, so the subject stays the same size while the background stretches unsettlingly.'),
  camera('overhead', 'Overhead', 'Top-down, slowly turning.', 'Camera: a top-down overhead view looking straight down, rotating slowly.'),
  camera('follow', 'Follow', 'Behind the subject.', 'Camera: follows behind the subject at a steady distance as it moves forward through the scene.'),
  camera('frozen-orbit', 'Frozen orbit', 'Time stops, camera sweeps.', 'Camera: time freezes mid-action while the camera sweeps a fast half-circle around the subject.'),
  camera('rack-focus', 'Rack focus', 'Shift focus to the subject.', 'Camera: static frame; focus racks from a blurred foreground element to the sharp subject behind it.'),
  camera('locked-off', 'Locked off', 'Still frame, moving world.', 'Camera: locked off on a tripod, perfectly still; only the subject and environment move.'),

  effect('slow-motion', 'Slow motion', 'Every detail stretched out.', 'Effect: high-frame-rate slow motion; hair, fabric, water and particles move gracefully.', ['video']),
  effect('timelapse', 'Time-lapse', 'Hours pass in seconds.', 'Effect: time-lapse; clouds race, light and shadows sweep across the scene as hours pass.', ['video'], 'day'),
  effect('hyperlapse', 'Hyperlapse', 'Moving time-lapse.', 'Effect: hyperlapse; the camera moves steadily forward while time rushes, with streaking lights.', ['video'], 'night'),
  effect('rain', 'Rain', 'Wet streets, falling drops.', 'Atmosphere: steady rain, wet reflective surfaces, droplets catching the light.', ['image', 'video'], 'storm'),
  effect('snow', 'Snowfall', 'Soft, drifting flakes.', 'Atmosphere: gentle snowfall, soft flakes drifting through the air, quiet and cold.', ['image', 'video'], 'winter'),
  effect('fog', 'Fog', 'Layers of mist.', 'Atmosphere: low rolling fog and layered mist, soft diffused light, depth fading into haze.', ['image', 'video'], 'mist'),
  effect('embers', 'Embers', 'Sparks rising.', 'Atmosphere: glowing embers and sparks drifting upward, warm firelight.', ['image', 'video'], 'fire'),
  effect('light-leak', 'Light leak', 'Warm film flares.', 'Effect: warm light leaks and lens flares washing across the frame, nostalgic.', ['image', 'video']),
  effect('glitch', 'Glitch', 'Digital distortion.', 'Effect: digital glitch distortion, RGB channel split and brief datamosh artifacts.', ['image', 'video'], 'night'),

  style('cinematic', 'Cinematic', 'Anamorphic film still.', 'Style: cinematic film still, anamorphic widescreen, teal-and-orange grade, shallow depth of field, motivated lighting.'),
  style('film-35mm', '35mm film', 'Grain and warm halation.', 'Style: shot on 35mm film, natural grain, warm halation, slightly faded blacks.'),
  style('editorial', 'Editorial', 'Magazine fashion shoot.', 'Style: high-end fashion editorial photograph, clean composition, soft high-key light.'),
  style('product', 'Product studio', 'Clean seamless backdrop.', 'Style: professional product photography on a seamless studio backdrop, softbox lighting, crisp reflections.'),
  style('portrait', 'Portrait', 'Creamy background blur.', 'Style: portrait photograph, 85mm lens, creamy background bokeh, flattering soft light.'),
  style('noir', 'Noir', 'Hard shadows, black and white.', 'Style: black-and-white film noir, hard low-key lighting, deep shadows, venetian-blind light patterns.'),
  style('neon', 'Neon night', 'Glowing city colors.', 'Style: neon-lit night scene, saturated magenta and cyan glow, reflections on wet surfaces.'),
  style('anime', 'Anime', 'Cel-shaded animation.', 'Style: hand-drawn anime cel shading, clean line art, vivid sky, painterly backgrounds.'),
  style('watercolor', 'Watercolor', 'Soft washes on paper.', 'Style: loose watercolor painting, soft bleeding washes, visible paper texture.'),
  style('oil', 'Oil painting', 'Rich impasto strokes.', 'Style: classical oil painting, rich impasto brushstrokes, warm glazed colors.'),
  style('clay', 'Clay', 'Handmade stop-motion.', 'Style: handmade clay stop-motion look, soft rounded forms, fingerprint texture, miniature set.'),
  style('pixel', 'Pixel art', 'Retro game sprites.', 'Style: detailed 16-bit pixel art, limited palette, crisp pixels, no anti-aliasing.'),
  style('ink', 'Ink sketch', 'Pen lines and hatching.', 'Style: black ink pen sketch with cross-hatching on off-white paper.'),
  style('poster', 'Vintage poster', 'Mid-century print.', 'Style: mid-century travel poster, flat screen-printed colors, halftone texture, bold shapes.'),
  style('isometric', 'Isometric', 'Tiny 3D diorama.', 'Style: isometric 3D diorama, miniature scale, soft global illumination, clean pastel materials.'),
  style('macro', 'Macro', 'Extreme close-up detail.', 'Style: extreme macro photograph, razor-thin focus plane, fine surface detail.'),
];

const byId = new Map(presets.map((p) => [p.id, p]));

export const getPreset = (id) => byId.get(id) ?? null;

// Validates a list of preset ids for an operation; returns the cleaned list or throws a message.
export function checkPresets(ids, operation) {
  if (ids == null) return [];
  if (!Array.isArray(ids)) throw new Error('presets must be a list of preset ids.');
  const mode = operation === 'video' ? 'video' : 'image';
  const seen = new Set();
  const out = [];
  for (const id of new Set(ids)) {
    const preset = byId.get(id);
    if (!preset) throw new Error(`Unknown preset "${id}".`);
    if (!preset.modes.includes(mode)) throw new Error(`${preset.label} works for ${preset.modes.join(' and ')}, not ${mode}.`);
    if (seen.has(preset.group)) throw new Error(`Choose one ${presetGroups[preset.group].label.toLowerCase().replace(/s$/, '')} preset at a time.`);
    seen.add(preset.group);
    out.push(id);
  }
  return out;
}

export function composePrompt(prompt, ids = []) {
  const fragments = (ids ?? []).map((id) => byId.get(id)?.fragment).filter(Boolean);
  return fragments.length ? `${prompt}\n\n${fragments.join('\n')}` : prompt;
}
