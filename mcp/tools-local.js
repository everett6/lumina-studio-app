// MCP tools: local. Registered by registerLuminaTools (mcp/tools.js) with the shared helpers in `ctx`:
// { tool, text, ok, safe, client, z, path, summarizeGeneration, waitAndShow, imageContent, mediaParts, pickModel }.
// `meta` adds entries to TOOL_META: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
export const meta = {
  local_status: ['r', 'Free; no downloads.', 'preflight'],
  list_local_models: ['r', 'Free; no downloads.', 'preflight'],
  free_gpu_memory: ['i', 'Free; stops only idle Lumina workers.', 'local_status'],
  gpu_queue: ['r', 'Free.', 'preflight'],
  preflight: ['r', 'Free; advisory only.', 'list_local_models'],
};

export function register({ tool, text, ok, safe, client, z }) {
  for (const [name, route, description] of [
    ['local_status', 'status', 'Read device-level NVIDIA VRAM, temperature, power and utilisation, free RAM and disk, Lumina GPU jobs and worker visibility. Warns below 4 GiB RAM or 20 GiB disk, or above 80 C. Never inspects application processes.'],
    ['list_local_models', 'models', 'List all Lumina local models with installation checks, disk sizes, purpose, licence and setup commands. Reads existing files only; never downloads or starts a model.'],
    ['gpu_queue', 'gpu-queue', 'Read running and queued heavy Lumina GPU jobs and their ages. Existing anonymous jobs have a generic label; no other application is inspected.'],
  ]) tool(name, { description, inputSchema: {} }, safe(async () => ok(text(await client.call('GET', `/api/local/${route}`)))));
  tool('free_gpu_memory', {
    description: 'Release VRAM by shutting down idle Lumina workers. Skips immediately when Lumina GPU work is running or queued. Never stops another application. Returns device VRAM before and after; driver accounting may lag. Loaded-worker names are unavailable with the current provider hooks.',
    inputSchema: {},
  }, safe(async () => ok(text(await client.call('POST', '/api/local/free-gpu-memory', {})))));
  tool('preflight', {
    title: 'Local task preflight',
    description: 'Check conservative free VRAM, RAM, disk and temperature needs for a local task: go / wait / no, with thresholds and reasons. Unknown telemetry means no. Advisory only; cannot prevent every out-of-memory error. Optional width/height are the largest working frame dimensions; durationSeconds/fps increase finishing disk estimates. Checks resources, not model/runtime readiness.',
    inputSchema: {
      task: z.enum(['wan-clip', 'anime-frame', 'bake', 'upscale', 'interpolate']),
      options: z.object({ width: z.number().int().min(1).max(16384).optional(), height: z.number().int().min(1).max(16384).optional(),
        durationSeconds: z.number().min(0.01).max(86400).optional(), fps: z.number().min(1).max(240).optional() }).strict().optional(),
    },
  }, safe(async ({ task, options }) => ok(text(await client.call('POST', '/api/local/preflight', { task, options })))));
}
