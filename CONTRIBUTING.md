# Contributing

Thanks for helping build Lumina Studio.

## Setup

```bash
npm install
npm test
npm run mock
```

`npm run mock` starts the dev server with an offline mock image provider, so every screen works without API keys.
Open the link it prints (it carries the local access token).

## Guidelines

- Keep the UI dependency-free: plain ES modules in `public/`, no build step, no inline scripts or styles (CSP).
- New behavior needs tests in `tests/` (Node's built-in test runner). Provider adapters are tested against faked
  HTTP (`fakeFetch` in `tests/helpers.js`); never call paid APIs in tests.
- Provider adapters follow the contract in `docs/ARCHITECTURE.md` and must map failures to the shared error
  categories.
- Don't claim a feature works in docs or UI until it has been exercised end to end.
- Don't copy other products' branding, assets, prompts or proprietary code.
- Never commit keys, `.env`, `data/`, `storage/assets/` or `dist/`.
