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

let goingOnline = false;

// The Lumina account: one username and password for the website and for approving Claude or ChatGPT.
function accountPanel(account) {
  const field = (label, attrs) => {
    const input = h('input', { spellcheck: false, ...attrs });
    return [input, h('label', {}, h('span.field-label', {}, label), input)];
  };
  const [user, userLabel] = field('USERNAME', { type: 'text', value: account?.username ?? '', autocomplete: 'username', 'aria-label': 'Username' });
  const [current, currentLabel] = field('CURRENT PASSWORD', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const [pass, passLabel] = field(account?.configured ? 'NEW PASSWORD' : 'PASSWORD (10+ CHARACTERS)', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
  const [again, againLabel] = field('REPEAT PASSWORD', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat password' });
  const result = h('small.key-result');
  const save = async () => {
    result.textContent = '';
    if (pass.value !== again.value) {
      result.textContent = 'The passwords do not match.';
      result.dataset.tone = 'error';
      return;
    }
    try {
      await api('/api/settings/account', { method: 'PUT', body: { username: user.value, password: pass.value, currentPassword: current.value || undefined } });
      toast(account?.configured ? 'Password changed. Everything signed in before has been signed out.' : 'Account created.');
      await renderRemote();
    } catch (error) {
      result.textContent = error.message;
      result.dataset.tone = 'error';
    }
  };
  const form = h('div.remote-grid.account-grid', {}, userLabel, ...(account?.configured ? [currentLabel] : []), passLabel, againLabel);
  return h('section.panel.remote-card', {},
    h('div.key-head', {}, h('b', {}, 'Your Lumina account'), h(`span.badge${account?.configured ? '.ok' : ''}`, {}, account?.configured ? `Set up · ${account.username}` : 'Not set up')),
    h('p.muted', {}, account?.configured
      ? 'Sign in with this username and password on the Lumina website and when Claude or ChatGPT asks to connect. Changing the password signs everything out.'
      : 'Create a username and password. You will use them to sign in to the Lumina website and to approve Claude or ChatGPT. They are stored on this computer only (the password as a salted scrypt hash).'),
    account?.configured ? h('details', {}, h('summary', {}, 'Change username or password'), form, h('div.key-row', {}, h('button.button.secondary.small', { onclick: save }, 'Save'), result))
      : h('div', {}, form, h('div.key-row', {}, h('button.button.primary.small', { onclick: save }, 'Create account'), result)));
}

async function renderRemote() {
  const status = await api('/api/settings/remote');
  const s = status.settings;
  const hosted = s.hosted && status.running;
  const url = h('input', { type: 'text', value: hosted ? '' : s.publicUrl, placeholder: 'https://your-tunnel.example.com', 'aria-label': 'Public HTTPS URL' });
  const port = h('input', { type: 'number', min: 1024, max: 65535, value: s.port, 'aria-label': 'Local port' });
  const save = (enabled) => async () => {
    try {
      await api('/api/settings/remote', { method: 'PUT', body: { enabled, publicUrl: url.value, port: Number(port.value) } });
      await renderRemote();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  const goOnline = async (download = false) => {
    goingOnline = true;
    await renderRemote().catch(() => {});
    try {
      await api('/api/settings/remote/online', { method: 'POST', body: { download } });
      toast('Lumina is online.');
    } catch (error) {
      if (error.data?.needsAccount) {
        toast(error.message, 'error');
      } else if (error.data?.needsDownload && !download) {
        goingOnline = false;
        if (confirm('Hosting online uses Cloudflare\'s free "cloudflared" program (no account needed). It isn\'t installed.\n\nDownload it now from Cloudflare\'s official GitHub releases (about 40 MB) into Lumina\'s data folder?')) return goOnline(true);
      } else {
        toast(error.message, 'error');
      }
    } finally {
      goingOnline = false;
    }
    return renderRemote();
  };
  const copy = (value) => () => navigator.clipboard?.writeText(value).then(() => toast('Copied.'), () => toast(value));
  const accountCard = accountPanel(status.account);
  const tunnelState = status.tunnel?.state;
  const busy = goingOnline || ['downloading', 'starting'].includes(tunnelState);
  const oneClick = h('section.panel.remote-card.host-card', {},
    h('div.key-head', {}, h('b', {}, 'Host Lumina online'), h(`span.badge${hosted ? '.ok' : ''}`, {}, hosted ? 'Online' : busy ? 'Starting…' : 'Off')),
    h('p.muted', {}, 'One click gives Lumina a public https:// address through a free Cloudflare tunnel: open the website from any browser or phone, and add it to Claude (or ChatGPT) as a connector. Your keys and files stay on this computer, and it only works while Lumina is open.'),
    hosted ? h('div.remote-url', {}, h('span.field-label', {}, 'WEBSITE'), h('a', { href: status.site, target: '_blank', rel: 'noopener noreferrer' }, status.site), h('button.text-button', { onclick: copy(status.site) }, 'Copy')) : null,
    hosted ? h('div.remote-url', {}, h('span.field-label', {}, 'CLAUDE CONNECTOR URL'), h('code', {}, status.url), h('button.text-button', { onclick: copy(status.url) }, 'Copy')) : null,
    hosted ? h('ol.remote-steps', {},
      h('li', {}, `Website: open the address above and sign in as ${status.account?.username ?? 'your account'}.`),
      h('li', {}, 'Claude: claude.ai → Settings → Connectors → Add custom connector → paste the connector URL. ChatGPT: Settings → Apps & Connectors → developer mode → Create → paste the same URL. When the approval page opens, sign in with your Lumina account.'),
      h('li', {}, 'The address changes each time Lumina goes online, so re-add the connector after a restart.')) : null,
    h('div.key-row', {},
      hosted
        ? h('button.button.secondary.small', { onclick: async () => { await api('/api/settings/remote/offline', { method: 'POST', body: {} }); toast('Lumina is offline.'); await renderRemote(); } }, 'Take offline')
        : h('button.button.primary', { disabled: busy || !status.account?.configured, title: status.account?.configured ? '' : 'Create your Lumina account first', onclick: () => goOnline(false) }, busy ? (tunnelState === 'downloading' ? 'Downloading cloudflared…' : 'Going online…') : '🌐 Put Lumina online'),
      status.tunnel?.error && !hosted ? h('span.error-text', {}, status.tunnel.error) : null));

  const manual = h('details.panel.remote-card', { open: s.enabled && !s.hosted },
    h('summary', {}, h('b', {}, 'Use your own tunnel instead'), h('span.muted', {}, ' — for a permanent address (named Cloudflare tunnel, Tailscale Funnel, ngrok)')),
    h('ol.remote-steps', {},
      h('li', {}, 'Start a tunnel to ', h('code', {}, `http://127.0.0.1:${s.port}`), ' — for example ', h('code', {}, `tailscale funnel ${s.port}`), ' or ', h('code', {}, `ngrok http ${s.port}`), '.'),
      h('li', {}, 'Paste the tunnel\'s https:// address below and turn remote access on.'),
      h('li', {}, 'In claude.ai, add a custom connector (Settings → Connectors). In ChatGPT, turn on developer mode and add a custom MCP connector. Use the connector URL shown below.'),
      h('li', {}, 'When the approval page opens, sign in with your Lumina account.')),
    h('div.remote-grid', {},
      h('label', {}, h('span.field-label', {}, 'PUBLIC HTTPS URL (YOUR TUNNEL)'), url),
      h('label', {}, h('span.field-label', {}, 'LOCAL PORT'), port)),
    h('div.key-row', {},
      status.running && !hosted
        ? h('button.button.secondary.small', { onclick: save(false) }, 'Turn off')
        : h('button.button.secondary.small', { onclick: save(true) }, 'Turn on remote access'),
      status.running && !hosted ? h('button.button.secondary.small', { onclick: save(true) }, 'Save changes') : null),
    status.error ? h('p.error-text', {}, status.error) : null,
    status.running && !hosted ? h('div.remote-url', {}, h('span.field-label', {}, 'CONNECTOR URL'), h('code', {}, status.url), h('button.text-button', { onclick: copy(status.url) }, 'Copy')) : null,
    null);

  $('#remote-panel').replaceChildren(accountCard, oneClick, manual, h('section.panel.remote-card', {},
    h('div.key-row', {},
      h('span.muted', {}, `${status.clients} connected client(s) · ${status.activeTokens} active session(s) · ${status.webSessions ?? 0} website sign-in(s)`),
      h('button.text-button.danger', { disabled: !status.clients && !status.webSessions, onclick: async () => {
        if (!confirm('Disconnect every remote client and website sign-in? They will need to sign in again.')) return;
        await api('/api/settings/remote/revoke', { method: 'POST', body: {} });
        await renderRemote();
      } }, 'Disconnect all')),
    h('p.muted.small-print', {}, 'Anyone who signs in or connects can use your projects and spend your provider credits, so keep the password to yourself. Remote tools can\'t write files outside Lumina\'s exports folder.')));
  clearTimeout(remoteTimer);
  if (busy) remoteTimer = setTimeout(() => renderRemote().catch(() => {}), 2000);
}

export function initSettings() {
  on('tab', (tab) => {
    if (tab === 'settings') Promise.all([render(), renderRemote()]).catch((error) => toast(error.message, 'error'));
    else clearTimeout(remoteTimer);
  });
}
