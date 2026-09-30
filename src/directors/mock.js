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
  if (task === 'revise') {
    const instruction = /INSTRUCTION:\s*(.*)/.exec(prompt)?.[1] ?? 'revised';
    return JSON.stringify({ text: `Revised (${instruction}): Pip splashed happily in the lake.`, illustrationBrief: 'Pip splashing in shallow water, golden light.' });
  }
  return 'ok';
}
