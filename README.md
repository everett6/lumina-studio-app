# Lumina Studio

A private-first creative image workspace. The first implementation uses Node's built-in HTTP server, JSON metadata stores, and local file storage, so it runs without dependencies.

## Run

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` to enable image generation. Nemotron is optional; set `NEMOTRON_API_KEY` and optionally `NEMOTRON_BASE_URL` to enable prompt refinement.
2. Run `npm start` and open `http://localhost:4173`.

The API keys are read only by the server. Project and generation records are written under `data/`; uploaded and generated assets are stored under `storage/assets/`.

## Current API

- `GET /api/health`
- `GET, POST /api/projects`
- `GET /api/projects/:id`
- `GET /api/projects/:id/generations`
- `POST /api/projects/assets`
- `POST /api/generate` (supports optional Nemotron prompt refinement and reference/source images)
- `GET /api/generations/:id`

Image generation and edits use OpenAI's Images API. Nemotron prompt refinement uses an OpenAI-compatible chat completion endpoint. Provider details are configurable through environment variables.
