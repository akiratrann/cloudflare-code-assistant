# AI prompts used

This file satisfies the submission requirement to document **prompts used with AI-assisted coding** (product direction, iteration, and what the app sends to Workers AI).

---

## 1. User → coding assistant (requirements & iteration)

The **full, word-for-word** log of prompts typed into the assistant during this project lives in **`prompt.txt`** at the repo root (including the initial assignment brief, feature requests, UX notes, and testing asks). Open that file for the complete chronological list.

**Topics covered there include:**

- Cursor-like coding assistant on Cloudflare (Workers AI, orchestration, memory, VS Code–style UI).
- Alignment with optional assignment components (LLM, workflow/coordination, chat UI, state).
- Playwright / exhaustive testing requests.
- IDE features: projects, chats, files, add/remove files, sharing, auth, layout (Chat/Editor tabs), inline suggestions, syntax highlighting, copy/paste, hover actions, etc.

---

## 2. Application → Workers AI (runtime system prompt)

Defined in `worker/src/index.ts` when handling `POST /api/chat`. Paraphrased structure:

- **Role:** Coding assistant similar to Cursor; concise; pragmatic; TypeScript / Cloudflare patterns when relevant; limited context on the edge.
- **Active file edits:** When the user asks to remove/rewrite/refactor, the model must return **exactly one** markdown fence with the **complete** updated file (not a diff or partial snippet), or avoid a fence and explain if it cannot return the full file. Short fenced snippets are OK only for small **additive** changes at the end of a file.
- **Shared projects:** If `projectId` + `chatId` are sent and a partner history summary exists in KV, an extra system block explains that the user sees a shared copy with an empty chat UI but may receive **read-only owner chat history** server-side to answer questions about prior discussion.

*(Exact string is in source; keep in sync with `worker/src/index.ts`.)*

---

## 3. Client-built prompts (not the Worker system message)

These are assembled in **`app/src/App.tsx`** and sent as the **user** `message` to `/api/chat` (the Worker still prepends its system message above).

### Inline completion (debounced while editing)

- Prefix: *“You are a code completion assistant. Given the file below, suggest the next few lines of code. Respond with ONLY the suggested code, no explanation, and keep it under ~5 lines.”*
- Then: `File path: …`, *“Current file contents:”*, and the file body.

### “Suggest edit” action

- Combines a line like: *“You are a code-editing assistant. Given the current file, return ONLY the full updated file contents, with no explanation or commentary.”*
- Plus file path and current contents; the visible chat user line is shorter (*“Suggest an edit for …”*).

---

## 4. How this maps to the assignment

| Requirement | Where documented |
|-------------|------------------|
| AI-assisted coding encouraged | This repo; prompts above |
| **PROMPTS.md** | This file + **`prompt.txt`** |
| README run instructions | **`README.md`** → Quick start & tests |

---

## Repository naming (reviewers)

The submission asks for a GitHub repository name prefixed with **`cf_ai_`**. See **`README.md` → Submission checklist** for rename / clone naming notes.
