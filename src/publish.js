import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { burnSubtitles, endCredits, makeShort, makeThumbnail, srtFromCues, titleCard } from './delivery.js';
import { RequestError } from './generation.js';
import { probe, run } from './video.js';

// The publish kit for a joined film: one folder with the film (optionally with a title card and an end-credits
// roll), subtitles, a ready-to-paste description with every credit the film needs (voice cast, internet music and
// sound effects with their licences), a thumbnail, and optionally a 9:16 Short and a copy with burned-in subtitles.
// An outdated film (joined before later edits) is refused, so a stale cut is never published by accident.
const safeName = (text) => String(text).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'film';

export function describeFilm(title, credits, { logline = '' } = {}) {
  const lines = [title, ...(logline ? ['', logline] : []), ''];
  if (credits.voices.length) lines.push('Voices:', ...credits.voices.map((v) => `  ${v.name}: ${v.voice}`), '');
  const credited = [...credits.music, ...credits.sounds];
  if (credited.length) {
    lines.push('Music and sound:');
    for (const c of credited) lines.push(`  ${c.credit}${c.page ? ` (${c.page})` : ''}`);
    lines.push('');
  }
  lines.push('Made with Lumina Studio.');
  return lines.join('\n');
}

export function createPublisher({ sequences, assetStore, repo, exportDir, log = console }) {
  const asset = (id) => (id ? repo.assets.get(id) : null);

  async function publish(id, { titleCard: withTitle = false, endCredits: withCredits = true, thumbnail = true, thumbnailShotId = null,
    short = false, shortStart = 0, shortSeconds = 60, burnSubtitles: withBurned = false, logline = '', allowStale = false } = {}) {
    const detail = sequences.detail(id);
    const { sequence, shots } = detail;
    const film = asset(sequence.outputAssetId);
    if (!film) throw new RequestError(409, 'Join the storyboard first (join_storyboard); there is no film to publish yet.');
    if (sequence.joinStale && !allowStale) throw new RequestError(409, 'The film is out of date: shots or film settings changed after it was joined. Join it again first (or pass allowStale to publish the old cut).');
    const info = await probe(assetStore.path(film));
    const { width, height } = info;
    const fps = Math.round(info.fps) || 30;
    const folder = path.join(exportDir, `${safeName(sequence.title)}-publish-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(folder, { recursive: true });
    const files = [];
    const warnings = [];
    const saved = {};
    const out = (name) => { files.push(name); return path.join(folder, name); };

    const credits = sequences.filmCredits(id);
    const description = describeFilm(sequence.title, credits, { logline });
    await writeFile(out('description.txt'), `${description}\n`);
    if ([...credits.music, ...credits.sounds].some((c) => c.needsCredit)) warnings.push('CC BY music or sounds: keep the credit lines in the description (they are also in the end credits when those are on).');
    if (credits.voices.some((v) => v.voice === 'no voice set')) warnings.push('Some speakers have no voice set; their lines are silent.');

    // The film, with an optional title card before it and an end-credits roll after it (same size, fps and sound format).
    let master = assetStore.path(film);
    const parts = [];
    if (withTitle) {
      const frame = asset(shots.find((s) => s.imageAssetId)?.imageAssetId);
      parts.push((await titleCard(path.join(folder, '.title.mp4'), { title: sequence.title, subtitle: logline, width, height, fps, backgroundImage: frame ? assetStore.path(frame) : undefined })).file ?? path.join(folder, '.title.mp4'));
    }
    parts.push(master);
    if (withCredits) {
      const sections = [
        ...(credits.voices.length ? [{ heading: 'Voices', lines: credits.voices.map((v) => `${v.name} — ${v.voice}`) }] : []),
        ...(credits.music.length ? [{ heading: 'Music', lines: credits.music.map((c) => `"${c.title}" by ${c.creator} (${c.license})`) }] : []),
        ...(credits.sounds.length ? [{ heading: 'Sound effects', lines: credits.sounds.map((c) => `"${c.title}" by ${c.creator} (${c.license})`) }] : []),
        { heading: 'Made with', lines: ['Lumina Studio'] },
      ];
      parts.push((await endCredits(path.join(folder, '.credits.mp4'), { sections, width, height, fps })).file ?? path.join(folder, '.credits.mp4'));
    }
    if (parts.length > 1) {
      const inputs = parts.flatMap((p) => ['-i', p]);
      const norm = parts.map((_, i) => `[${i}:v]fps=${fps},scale=${width}:${height},setsar=1,format=yuv420p[v${i}];[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`).join(';');
      const chain = parts.map((_, i) => `[v${i}][a${i}]`).join('');
      await run('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', `${norm};${chain}concat=n=${parts.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', out('film.mp4')], 1_800_000);
    } else await copyFile(master, out('film.mp4'));
    master = path.join(folder, 'film.mp4');
    const offset = withTitle ? (await probe(parts[0])).duration : 0;
    for (const temp of ['.title.mp4', '.credits.mp4']) await rm(path.join(folder, temp), { force: true });

    // Subtitles, shifted by the title card's length when there is one.
    const cues = sequences.subtitleCues(id).map((c) => ({ ...c, from: c.from + offset, to: c.to + offset }));
    if (cues.length) await writeFile(out('subtitles.srt'), await srtFromCues(cues));
    else warnings.push('No dialogue: no subtitles written.');

    if (thumbnail) {
      const shot = shots.find((s) => s.id === thumbnailShotId) ?? shots.find((s) => s.imageAssetId);
      const frame = asset(shot?.imageAssetId);
      if (frame) {
        await makeThumbnail(assetStore.path(frame), out('thumbnail.png'), { title: sequence.title });
        const thumb = await assetStore.save({ bytes: await readFile(path.join(folder, 'thumbnail.png')), projectId: sequence.projectId, kind: 'image', label: `${sequence.title} (thumbnail)`, parentAssetId: frame.id });
        saved.thumbnail = { id: thumb.id, path: thumb.path };
      }
      else warnings.push('No shot has a frame: no thumbnail made.');
    }
    if (short) {
      await makeShort(master, out('short-9x16.mp4'), { start: shortStart, maxSeconds: shortSeconds });
      const shortAsset = await assetStore.save({ bytes: await readFile(path.join(folder, 'short-9x16.mp4')), projectId: sequence.projectId, kind: 'video', label: `${sequence.title} (9:16 short)`, parentAssetId: film.id });
      saved.short = { id: shortAsset.id, path: shortAsset.path };
    }
    if (withBurned && cues.length) {
      try { await burnSubtitles(master, path.join(folder, 'subtitles.srt'), out('film-subtitled.mp4')); } catch (error) { warnings.push(`Burned-in subtitles were skipped: ${error.message}`); }
    }
    const final = await probe(master);
    log.info?.('Published film', { id, folder, files: files.length });
    return { folder, files, description, credits, warnings, assets: saved, film: { seconds: Math.round(final.duration * 100) / 100, width: final.width, height: final.height, fps: Math.round(final.fps) } };
  }

  return { publish };
}
