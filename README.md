# Lumina Studio

Lumina Studio is a private-first workspace for turning visual ideas into images. It brings prompt writing, optional AI creative direction, image generation and editing, project history, references, and a canvas-oriented workflow into one small web app.

> **Current status:** This is an early foundation. Project creation, generation history, reference uploads, image generation/edit requests, prompt refinement, and basic library/canvas views are implemented. The canvas is currently a UI shell; executable node graphs, authentication, database-backed storage, and team access are not implemented yet.

## Features

- Create and switch between projects.
- Generate images through OpenAI's Images API from the server.
- Optionally refine prompts with NVIDIA Nemotron using NVIDIA's hosted endpoint or a configurable OpenAI-compatible endpoint.
- Upload PNG, JPEG, and WebP references (up to 8 MB) and use them for edits.
- Create variations from generated images.
- Persist projects, generation history, and assets locally.
- Browse previous generations and download results.
- Keep provider API keys on the server; keys are never sent to browser code.

## Requirements

- Node.js 20.6 or newer.
- An OpenAI API key to generate or edit images.
- An NVIDIA API key is optional and only needed for Nemotron prompt refinement.

No npm packages are required for the current implementation.

## Quick start

```sh
cp .env.example .env
```

Add your provider keys to `.env`:

```dotenv
OPENAI_API_KEY=your-openai-api-key
NEMOTRON_API_KEY=your-nvidia-api-key
```

Then start the app:

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). Without `OPENAI_API_KEY`, you can explore the interface and project features, but generation requests will return a setup error.

For development with automatic server restarts:

```sh
npm run dev
```

Check JavaScript syntax with:

```sh
npm run check
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | For image generation | — | Server-side key for the OpenAI Images API. |
| `OPENAI_IMAGE_MODEL` | No | `gpt-image-1` | OpenAI image model name. |
| `NEMOTRON_API_KEY` | No | — | Enables Nemotron prompt refinement. |
| `NEMOTRON_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible Nemotron API base URL; set this for a self-hosted endpoint. |
| `NEMOTRON_MODEL` | No | `nvidia/nemotron-3.5-lightning-30b-a3b` | Chat model identifier sent to the configured Nemotron endpoint. |
| `PORT` | No | `4173` | HTTP server port. |
| `NEXT_PUBLIC_APP_URL` | No | `http://localhost:4173` | Reserved for application URL configuration. |
| `DATABASE_URL` | No | — | Reserved for a future database adapter. |
| `STORAGE_PROVIDER` | No | `local` | Reserved for a future storage adapter. |
| `STORAGE_BUCKET` | No | — | Reserved for object storage configuration. |
| `STORAGE_ENDPOINT` | No | — | Reserved for object storage configuration. |

The `npm start` and `npm run dev` scripts load `.env` when present through Node’s built-in environment-file support. Variables already set in the shell also work.

## Data and storage

The current local adapter stores metadata in JSON files under `data/` and image files under `storage/assets/`. These runtime files are ignored by Git. Back up both directories if you need to preserve local projects and generated assets. This storage approach is intended for local development and a single user; it is not a substitute for a production database or private object storage.

## API routes

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Checks server status and reports whether provider keys are configured. |
| `GET` | `/api/projects` | Lists projects. |
| `POST` | `/api/projects` | Creates a project. JSON body: `{ "name": "Campaign" }`. |
| `GET` | `/api/projects/:id` | Loads a project, generations, and assets. |
| `GET` | `/api/projects/:id/generations` | Lists a project's generations. |
| `POST` | `/api/projects/assets` | Saves a validated reference image. |
| `POST` | `/api/generate` | Generates an image, optionally using a reference/source image and Nemotron refinement. |
| `GET` | `/api/generations/:id` | Reads generation status and result metadata. |

`POST /api/generate` accepts `projectId`, `prompt`, optional `size` (`1024x1024`, `1536x1024`, or `1024x1536`), optional `quality` (`low`, `medium`, or `high`), and optional `enhance`, `referenceDataUrl`, `sourceAssetId`, and `operation` (`variation` or `edit`).

## Architecture

- `server.js` contains the HTTP API, local JSON/file storage, request validation, rate limiting, and provider adapters.
- `public/` contains the browser UI and client-side interactions.
- OpenAI image generation and edits use the Images API from the server.
- Nemotron uses an OpenAI-compatible chat-completions endpoint from the server.
- Generated output is saved as a local asset and linked to the project generation history.

## Security notes

- Keep `.env` out of version control. Never put provider keys in `public/` or browser code.
- The current server is designed for local single-user use. It does not yet provide authentication, per-user authorization, or isolation between users.
- Do not expose this development server directly to the public internet. Add authentication and durable private storage before deploying it for multiple users.
- Generation endpoints are rate limited in memory; the limit resets when the server restarts.

## Roadmap

1. Foundation: project system, storage abstraction, and workspace shell.
2. Image generation: provider integration, secure API routes, persistence, and history.
3. Creative direction: Nemotron refinement and prompt compilation.
4. References and editing: uploads, edits, and variations.
5. Canvas: persisted node graphs and connected workflow execution.
6. Polish: accessibility, responsive behavior, observability, and broader validation.
