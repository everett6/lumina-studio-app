import { $, api, emit, h, on, toast } from './lib.js';

const keyProviders = [
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

export function initSettings() {
  on('tab', (tab) => { if (tab === 'settings') render().catch((error) => toast(error.message, 'error')); });
}
