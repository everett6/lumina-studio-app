// MCP tools: voice. Registered by registerLuminaTools (mcp/tools.js) with the shared helpers in `ctx`:
// { tool, text, ok, safe, client, z, path, summarizeGeneration, waitAndShow, imageContent, mediaParts, pickModel }.
// `meta` adds entries to TOOL_META: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
const free = 'Free: runs locally, no API credits.';
export const meta = {
  create_voice: ['', free, 'speak_line or set_character_voice'],
  create_voice_from_confirmed_audio: ['', free, 'speak_line or set_character_voice'],
  list_custom_voices: ['r', free, 'speak_line'],
  delete_custom_voice: ['d', free, null],
  voice_change: ['', free, null],
  speak_line: ['', free, null],
};

export function register({ tool, text, ok, safe, client, z, mediaParts, summarizeGeneration }) {
  for (const name of ['create_voice', 'create_voice_from_confirmed_audio']) {
    tool(name, {
      title: name === 'create_voice' ? 'Create a custom voice' : 'Create a voice from confirmed audio',
      description: 'Save a custom Chatterbox voice from a clean 5–30 second speech clip in the library. Use only your own voice or a voice you have permission to use; consent=true is required. The confirmed-audio alias has the same consent requirement. No training or model download.',
      inputSchema: { name: z.string().trim().min(1).max(100), audioAssetId: z.string(), consent: z.literal(true).describe('Confirm this is your own voice or you have permission to use it') },
    }, safe(async (body) => ok(text(await client.call('POST', '/api/voices', body)))));
  }
  tool('list_custom_voices', {
    title: 'List custom voices', description: 'List saved custom voice ids, names, consent and source clip metadata. These ids also appear under local Chatterbox in list_voices.', inputSchema: {},
  }, safe(async () => ok(text(await client.call('GET', '/api/voices')))));
  tool('delete_custom_voice', {
    title: 'Delete a custom voice', description: 'Delete a saved custom voice and its reference copy. Existing recordings remain. Characters using this id need a new voice before recording again.', inputSchema: { id: z.string().startsWith('custom:') },
  }, safe(async ({ id }) => ok(text(await client.call('DELETE', `/api/voices/${encodeURIComponent(id)}`)))));
  tool('voice_change', {
    title: 'Change the speaker of recorded audio',
    description: 'Real speech-to-speech conversion with local ChatterboxVC: changes who speaks while retaining the source timing and acting as the model allows. No transcription or text-to-speech fallback. Reports unavailable if the installed package lacks conversion support. Saves a new audio asset in the source project.',
    inputSchema: { audioAssetId: z.string(), targetVoice: z.string().describe('A custom:<slug> id or local preset from list_voices') },
  }, safe(async (body) => {
    const result = await client.call('POST', '/api/voice-change', body);
    return ok(text(result), ...await mediaParts([[result.assetPath, 'audio', 'Changed voice']]));
  }));
  tool('speak_line', {
    title: 'Speak a one-off line', description: 'Speak a quick line, save it in the project and return inline audio plus assetId. Custom voice ids use Chatterbox automatically. Local engines only; style controls Chatterbox delivery intensity.',
    inputSchema: { projectId: z.string(), text: z.string().trim().min(1).max(2000), voice: z.string().optional(), style: z.string().max(500).optional(), engine: z.enum(['kokoro', 'kokoro-82m', 'chatterbox']).optional() },
  }, safe(async ({ projectId, text: words, voice, style, engine }) => {
    const model = voice?.startsWith('custom:') || engine === 'chatterbox' ? 'chatterbox' : 'kokoro-82m';
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation: 'speech', prompt: words, provider: 'local', model, voice, style });
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 240000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: done.status === 'failed' };
    return ok(text({ assetId: done.assetId, provider: 'local', model, voice, text: words }), ...await mediaParts([[done.assetPath, 'audio', 'Spoken line']]));
  }));
}
