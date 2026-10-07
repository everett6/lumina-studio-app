import { $, api, emit, h, on, toast } from './lib.js';

const keyProviders = [
  { id: 'openrouter', label: 'OpenRouter — one key for everything', use: 'Universal key: images (Nano Banana, GPT Image, FLUX.2, Seedream), video (Veo 3.1, Kling 3.0, Seedance, Wan, Hailuo) and writing (Claude, GPT, Gemini) through one account', url: 'https://openrouter.ai/settings/keys' },
  { id: 'openai', label: 'OpenAI', use: 'GPT Image generation and edits; GPT creative director', url: 'https://platform.openai.com/api-keys' },
  { id: 'fal', label: 'fal.ai', use: 'FLUX generation and Kontext edits', url: 'https://fal.ai/dashboard/keys' },
  { id: 'gemini', label: 'Google Gemini', use: 'Gemini image generation and edits', url: 'https://aistudio.google.com/apikey' },
  { id: 'replicate', label: 'Replicate', use: 'FLUX models on Replicate', url: 'https://replicate.com/account/api-tokens' },
  { id: 'anthropic', label: 'Anthropic', use: 'Claude as creative director (prompt refinement)', url: 'https://console.anthropic.com/settings/keys' },
  { id: 'nemotron', label: 'NVIDIA Nemotron', use: 'Nemotron as creative director', url: 'https://build.nvidia.com' },
];

function sourceText(status) {
  if (!status.configured) return 'Not set';
  if (status.source === 'environment') return 'From environment (.env)';
  if (status.unreadable) return 'Saved, but cannot be decrypted here';
  return status.encrypted ? 'Saved · encrypted with system keyring' : 'Saved · private file on this computer';
}

async function render() {
  const { keys, encrypted } = await api('/api/settings/keys');
  $('#key-storage-note').textContent = encrypted
    ? 'Keys are encrypted with your system keyring. They are only sent to the provider they belong to.'
    : 'Keys are stored in a private file readable only by your user account and are never sent to the page. The desktop app encrypts them with your system keyring.';
  $('#settings-grid').replaceChildren(...keyProviders.map((provider) => {
    const status = keys[provider.id];
    const input = h('input', { type: 'password', placeholder: status.configured ? 'Replace key…' : 'Paste API key', autocomplete: 'off', spellcheck: false, 'aria-label': `${provider.label} API key` });
    const result = h('small.key-result');
    const run = (fn) => async () => {
      try {
        await fn();
      } catch (error) {
        result.textContent = error.message;
        result.dataset.tone = 'error';
      }
    };
    const save = run(async () => {
      if (!input.value.trim()) return;
      await api(`/api/settings/keys/${provider.id}`, { method: 'PUT', body: { key: input.value } });
      input.value = '';
      toast(`${provider.label} key saved.`);
      emit('keys-changed');
      await render();
    });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
    return h('section.panel.key-card', {},
      h('div.key-head', {}, h('b', {}, provider.label), h(`span.badge${status.configured ? '.ok' : ''}`, {}, sourceText(status))),
      h('p.muted', {}, provider.use),
      h('div.key-row', {}, input, h('button.button.secondary.small', { onclick: save }, 'Save')),
      h('div.key-row', {},
        h('button.text-button', { disabled: !status.configured, onclick: run(async () => {
          result.textContent = 'Testing…';
          result.dataset.tone = '';
          const test = await api(`/api/settings/keys/${provider.id}/test`, { method: 'POST', body: {} });
          result.textContent = test.ok ? (test.message || (test.verified ? 'Key works.' : 'Key accepted.')) : test.message;
          result.dataset.tone = test.ok ? 'ok' : 'error';
        }) }, 'Test key'),
        h('button.text-button.danger', { disabled: status.source !== 'saved', onclick: run(async () => {
          await api(`/api/settings/keys/${provider.id}`, { method: 'DELETE' });
          emit('keys-changed');
          await render();
        }) }, 'Remove'),
        h('a.text-button', { href: provider.url, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key ↗')),
      result);
  }));
}

let remoteTimer = null;

async function renderRemote() {
  const status = await api('/api/settings/remote');
  const s = status.settings;
  const url = h('input', { type: 'text', value: s.publicUrl, placeholder: 'https://your-tunnel.example.com', 'aria-label': 'Public HTTPS URL' });
  const port = h('input', { type: 'number', min: 1024, max: 65535, value: s.port, 'aria-label': 'Local port' });
  const save = (enabled) => async () => {
    try {
      await api('/api/settings/remote', { method: 'PUT', body: { enabled, publicUrl: url.value, port: Number(port.value) } });
      await renderRemote();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  const pairing = status.pairing;
  const minutes = pairing ? Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
  const copy = (value) => () => navigator.clipboard?.writeText(value).then(() => toast('Copied.'), () => toast(value));
  $('#remote-panel').replaceChildren(h('section.panel.remote-card', {},
    h('p.muted', {}, 'Lets claude.ai connectors and ChatGPT apps use Lumina while this app is open. Your keys and files stay on this computer; you expose one local port through an HTTPS tunnel you control, and approve each new connection with a pairing code.'),
    h('ol.remote-steps', {},
      h('li', {}, 'Start a tunnel to ', h('code', {}, `http://127.0.0.1:${s.port}`), ' — for example ', h('code', {}, `cloudflared tunnel --url http://127.0.0.1:${s.port}`), ', ', h('code', {}, `tailscale funnel ${s.port}`), ' or ', h('code', {}, `ngrok http ${s.port}`), '.'),
      h('li', {}, 'Paste the tunnel\'s https:// address below and turn remote access on.'),
      h('li', {}, 'In claude.ai, add a custom connector (Settings → Connectors). In ChatGPT, turn on developer mode and add a custom MCP connector. Use the connector URL shown below.'),
      h('li', {}, 'When the approval page opens, enter the pairing code from here.')),
    h('div.remote-grid', {},
      h('label', {}, h('span.field-label', {}, 'PUBLIC HTTPS URL (YOUR TUNNEL)'), url),
      h('label', {}, h('span.field-label', {}, 'LOCAL PORT'), port)),
    h('div.key-row', {},
      status.running
        ? h('button.button.secondary.small', { onclick: save(false) }, 'Turn off')
        : h('button.button.primary.small', { onclick: save(true) }, 'Turn on remote access'),
      status.running ? h('button.button.secondary.small', { onclick: save(true) }, 'Save changes') : null,
      h('span.badge' + (status.running ? '.ok' : ''), {}, status.running ? 'Running' : 'Off')),
    status.error ? h('p.error-text', {}, status.error) : null,
    status.running ? h('div.remote-url', {}, h('span.field-label', {}, 'CONNECTOR URL'), h('code', {}, status.url), h('button.text-button', { onclick: copy(status.url) }, 'Copy')) : null,
    status.running ? h('div.remote-url', {},
      h('span.field-label', {}, 'PAIRING CODE'),
      pairing ? h('code.pairing-code', {}, pairing.code) : h('span.muted', {}, 'none active'),
      pairing ? h('span.muted', {}, `single use · expires in ~${minutes} min`) : null,
      h('button.button.secondary.small', { onclick: async () => { await api('/api/settings/remote/pairing', { method: 'POST', body: {} }); await renderRemote(); } }, pairing ? 'New code' : 'Show a pairing code')) : null,
    h('div.key-row', {},
      h('span.muted', {}, `${status.clients} connected client(s) · ${status.activeTokens} active session(s)`),
      h('button.text-button.danger', { disabled: !status.clients, onclick: async () => {
        if (!confirm('Disconnect every remote client? They will need a new pairing code to reconnect.')) return;
        await api('/api/settings/remote/revoke', { method: 'POST', body: {} });
        await renderRemote();
      } }, 'Disconnect all')),
    h('p.muted.small-print', {}, 'Anyone who connects can spend your provider credits, so only approve connections you started yourself. Remote tools can\'t write files outside Lumina\'s exports folder.')));
  clearTimeout(remoteTimer);
  if (status.running && pairing) remoteTimer = setTimeout(() => renderRemote().catch(() => {}), 30_000);
}

export function initSettings() {
  on('tab', (tab) => {
    if (tab === 'settings') Promise.all([render(), renderRemote()]).catch((error) => toast(error.message, 'error'));
    else clearTimeout(remoteTimer);
  });
}
