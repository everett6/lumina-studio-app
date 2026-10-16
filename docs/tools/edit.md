# Shot editing and animatics

All ten tools are free: no provider calls, downloads or generation. The edit renderer and animatic use CPU ffmpeg. New media assets are saved in the storyboard's project library.

| Tool | Inputs | Effect |
| --- | --- | --- |
| `insert_shot` | `storyboardId`, `afterShotId` (id or null), `shot` | Insert after an existing shot; null inserts first. Shot needs `description`, `duration` (1/24–30 source seconds); optional `camera` and `details`. |
| `duplicate_shot` | `shotId`, `withMedia=false` | Insert the plan immediately after its source. With media, reference the same selected frame, clip, dialogue recordings and sound effects; never copy files. New shot starts unlocked and unapproved. |
| `split_shot` | `shotId`, `atSeconds` | Split at playback seconds, retaining the selected assets. Video trim advances by `atSeconds * speed`; stills split their durations. Both parts need at least 1/24 second. |
| `delete_shot` | `shotId`, `confirm=true` | Remove the shot and renumber. Confirmation is mandatory. Takes and their files remain in the library. |
| `set_cut_transition` | `shotId`, `transition`, `seconds` | Set the outgoing boundary: `cut`, `crossfade`, `fade-black`, `fade-white`. Seconds: 0–10 (positive for fades). |
| `set_shot_speed` | `shotId`, `speed`, `keepPitch=true` | Speed 0.25–4. Apply `setpts` to picture, chained `atempo` to clip audio; `keepPitch=false` changes audio pitch through resampling. |
| `add_text_overlay` | `shotId`, `text`, `position`, `start`, `seconds`, `style` | Append literal UTF-8 text, burned only during the given playback interval. |
| `make_animatic` | `storyboardId`, `fps=12`, `includeDialogue=true` | Save a 640×360 MP4 from frames/placeholder cards, with shot numbers and labels. FPS must be 12 or 24. |
| `reorder_scene` | `storyboardId`, `scene`, `beforeScene` (label or null) | Gather all matching shots, preserving internal order. Null moves the scene to the end. |
| `shot_timeline` | `storyboardId` | Read the 24 fps ledger: start/end/duration seconds and frames, outgoing transition, speed, overlays, and total runtime. End frames are exclusive. |

## Timing and media

`shot.duration` remains the planned **source** duration. Playback duration is `duration / speed`, rounded to at least one frame on the 24 fps ledger. Repeated speed edits are absolute, not cumulative. The join retains its established native/selected output frame rate; other rates round cumulative ledger boundaries. Subtitle cues and production export timing account for speed; exported JSON also includes source duration, speed, pitch policy, per-cut transition and overlays. A CMX EDL cannot represent all these effects; use the JSON for finishing.

Per-cut settings live in `shot.details.cutTransition`; unset shots inherit the storyboard transition. Like the existing storyboard dissolve, transitions borrow an outgoing handle and preserve planned runtime. An outgoing fade starts at the next shot's timeline start, mixing the previous shot's extra handle with the incoming shot. Source media that runs short holds its last frame and pads audio with silence. Fade lengths round to frames and clamp to leave at least one frame in both neighbours; the last shot has no active transition. The legacy default crossfade remains disabled when any slot is too short (1.3 seconds or less).

Text lives in `details.overlays` (maximum 24 per shot). Positions: `top`, `center`, `bottom`, `top-left`, `top-right`, `bottom-left`, `bottom-right`. Styles: `sign`, `caption`, `title`. Text is limited to 2,000 characters. `start` is inclusive and `start + seconds` exclusive; the interval must fit the shot when added. Rendering uses literal text files with expansion disabled and the existing font lookup, so quotes, percent signs and ffmpeg syntax in text are inert. Changing speed later can move an overlay beyond the new end, where it is naturally clipped.

A split assigns each dialogue line by its start time; automatic timing uses measured recording lengths, or cached lengths for unrecorded lines. Lines starting at the split go to the second part with their starts rebased. A recording is never cut or rerecorded: a line crossing the split can therefore overrun the first part and needs a timing/dialogue revision before a final join. Overlays and holds are divided at the split; sound effects follow their start times. The original outgoing transition moves to the second part, with a hard cut between parts.

## Invalidation and safety

Edits invalidate the joined film persistently, including deletion and scene moves that do not update a surviving shot's timestamp. Rejoin to clear `joinStale`. Source approvals survive insertion and reordering; a duplicate starts unapproved. Split, speed and text changes reset picture approvals and clip acceptance. A cut change resets the outgoing shot's clip acceptance while preserving its source-frame approval. Split/delete require unlocked shots; edits of individual shots refuse active frame/clip/dialogue jobs. Existing story-lock rules remain in force for other tools.

## Animatic result and limits

The result includes `asset`, `totalSeconds`, `totalFrames`, `fps`, `shotsWithoutFrames` (shot ids), and `dialogueOverruns` (`shotId`, `lineIndex`, excess `seconds`). Labels and placeholder cards need no generated clip. Dialogue lengths are measured from existing recordings; cached lengths are used only when no recording exists. An overrun is reported and clipped at that shot's boundary in the preview; the original recording remains intact. Missing recordings remain silent. `includeDialogue=false` omits speech while still reporting pacing problems. Making a preview does not change the storyboard's media selection, approvals or film freshness.

The animatic previews frames, timing and recorded speech, not generated motion, lip sync, final colour, music or sound effects. It includes per-cut transitions and text. At 12 fps, cumulative boundary rounding keeps total runtime within one preview frame of the 24 fps ledger; a shot shorter than a preview frame may disappear. Choose 24 fps to retain every ledger frame. Font coverage depends on installed system fonts; ffmpeg must have drawtext support.

The existing separate film-plan validation module uses its original timing rules; use `shot_timeline` and the animatic for this editing ledger. Final joins retain the existing rule of skipping shots without usable clips; animatics retain those slots as frames or placeholders.
