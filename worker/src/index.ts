export interface Env {
  AI: Ai;
  SESSION_KV: KVNamespace;
}

type Role = 'system' | 'user' | 'assistant';

interface ChatMessage {
  role: Role;
  content: string;
  timestamp: number;
}

interface ChatRequestBody {
  sessionId: string;
  message: string;
  projectId?: string;
  chatId?: string;
}

interface AuthRequestBody {
  username: string;
  password: string;
}

interface ProjectFilePayload {
  path: string;
  content: string;
}

interface ProjectChatPayload {
  id?: string;
  name: string;
  messages?: { role: Role; content: string; timestamp: number }[];
}

interface ProjectSaveRequestBody {
  name: string;
  files: ProjectFilePayload[];
  chats: ProjectChatPayload[];
  shareWith?: string;
}

interface UserStatePayload {
  state: unknown;
}

interface StoredProject {
  ownerId: string;
  name: string;
  files: ProjectFilePayload[];
  chats: ProjectChatPayload[];
  createdAt: number;
  sharedWith?: string[];
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_HISTORY_TURNS = 16;
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 1 day

const MAX_SHARE_MESSAGES_PER_CHAT = 120;
const MAX_SHARE_MESSAGE_CHARS = 24_000;
const MAX_SHARE_FILE_CHARS = 900_000;
const KV_VALUE_SOFT_LIMIT_BYTES = 24 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (url.pathname === '/api/signup' && request.method === 'POST') {
      return handleSignup(request, env);
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (url.pathname === '/api/user-state') {
      if (request.method === 'GET') {
        return handleUserStateGet(request, env);
      }
      if (request.method === 'POST') {
        return handleUserStateSave(request, env);
      }
    }

    const projectMatch = url.pathname.match(/^\/api\/projects(?:\/([a-f0-9-]+))?$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      if (request.method === 'POST' && !projectId) {
        return handleProjectSave(request, env);
      }
      if (request.method === 'GET' && projectId) {
        return handleProjectGet(projectId, env);
      }
      if (request.method === 'GET' && !projectId && url.searchParams.get('list') === 'sharing') {
        const viewer = await getUsernameFromToken(request, env);
        if (!viewer) {
          return json({ error: 'Unauthorized' }, 401);
        }
        return handleProjectSharingLists(viewer, env);
      }
      if (request.method === 'GET' && !projectId && url.searchParams.get('sharedWith') === 'me') {
        const viewer = await getUsernameFromToken(request, env);
        if (!viewer) {
          return json({ error: 'Unauthorized' }, 401);
        }
        return handleProjectListSharedWith(viewer, env);
      }
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      let sessionKey: string | undefined;
      let userMessage: ChatMessage | undefined;
      try {
        const body = (await request.json()) as Partial<ChatRequestBody>;
        if (!body.sessionId || !body.message) {
          return json({ error: 'sessionId and message are required' }, 400);
        }

        sessionKey = `session:${body.sessionId}`;
        const history = await loadHistory(env, sessionKey);

        userMessage = {
          role: 'user',
          content: body.message,
          timestamp: Date.now(),
        };

        let systemContent =
          'You are a coding assistant similar to Cursor, focused on helping with code, architecture, and debugging. You run on Cloudflare Workers AI, have limited context, and should be concise, explicit, and pragmatic. Prefer TypeScript and Cloudflare-native patterns when relevant.\n\n' +
          'ACTIVE FILE EDITS: The user message may include an active file path and full file contents. When the user asks to remove, delete, omit, strip, or stop including specific code (e.g. console.log lines), or to rewrite/refactor the file, you MUST include exactly ONE markdown code fence with the COMPLETE updated file — every line that should exist after the change, not a diff and not only the changed lines. A short fragment will overwrite their file and destroy code.\n\n' +
          'If you cannot return the entire file, do NOT use a code fence for a partial snippet; explain in prose and ask them to use Suggest edit or paste the full file.\n\n' +
          'For small additive suggestions at the end of the file (not removals), a short fenced snippet is OK.';
        if (body.projectId && body.chatId) {
          const partnerSummary = await loadPartnerHistorySummary(env, body.projectId, body.chatId);
          if (partnerSummary) {
            systemContent +=
              '\n\nThe user is viewing a shared copy of this project. Their chat panel starts empty, but the following is read-only prior conversation history from the original owner. Use it to answer questions about what was discussed, decisions made, or code that was explained. Do not repeat the entire history; integrate it only as needed.\n\n---\n' +
              partnerSummary +
              '\n---';
          }
        }

        const systemMessage: ChatMessage = {
          role: 'system',
          content: systemContent,
          timestamp: Date.now(),
        };

        const truncatedHistory = trimHistory(history, MAX_HISTORY_TURNS);
        const messagesForModel: { role: Role; content: string }[] = [
          systemMessage,
          ...truncatedHistory.map(({ role, content }) => ({ role, content })),
          { role: 'user', content: userMessage.content },
        ];

        const aiResponse = await env.AI.run(MODEL as any, {
          messages: messagesForModel,
        } as any);

        const replyText =
          (aiResponse as any)?.response ??
          (Array.isArray((aiResponse as any)?.choices)
            ? (aiResponse as any).choices[0]?.message?.content
            : '');

        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: replyText || 'Sorry, I was unable to generate a response.',
          timestamp: Date.now(),
        };

        const newHistory = [...truncatedHistory, userMessage, assistantMessage];
        await env.SESSION_KV.put(sessionKey, JSON.stringify(newHistory), {
          expirationTtl: 60 * 60 * 24 * 3,
        });

        return json(
          {
            reply: assistantMessage.content,
            messages: newHistory.map(({ role, content, timestamp }) => ({
              role,
              content,
              timestamp,
            })),
          },
          200,
        );
    } catch (err) {
      console.error('chat error', err);

      // If we have sessionKey and userMessage (error was after parsing, e.g. AI binding),
      // return fallback reply so local dev works without Workers AI.
      if (sessionKey != null && userMessage != null) {
        const fallbackText =
          'Local dev mode: Workers AI is not available here, ' +
          'but I received your message and active file context. ' +
          'When deployed with Workers AI enabled, this will be a real model response.';

        const fallbackAssistant: ChatMessage = {
          role: 'assistant',
          content: fallbackText,
          timestamp: Date.now(),
        };

        const newHistory = [...(await loadHistory(env, sessionKey)), userMessage, fallbackAssistant];
        await env.SESSION_KV.put(sessionKey, JSON.stringify(newHistory), {
          expirationTtl: 60 * 60 * 24 * 3,
        });

        return json(
          {
            reply: fallbackAssistant.content,
            messages: newHistory.map(({ role, content, timestamp }) => ({
              role,
              content,
              timestamp,
            })),
          },
          200,
        );
      }

      return json({ error: 'Chat request failed' }, 500);
    }
    }

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleSignup(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<AuthRequestBody>;
    if (!body.username || !body.password) {
      return json({ error: 'username and password are required' }, 400);
    }

    const username = body.username.trim().toLowerCase();
    if (!username) {
      return json({ error: 'username cannot be empty' }, 400);
    }

    const userKey = `user:${username}`;
    const existing = await env.SESSION_KV.get(userKey);
    if (existing) {
      return json({ error: 'Username already exists' }, 409);
    }

    const passwordHash = await hashPassword(body.password);
    await env.SESSION_KV.put(
      userKey,
      JSON.stringify({
        username,
        passwordHash,
      }),
    );

    const token = crypto.randomUUID();
    await env.SESSION_KV.put(`sessionToken:${token}`, username, {
      expirationTtl: SESSION_TTL_SECONDS,
    });

    return json(
      {
        username,
        token,
      },
      201,
    );
  } catch (err) {
    console.error('signup error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<AuthRequestBody>;
    if (!body.username || !body.password) {
      return json({ error: 'username and password are required' }, 400);
    }

    const username = body.username.trim().toLowerCase();
    const userKey = `user:${username}`;
    const rawUser = await env.SESSION_KV.get(userKey);
    if (!rawUser) {
      return json({ error: 'Invalid username or password' }, 401);
    }

    let record: { username: string; passwordHash: string };
    try {
      record = JSON.parse(rawUser) as { username: string; passwordHash: string };
    } catch {
      return json({ error: 'Invalid user record' }, 500);
    }

    const passwordHash = await hashPassword(body.password);
    if (passwordHash !== record.passwordHash) {
      return json({ error: 'Invalid username or password' }, 401);
    }

    const token = crypto.randomUUID();
    await env.SESSION_KV.put(`sessionToken:${token}`, username, {
      expirationTtl: SESSION_TTL_SECONDS,
    });

    return json(
      {
        username,
        token,
      },
      200,
    );
  } catch (err) {
    console.error('login error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

async function loadPartnerHistorySummary(
  env: Env,
  projectId: string,
  chatId: string,
): Promise<string | null> {
  const raw = await env.SESSION_KV.get(`project:${projectId}`);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredProject;
    const chat = stored.chats.find((c) => c.id === chatId);
    if (!chat?.messages?.length) return null;
    const lines: string[] = [];
    for (const m of chat.messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        const label = m.role === 'user' ? 'Owner' : 'Assistant';
        lines.push(`${label}: ${m.content}`);
      }
    }
    return lines.length ? lines.join('\n\n') : null;
  } catch {
    return null;
  }
}

async function loadHistory(env: Env, key: string): Promise<ChatMessage[]> {
  const raw = await env.SESSION_KV.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function trimHistory(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  if (messages.length <= maxTurns * 2) return messages;
  const startIndex = Math.max(0, messages.length - maxTurns * 2);
  return messages.slice(startIndex);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

async function getUsernameFromToken(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const username = await env.SESSION_KV.get(`sessionToken:${token}`);
  return username;
}

async function handleProjectSave(request: Request, env: Env): Promise<Response> {
  const username = await getUsernameFromToken(request, env);
  if (!username) {
    return json({ error: 'Unauthorized' }, 401);
  }
  try {
    const body = (await request.json()) as Partial<ProjectSaveRequestBody>;
    if (!body.name || !Array.isArray(body.files) || !Array.isArray(body.chats)) {
      return json({ error: 'name, files, and chats are required' }, 400);
    }
    const shareWith = body.shareWith?.trim().toLowerCase();
    if (shareWith && !/^[a-z0-9._-]{1,64}$/.test(shareWith)) {
      return json(
        {
          error:
            'Share target username may only use letters, numbers, dots, underscores, and hyphens (1–64 characters).',
        },
        400,
      );
    }
    const projectId = crypto.randomUUID();
    const stored: StoredProject = {
      ownerId: username,
      name: String(body.name).slice(0, 500),
      files: body.files.map((f) => ({
        path: String(f.path ?? '').slice(0, 1024),
        content: String(f.content ?? '').slice(0, MAX_SHARE_FILE_CHARS),
      })),
      chats: body.chats.map((c) => ({
        id: c.id,
        name: (c.name ?? 'Chat').slice(0, 200),
        messages: Array.isArray(c.messages)
          ? c.messages.slice(-MAX_SHARE_MESSAGES_PER_CHAT).map((m) => ({
              role:
                m.role === 'assistant' || m.role === 'user' || m.role === 'system'
                  ? m.role
                  : 'user',
              content: (typeof m.content === 'string' ? m.content : '').slice(0, MAX_SHARE_MESSAGE_CHARS),
              timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
            }))
          : [],
      })),
      createdAt: Date.now(),
      sharedWith: shareWith ? [shareWith] : [],
    };
    const projectJson = JSON.stringify(stored);
    if (projectJson.length > KV_VALUE_SOFT_LIMIT_BYTES) {
      return json(
        {
          error: 'Project is too large to share (KV limit). Remove large files or clear old chat messages and try again.',
        },
        413,
      );
    }
    await env.SESSION_KV.put(`project:${projectId}`, projectJson);

    const listKey = `userProjects:${username}`;
    const existingList = await env.SESSION_KV.get(listKey);
    let ids: string[] = [];
    if (existingList) {
      try {
        ids = JSON.parse(existingList) as string[];
        if (!Array.isArray(ids)) ids = [];
      } catch {
        ids = [];
      }
    }
    ids.push(projectId);
    await env.SESSION_KV.put(listKey, JSON.stringify(ids));

    if (shareWith) {
      const sharedKey = `sharedWith:${shareWith}`;
      const existingShared = await env.SESSION_KV.get(sharedKey);
      let sharedIds: string[] = [];
      if (existingShared) {
        try {
          sharedIds = JSON.parse(existingShared) as string[];
          if (!Array.isArray(sharedIds)) sharedIds = [];
        } catch {
          sharedIds = [];
        }
      }
      sharedIds.push(projectId);
      await env.SESSION_KV.put(sharedKey, JSON.stringify(sharedIds));

      const outKey = `outgoingShares:${username.trim().toLowerCase()}`;
      const outRaw = await env.SESSION_KV.get(outKey);
      let outgoing: { projectId: string; name: string; sharedWith: string; createdAt: number }[] = [];
      if (outRaw) {
        try {
          outgoing = JSON.parse(outRaw) as typeof outgoing;
          if (!Array.isArray(outgoing)) outgoing = [];
        } catch {
          outgoing = [];
        }
      }
      outgoing.push({
        projectId,
        name: body.name,
        sharedWith: shareWith,
        createdAt: Date.now(),
      });
      await env.SESSION_KV.put(outKey, JSON.stringify(outgoing));
    }

    return json({ projectId, username, sharedWith: shareWith ?? null }, 201);
  } catch (err) {
    console.error('project save error', err);
    const detail = err instanceof Error ? err.message : String(err);
    return json(
      {
        error: 'Could not save project to storage (KV).',
        detail,
        hint:
          'If you see this in dev: run `cd worker && npx wrangler kv namespace create SESSION_KV`, put the returned id in wrangler.toml as SESSION_KV id, or use `npx wrangler dev --local --port 8787` for a local KV.',
      },
      500,
    );
  }
}

async function handleProjectGet(projectId: string, env: Env): Promise<Response> {
  const raw = await env.SESSION_KV.get(`project:${projectId}`);
  if (!raw) {
    return json({ error: 'Project not found' }, 404);
  }
  try {
    const stored = JSON.parse(raw) as StoredProject;
    return json({
      id: projectId,
      ownerId: stored.ownerId,
      name: stored.name,
      files: stored.files,
      chats: stored.chats,
      createdAt: stored.createdAt,
    });
  } catch {
    return json({ error: 'Invalid project' }, 500);
  }
}

async function handleProjectListByOwner(owner: string, env: Env): Promise<Response> {
  const listKey = `userProjects:${owner.trim().toLowerCase()}`;
  const raw = await env.SESSION_KV.get(listKey);
  if (!raw) {
    return json({ projects: [] });
  }
  let ids: string[] = [];
  try {
    ids = JSON.parse(raw) as string[];
    if (!Array.isArray(ids)) ids = [];
  } catch {
    return json({ projects: [] });
  }
  const projects: { id: string; name: string }[] = [];
  for (const id of ids) {
    const p = await env.SESSION_KV.get(`project:${id}`);
    if (p) {
      try {
        const parsed = JSON.parse(p) as StoredProject;
        projects.push({ id, name: parsed.name });
      } catch {
        // skip
      }
    }
  }
  return json({ projects });
}

async function getIncomingProjectsForUser(username: string, env: Env): Promise<{ id: string; name: string; ownerId: string }[]> {
  const listKey = `sharedWith:${username.trim().toLowerCase()}`;
  const raw = await env.SESSION_KV.get(listKey);
  if (!raw) {
    return [];
  }
  let ids: string[] = [];
  try {
    ids = JSON.parse(raw) as string[];
    if (!Array.isArray(ids)) ids = [];
  } catch {
    return [];
  }
  const projects: { id: string; name: string; ownerId: string }[] = [];
  for (const id of ids) {
    const p = await env.SESSION_KV.get(`project:${id}`);
    if (p) {
      try {
        const parsed = JSON.parse(p) as StoredProject;
        projects.push({ id, name: parsed.name, ownerId: parsed.ownerId });
      } catch {
        // skip
      }
    }
  }
  return projects;
}

async function handleProjectListSharedWith(username: string, env: Env): Promise<Response> {
  const projects = await getIncomingProjectsForUser(username, env);
  return json({ projects });
}

async function handleProjectSharingLists(viewer: string, env: Env): Promise<Response> {
  const incoming = await getIncomingProjectsForUser(viewer, env);
  const outKey = `outgoingShares:${viewer.trim().toLowerCase()}`;
  const outRaw = await env.SESSION_KV.get(outKey);
  let outgoingRecords: { projectId: string; name: string; sharedWith: string; createdAt: number }[] = [];
  if (outRaw) {
    try {
      outgoingRecords = JSON.parse(outRaw) as typeof outgoingRecords;
      if (!Array.isArray(outgoingRecords)) outgoingRecords = [];
    } catch {
      outgoingRecords = [];
    }
  }
  const outgoing: { id: string; name: string; sharedWith: string }[] = [];
  for (const r of outgoingRecords) {
    const raw = await env.SESSION_KV.get(`project:${r.projectId}`);
    if (raw) {
      outgoing.push({ id: r.projectId, name: r.name, sharedWith: r.sharedWith });
    }
  }
  return json({ incoming, outgoing });
}

async function handleUserStateSave(request: Request, env: Env): Promise<Response> {
  const username = await getUsernameFromToken(request, env);
  if (!username) {
    return json({ error: 'Unauthorized' }, 401);
  }
  try {
    const body = (await request.json()) as Partial<UserStatePayload>;
    if (body.state == null) {
      return json({ error: 'state is required' }, 400);
    }
    const key = `userState:${username}`;
    await env.SESSION_KV.put(key, JSON.stringify(body.state));
    return json({ ok: true }, 200);
  } catch (err) {
    console.error('user state save error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

async function handleUserStateGet(request: Request, env: Env): Promise<Response> {
  const username = await getUsernameFromToken(request, env);
  if (!username) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const key = `userState:${username}`;
  const raw = await env.SESSION_KV.get(key);
  if (!raw) {
    return json({ state: null }, 200);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return json({ state: parsed }, 200);
  } catch {
    return json({ state: null }, 200);
  }
}

