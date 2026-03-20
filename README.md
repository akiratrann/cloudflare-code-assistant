# Cloudflare Code Assistant

## Submission checklist

- **Repository name:** For formal submission, the GitHub repository should be named with the **`cf_ai_`** prefix (e.g. `cf_ai_cloudflare-code-assistant`). If yours differs, use **GitHub → Settings → General → Repository name** to rename, or create a new repo with that name and push this tree.
- **Documentation:** This **`README.md`** describes the project and how to run it locally (and test components).
- **AI prompts used:** See **`PROMPTS.md`** (and the word-for-word user prompt log in **`prompt.txt`**).
- **Deployed demo (optional):** After `npx wrangler deploy` in `worker/`, add your `*.workers.dev` (or Pages) URL here if you want reviewers to try without cloning.

---

An **agentic coding assistant** that runs on **Cloudflare’s edge**: the Worker is your **orchestration layer**—it holds prompts, calls **Workers AI**, reads and writes **KV** for memory and collaboration, and serves a **Cursor-style** web UI. The goal is the same class of product as “AI in the IDE,” but with **state and inference living at the edge** next to Cloudflare’s network.

> **Cloudflare Agents** (the [Agents SDK](https://developers.cloudflare.com/agents/) / Durable Objects–backed runtime) is the next step up for tool loops, scheduling, and richer agent memory. This repo implements **agent-style behavior in a Worker today**: explicit orchestration in `worker/src/index.ts`, plus KV-backed sessions, users, shared projects, and synced workspace state—patterns that map cleanly onto a dedicated Agent when you want to migrate.

---

## What you get

| Capability | How it uses Cloudflare |
|------------|-------------------------|
| **Chat & completions** | `env.AI.run()` with Llama 3.3 (fp8-fast); system prompts for edits vs. Q&A |
| **Session memory** | KV: chat history per `sessionId`, trimmed for context window |
| **Accounts** | Signup / login; session tokens and users in KV |
| **Workspace sync** | Logged-in users: full UI state (projects, files, chats) persisted to KV via `/api/user-state` |
| **Collaboration** | Share a project **to a username**; recipients load **incoming** shares; owners see **outgoing** shares—same KV, no public “guess my username” import |
| **Shared projects & context** | Imported copies get **empty chat UI**; owner’s prior chat can still be injected **server-side** for questions about history |
| **Editor integration** | Active file sent with messages; guarded **full-file replace** when you ask to remove/rewrite code; append mode for additive snippets |

Frontend: **React + Vite** (`app/`), VS Code–like shell (sidebar, tabs, Monaco). Dev proxy: `/api` → Worker on `8787`.

---

## Architecture (high level)

```
Browser (localhost:5173)
    │  fetch /api/*
    ▼
Cloudflare Worker (wrangler dev → :8787)
    ├── Workers AI ............... model + system/orchestration
    ├── KV (SESSION_KV) ........ sessions, users, projects, user-state blobs, share indexes
    └── CORS + JSON APIs ....... /api/chat, /api/login, /api/signup, /api/projects, /api/user-state
```

**Why this fits “edge agent” thinking:** all **durable, per-user and per-session state** that the assistant needs can stay in **KV** (or later D1 / Durable Objects) with **single-digit-ms reads** at the edge. The Worker decides **what** goes to the model and **what** to persist—classic **orchestration** without shipping prompts or secrets to the browser.

---

## Quick start

```bash
# 1) KV namespace (once per Cloudflare account — copy id into worker/wrangler.toml)
cd worker
npm install
npx wrangler kv namespace create SESSION_KV

# 2) Run the Worker (remote AI needs wrangler login + workers.dev setup; use --local for offline fallback)
npx wrangler dev --port 8787
# or: npx wrangler dev --local --port 8787

# 3) Run the UI
cd ../app
npm install
npm run dev -- --port 5173
```

Open **http://localhost:5173**. Ensure the Worker is on **8787** (see `app/vite.config.ts`).

**After changing KV binding or clearing KV:** log **out** and **in** again so session tokens exist in the new namespace.

---

## Project layout

| Path | Purpose |
|------|---------|
| `worker/` | Worker source, `wrangler.toml`, npm scripts |
| `worker/src/index.ts` | Routes, chat orchestration, AI call, KV access |
| `app/` | Vite + React UI, Monaco, sharing & auth flows |
| `PROMPTS.md` | AI prompts used (assignment) + pointer to `prompt.txt` |
| `prompt.txt` | Word-for-word user prompts during development |
| `.vscode/tasks.json` | Optional: open app in Simple Browser |

---

## API overview

| Method | Path | Auth | Role |
|--------|------|------|------|
| POST | `/api/signup`, `/api/login` | — | Create user / issue Bearer token |
| POST | `/api/chat` | —* | Chat; optional `projectId` + `chatId` for shared-project owner history |
| GET/POST | `/api/user-state` | Bearer | Load / save workspace JSON for user |
| POST | `/api/projects` | Bearer | Snapshot project + `shareWith` username |
| GET | `/api/projects?list=sharing` | Bearer | `{ incoming, outgoing }` share lists |
| GET | `/api/projects/:id` | — | Fetch shared snapshot (for Open) |

\*Chat is not token-gated today; `sessionId` is client-provided—tighten for production.

---

## Configuration

- **`worker/wrangler.toml`** — `SESSION_KV` id, `[ai]` binding (`remote = true` uses real Workers AI in dev).
- **`app/vite.config.ts`** — `server.proxy['/api']` → `http://127.0.0.1:8787`.

---

## Tests & quality

```bash
cd app
npm run lint
npm run build
npm run test:e2e   # Playwright; run Worker separately for live chat

cd ../worker
npx tsc --noEmit
```

---

## Roadmap (toward full Cloudflare Agents)

- Adopt **[Cloudflare Agents](https://developers.cloudflare.com/agents/)** for long-lived runs, WebSockets, and first-class tool/MCP patterns.
- Add **Vectorize** or embeddings for semantic codebase search.
- Optional **Durable Objects** for per-user chat “rooms” with stronger consistency than KV alone.

---

## License & attribution

Built as a **Cloudflare-native** coding assistant demo: Workers AI + KV + a thin React shell. Extend and deploy under your own account policies.
