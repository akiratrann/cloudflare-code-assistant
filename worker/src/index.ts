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
  name: string;
}

interface ProjectSaveRequestBody {
  name: string;
  files: ProjectFilePayload[];
  chats: ProjectChatPayload[];
}

interface StoredProject {
  ownerId: string;
  name: string;
  files: ProjectFilePayload[];
  chats: ProjectChatPayload[];
  createdAt: number;
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct';
const MAX_HISTORY_TURNS = 16;
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 1 day

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

    const projectMatch = url.pathname.match(/^\/api\/projects(?:\/([a-f0-9-]+))?$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      if (request.method === 'POST' && !projectId) {
        return handleProjectSave(request, env);
      }
      if (request.method === 'GET' && projectId) {
        return handleProjectGet(projectId, env);
      }
      if (request.method === 'GET' && !projectId && url.searchParams.get('owner')) {
        return handleProjectListByOwner(url.searchParams.get('owner')!, env);
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

        const systemMessage: ChatMessage = {
          role: 'system',
          content:
            'You are a coding assistant similar to Cursor, focused on helping with code, architecture, and debugging. You run on Cloudflare Workers AI, have limited context, and should be concise, explicit, and pragmatic. Prefer TypeScript and Cloudflare-native patterns when relevant.',
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

    return new Response('Not found', {
      status: 404,
      headers: corsHeaders(),
    });
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
    const projectId = crypto.randomUUID();
    const stored: StoredProject = {
      ownerId: username,
      name: body.name,
      files: body.files.map((f) => ({ path: f.path ?? '', content: f.content ?? '' })),
      chats: body.chats.map((c) => ({ name: c.name ?? 'Chat' })),
      createdAt: Date.now(),
    };
    await env.SESSION_KV.put(`project:${projectId}`, JSON.stringify(stored));

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

    return json({ projectId, username }, 201);
  } catch (err) {
    console.error('project save error', err);
    return json({ error: 'Internal error' }, 500);
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

