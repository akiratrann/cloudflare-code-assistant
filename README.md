# Cloudflare Code Assistant

A Cursor-like coding assistant running on Cloudflare: Workers AI (Llama 3.3), KV-backed memory, and a VSCode-style web UI. Built for the Cloudflare AI application assignment.

---

## Quick start

```bash
# Terminal 1 – Worker (API + AI + KV)
cd worker
npm install
npx wrangler kv:namespace create SESSION_KV   # once; put id in wrangler.toml
npx wrangler dev --local

# Terminal 2 – Frontend
cd app
npm install
npm run dev
```

Open the Vite URL (e.g. `http://localhost:5173`). Chat requests proxy to the Worker at `http://127.0.0.1:8787`.

---

## Project layout

| Path | Purpose |
|------|--------|
| `app/` | React + TypeScript (Vite) frontend: VSCode-style UI, chat, editor, auth |
| `worker/` | Cloudflare Worker: `/api/chat`, `/api/login`, `/api/signup`, KV + Workers AI |
| `prompt.txt` | Project requirements and your prompts (kept verbatim) |

---

## Progress checklist

Use this section to see what’s done and what’s optional. Update it as you go.

### Assignment requirements

- [x] **LLM** – Workers AI (Llama 3.3) via `env.AI.run()` in the Worker
- [x] **Workflow / coordination** – Worker orchestrates chat: validate input, load/trim KV history, call AI, persist history
- [x] **User input** – Chat UI in a VSCode-style layout (sidebar + main pane + right pane)
- [x] **Memory / state** – KV stores conversation history per `sessionId` (`userId:projectId:chatId`), 3-day TTL

### Features implemented

- [x] **Projects** – Create, switch, rename (hover), delete (hover)
- [x] **Chats** – Create, switch, rename (hover), delete (hover)
- [x] **Files** – Create, switch, rename (hover), copy path (hover), delete (hover); drag-and-drop to add files
- [x] **Editor + Chat side-by-side** – Editor (left) and Chat (right) visible at once, Cursor-style; active file content sent as context with each message
- [x] **Account** – Create account and Log in with username + password (Worker: signup/login, KV-backed users and session tokens)
- [x] **Sidebar hover actions** – Icon buttons (rename, delete; copy path for files) on project/chat/file rows
- [x] **Playwright e2e** – 3 tests: layout, send message, Worker-offline error handling
- [x] **Lint & build** – ESLint, Vite build, Worker `tsc --noEmit` all passing

- [x] **Project sharing by username** – Share current project (POST /api/projects, auth); import by username (GET /api/projects?owner=…), or open shared link (?project=id)

### Optional / not yet done
- [ ] **IDE tools** – e.g. dry-run linter, test-plan generator endpoints
- [ ] **Context controls** – Toggles for “include active file” / “include all files”; right-pane “context sent” preview
- [ ] **Chat API auth** – Verify session token on `/api/chat` (currently trusts client `sessionId`)

---

## How to run tests

```bash
# From repo root
cd app
npm run lint      # ESLint
npm run build     # TypeScript + Vite build
npm run test:e2e  # Playwright (starts dev server if needed; ensure Worker is running for real chat)
```

Worker type-check:

```bash
cd worker
npx tsc --noEmit
```

---

## Configuration

- **Worker** – `worker/wrangler.toml`: `main`, `compatibility_date`, `[ai]` binding, `[[kv_namespaces]]` (set `id` after `wrangler kv:namespace create SESSION_KV`).
- **Frontend** – `app/vite.config.ts`: dev proxy `/api` → `http://127.0.0.1:8787`.
- **Prompts / requirements** – Stored in `prompt.txt`; update it as you add or change requirements.

---

## Notes

- Chat history is keyed by **user + project + chat** so each combination has its own KV history.
- Logged-in user is stored in `localStorage` (`cf-assistant-auth-token`, `cf-assistant-auth-username`); when not logged in, `userId` is `guest`.
- Project/chat/file state lives in `localStorage` (`cf-assistant-state-v1`); no backend persistence for project structure yet.

*Last updated to match current codebase and progress.*
