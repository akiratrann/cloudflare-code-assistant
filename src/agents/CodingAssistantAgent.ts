import type { Env } from "../env";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface AgentStoredState {
  projectId: string;
  repoOwner: string;
  repoName: string;
  messages: ChatMessage[];
  notes: string[];
}

export class CodingAssistantAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private data: AgentStoredState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async loadState(): Promise<AgentStoredState> {
    if (this.data) return this.data;
    const stored = await this.state.storage.get<AgentStoredState>("state");
    if (stored) {
      this.data = stored;
      return stored;
    }
    const initial: AgentStoredState = {
      projectId: "",
      repoOwner: "",
      repoName: "",
      messages: [],
      notes: [],
    };
    this.data = initial;
    return initial;
  }

  private async saveState() {
    if (!this.data) return;
    await this.state.storage.put("state", this.data);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "POST" && pathname.endsWith("/chat")) {
      return this.handleChat(request);
    }

    if (request.method === "POST" && pathname.endsWith("/snapshot")) {
      return this.handleSnapshot(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleChat(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as
      | {
          projectId?: string;
          repoOwner?: string;
          repoName?: string;
          message?: string;
        }
      | null;

    if (!body || !body.message || !body.projectId || !body.repoOwner || !body.repoName) {
      return new Response("Invalid request", { status: 400 });
    }

    const state = await this.loadState();
    state.projectId = body.projectId;
    state.repoOwner = body.repoOwner;
    state.repoName = body.repoName;

    const userMsg: ChatMessage = {
      role: "user",
      content: body.message,
      timestamp: Date.now(),
    };
    state.messages.push(userMsg);

    const history = this.buildPromptHistory(state);
    const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: history,
    } as any);

    const assistantContent =
      (response as any)?.response ?? (response as any)?.result ?? JSON.stringify(response);

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: assistantContent,
      timestamp: Date.now(),
    };
    state.messages.push(assistantMsg);
    this.data = state;
    await this.saveState();

    return new Response(
      JSON.stringify({
        reply: assistantContent,
        messages: state.messages,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  private buildPromptHistory(state: AgentStoredState) {
    const system: ChatMessage = {
      role: "system",
      content:
        "You are a Cloudflare-based coding assistant. You help work on a GitHub repo for the user, keep track of project context, and answer concisely unless asked for more detail.",
      timestamp: Date.now(),
    };

    const recent = state.messages.slice(-20);
    const messages = [system, ...recent];

    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  private async handleSnapshot(request: Request): Promise<Response> {
    const state = await this.loadState();

    if (!state.repoOwner || !state.repoName || !state.messages.length) {
      return new Response("Nothing to snapshot yet", { status: 400 });
    }

    const gitToken = this.env.GITHUB_TOKEN;
    if (!gitToken) {
      return new Response("Missing GITHUB_TOKEN binding", { status: 500 });
    }

    const summary = await this.summarizeConversation(state);
    const path = `.cf-assistant/history/${Date.now()}.md`;

    await this.commitFileToGitHub({
      repoOwner: state.repoOwner,
      repoName: state.repoName,
      path,
      content: summary,
      token: gitToken,
    });

    return new Response(
      JSON.stringify({ status: "ok", path }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  private async summarizeConversation(state: AgentStoredState): Promise<string> {
    const lastMessages = state.messages.slice(-50);
    const text = lastMessages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    const prompt = `Summarize the following coding assistant conversation into a concise markdown file capturing key decisions, TODOs, and context. Be specific but brief.\n\n${text}`;

    const result = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You write concise technical summaries in Markdown." },
        { role: "user", content: prompt },
      ],
    } as any);

    const content =
      (result as any)?.response ?? (result as any)?.result ?? JSON.stringify(result);

    return `# Cloudflare Coding Assistant Session\n\n${content}\n`;
  }

  private async commitFileToGitHub(params: {
    repoOwner: string;
    repoName: string;
    path: string;
    content: string;
    token: string;
  }) {
    const { repoOwner, repoName, path, content, token } = params;
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${encodeURIComponent(
      path,
    )}`;

    const body = {
      message: `chore(cf-assistant): snapshot ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
    };

    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub commit failed: ${resp.status} ${text}`);
    }
  }
}

