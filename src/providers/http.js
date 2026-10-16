// Shared request helpers and the error vocabulary every provider adapter speaks.
export class ProviderError extends Error {
  constructor(category, message, { status, detail } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.status = status;
    this.detail = detail;
  }
}

const userMessages = {
  missing_key: 'Add an API key for this provider in Settings.',
  auth: 'The provider rejected the API key. Check it in Settings.',
  rate_limit: 'The provider is rate limiting requests or the account is out of credit. Wait, then try again.',
  policy: 'The provider declined this prompt or image. Try changing the wording.',
  invalid_request: 'The provider rejected these settings for this model.',
  timeout: 'The provider took too long to respond. Billing may be uncertain; check its activity page before confirming another paid request.',
  provider: 'The provider could not complete this request. Try again.',
};

export function userMessage(error) {
  const base = userMessages[error?.category] || userMessages.provider;
  // Provider detail helps with invalid requests (wrong size for a model etc.); keep it short.
  return error?.category === 'invalid_request' && error.detail ? `${base} (${String(error.detail).slice(0, 200)})` : base;
}

function categorize(status, text) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'rate_limit';
  if (/content[_ ]policy|safety|moderation|nsfw|blocked/i.test(text)) return 'policy';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  return 'provider';
}

function extractMessage(text) {
  try {
    const body = JSON.parse(text);
    return body?.error?.message || body?.detail?.[0]?.msg || body?.detail || body?.message || body?.error || text;
  } catch {
    return text;
  }
}

export async function request(url, { timeoutMs = 120_000, onSubmitting, onSubmitted, onRequestId, ...options } = {}) {
  let response;
  onSubmitting?.();
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new ProviderError('timeout', 'Request timed out');
    throw new ProviderError('provider', `Network error: ${error.message}`);
  }
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
  if (requestId) onRequestId?.({ id: requestId });
  if (!response.ok) {
    const text = await response.text();
    const detail = extractMessage(text);
    throw Object.assign(new ProviderError(categorize(response.status, text), `HTTP ${response.status}`, { status: response.status, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }), { confirmedUnbilled: options.method === 'POST' && [400, 401, 402, 403, 404, 422, 429].includes(response.status) });
  }
  onSubmitted?.({ id: requestId ?? null, resumable: false });
  return response;
}

export async function requestJson(url, options) {
  const read = async () => {
    const body = await (await request(url, options)).json();
    const id = body?.id ?? body?.name ?? body?.request_id;
    if (id) options?.onSubmitted?.({ id: String(id), resumable: false });
    return body;
  };
  return options?.method && options.method !== 'GET' ? read() : retryRead(read);
}

// Only reads are retried. A paid POST is deliberately never retried after a network/parse timeout.
export async function retryRead(read, { onFailure } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      onFailure?.(error);
      if (attempt >= 2) throw error;
      await sleep(100 * 2 ** attempt);
    }
  }
}

export async function downloadBytes(url, { timeoutMs = 120_000, headers, onCompleted, onDownloadFailed, usage } = {}) {
  return retryRead(async () => {
    onCompleted?.({ downloadUrl: url, usage: usage ?? null, resumable: true });
    if (!/^https:\/\//.test(url)) throw new ProviderError('provider', 'Provider returned a non-HTTPS result URL.');
    const response = await request(url, { timeoutMs, headers });
    return Buffer.from(await response.arrayBuffer());
  }, { onFailure: onDownloadFailed });
}

// Refuse an unusable recovery marker instead of falling back to another paid submission.
export function assertResumable(resumeJob, valid) {
  if (resumeJob && !valid) throw new ProviderError('provider', 'Saved provider request cannot be resumed safely. Check its billing; choose a local model.');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireKey(key) {
  if (!key) throw new ProviderError('missing_key', 'No API key configured');
  return key;
}

export const toDataUrl = (image) => `data:${image.mime};base64,${image.bytes.toString('base64')}`;

// Map Lumina's three canonical sizes onto each provider's aspect vocabulary.
export const aspectFor = (size) => ({ '1536x1024': '3:2', '1024x1536': '2:3' })[size] || '1:1';
