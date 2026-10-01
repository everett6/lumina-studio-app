// Deterministic offline stand-in for text models, used by tests and `npm run mock`.
// Book tasks get well-formed JSON so the whole book flow can be exercised without keys.
export function mockCompletion({ task, prompt }) {
  if (task === 'refine') return `${prompt.trim()}, cinematic lighting, detailed composition`;
  if (task === 'bible') {
    return JSON.stringify({
      characters: [
        { name: 'Pip', description: 'A curious young fox who asks too many questions.', visual: 'small red fox, white-tipped tail, green scarf, big amber eyes' },
        { name: 'Grandma Owl', description: 'A patient owl who knows the forest.', visual: 'round grey owl, small round spectacles, knitted purple shawl' },
      ],
      setting: 'A cozy pine forest beside a quiet lake, autumn.',
      voice: 'Warm, rhythmic sentences with gentle repetition. Short lines for read-aloud.',
      styleNotes: 'Soft watercolor, warm autumn palette, rounded shapes, gentle light.',
    });
  }
  if (task === 'plan') {
    const count = Number(/PAGE_COUNT=(\d+)/.exec(prompt)?.[1] ?? 4);
    return `Here is the plan:\n${JSON.stringify({
      pages: Array.from({ length: count }, (_, i) => ({
        text: `Page ${i + 1}: Pip wondered about the lake, and Grandma Owl smiled.`,
        illustrationBrief: `Pip and Grandma Owl by the lake, moment ${i + 1}, wide shot.`,
      })),
    })}`;
  }
  if (task === 'outline') {
    const count = Number(/CHAPTER_COUNT=(\d+)/.exec(prompt)?.[1] ?? 3);
    return JSON.stringify({
      chapters: Array.from({ length: count }, (_, i) => ({
        title: `The ${['Arrival', 'Storm', 'Crossing', 'Return', 'Reckoning'][i % 5]} ${i + 1}`,
        summary: `Chapter ${i + 1} moves the story forward as Pip faces a new test.`,
        beats: [`Scene ${i + 1}a: Pip arrives at the lake.`, `Scene ${i + 1}b: Grandma Owl gives advice.`, `Scene ${i + 1}c: A choice is made.`],
      })),
    });
  }
  if (task === 'shots') {
    const count = Number(/SHOT_COUNT=(\d+)/.exec(prompt)?.[1] ?? 3);
    const cameras = ['dolly-in', 'orbit-left', 'crane-up', 'not-a-camera'];
    return JSON.stringify({
      shots: Array.from({ length: count }, (_, i) => ({
        description: `Shot ${i + 1}: Pip the fox walks toward the lake at dawn.`, camera: cameras[i % cameras.length], duration: 4 + (i % 3) * 3,
      })),
    });
  }
  if (task === 'draft') {
    const words = Number(/TARGET_WORDS=(\d+)/.exec(prompt)?.[1] ?? 300);
    const sentence = 'Pip stood at the edge of the cold water and listened to the reeds whisper.';
    const paragraphs = Array.from({ length: Math.max(3, Math.round(words / 60)) }, () => Array(4).fill(sentence).join(' '));
    return paragraphs.join('\n\n');
  }
  if (task === 'revise-chapter') {
    const instruction = /INSTRUCTION:\s*(.*)/.exec(prompt)?.[1] ?? 'revised';
    return `Revised (${instruction}). ${'The lake was quiet, and Pip felt brave at last. '.repeat(12)}\n\n${'Grandma Owl smiled from the branch above. '.repeat(10)}`;
  }
  if (task === 'revise') {
    const instruction = /INSTRUCTION:\s*(.*)/.exec(prompt)?.[1] ?? 'revised';
    return JSON.stringify({ text: `Revised (${instruction}): Pip splashed happily in the lake.`, illustrationBrief: 'Pip splashing in shallow water, golden light.' });
  }
  return 'ok';
}
