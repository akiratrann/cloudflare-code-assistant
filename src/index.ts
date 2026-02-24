import { CodingAssistantAgent } from "./agents/CodingAssistantAgent";
import type { Env } from "./env";

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cloudflare Coding Assistant</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; margin: 0; background: #050816; color: #e5e7eb; }
    .app { max-width: 960px; margin: 0 auto; padding: 24px 16px 40px; display: flex; flex-direction: column; gap: 16px; }
    .card { background: radial-gradient(circle at top, #111827, #020617); border-radius: 18px; border: 1px solid rgba(148, 163, 184, 0.35); box-shadow: 0 18px 60px rgba(15, 23, 42, 0.85); padding: 18px 18px 20px; backdrop-filter: blur(18px); }
    h1 { font-size: 1.35rem; margin: 0 0 4px; color: #e5e7eb; letter-spacing: -0.02em; }
    .subtitle { font-size: 0.78rem; color: #9ca3af; margin-bottom: 8px; }
    label { font-size: 0.75rem; color: #9ca3af; display: block; margin-bottom: 4px; }
    input { width: 100%; padding: 7px 9px; border-radius: 9px; border: 1px solid #1f2937; background: #020617; color: #e5e7eb; font-size: 0.8rem; }
    input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.6); }
    .row { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; margin-bottom: 6px; }
    .chat-box { height: 360px; padding: 10px 10px 4px; border-radius: 14px; border: 1px solid #111827; background: radial-gradient(circle at top left, #020617, #000); overflow-y: auto; font-size: 0.8rem; display: flex; flex-direction: column; gap: 4px; }
    .msg { padding: 6px 8px; border-radius: 10px; max-width: 82%; line-height: 1.35; white-space: pre-wrap; word-wrap: break-word; }
    .msg.user { align-self: flex-end; background: linear-gradient(135deg, #1d4ed8, #22c55e); color: white; }
    .msg.assistant { align-self: flex-start; background: #020617; border: 1px solid #1f2937; }
    .msg.system { align-self: center; background: transparent; color: #6b7280; font-size: 0.7rem; }
    form { display: flex; gap: 8px; margin-top: 8px; }
    textarea { flex: 1; resize: none; min-height: 40px; max-height: 80px; padding: 7px 9px; border-radius: 10px; border: 1px solid #1f2937; background: #020617; color: #e5e7eb; font-size: 0.8rem; }
    textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.6); }
    button { border: none; border-radius: 999px; padding: 0 14px; font-size: 0.8rem; background: linear-gradient(135deg, #3b82f6, #22c55e); color: white; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    button.secondary { background: transparent; border: 1px solid #374151; color: #d1d5db; }
    button:disabled { opacity: 0.5; cursor: default; }
    .pill { display: inline-flex; align-items: center; gap: 4px; font-size: 0.7rem; padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.4); color: #9ca3af; }
    .pill-dot { width: 7px; height: 7px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.2); }
    .actions { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; flex-wrap: wrap; }
    .small { font-size: 0.72rem; color: #6b7280; }
  </style>
</head>
<body>
  <div class="app">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
        <div>
          <h1>Cloudflare Coding Assistant</h1>
          <div class="subtitle">Project-scoped AI agent that remembers everything per GitHub repo, powered by Workers AI and Durable Objects.</div>
        </div>
        <div class="pill">
          <span class="pill-dot"></span>
          <span>LLM: Llama 3.3 · Workers AI</span>
        </div>
      </div>
      <div class="row">
        <div>
          <label>Project ID (any stable string per repo)</label>
          <input id="projectId" placeholder="e.g. akiratrann/cloudflare-code-assistant" />
        </div>
        <div>
          <label>GitHub owner</label>
          <input id="repoOwner" placeholder="e.g. akiratrann" />
        </div>
        <div>
          <label>GitHub repo</label>
          <input id="repoName" placeholder="e.g. cloudflare-code-assistant" />
        </div>
      </div>
      <div class="chat-box" id="chatBox"></div>
      <form id="chatForm">
        <textarea id="message" placeholder="Ask about your repo, decisions, TODOs…"></textarea>
        <button id="sendBtn" type="submit">Send</button>
      </form>
      <div class="actions">
        <button id="snapshotBtn" class="secondary" type="button">Snapshot → GitHub</button>
        <div class="small">Snapshots are saved under <code>.cf-assistant/history/</code> in your repo.</div>
      </div>
    </div>
  </div>
  <script>
    const form = document.getElementById("chatForm");
    const messageInput = document.getElementById("message");
    const chatBox = document.getElementById("chatBox");
    const projectIdInput = document.getElementById("projectId");
    const repoOwnerInput = document.getElementById("repoOwner");
    const repoNameInput = document.getElementById("repoName");
    const sendBtn = document.getElementById("sendBtn");
    const snapshotBtn = document.getElementById("snapshotBtn");

    function addMessage(role, content) {
      const div = document.createElement("div");
      div.className = "msg " + role;
      div.textContent = content;
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = messageInput.value.trim();
      const projectId = projectIdInput.value.trim();
      const repoOwner = repoOwnerInput.value.trim();
      const repoName = repoNameInput.value.trim();
      if (!text || !projectId || !repoOwner || !repoName) return;

      addMessage("user", text);
      messageInput.value = "";
      sendBtn.disabled = true;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, repoOwner, repoName, message: text }),
        });
        const data = await res.json();
        if (data && data.reply) {
          addMessage("assistant", data.reply);
        } else {
          addMessage("system", "No reply from model.");
        }
      } catch (err) {
        console.error(err);
        addMessage("system", "Request failed.");
      } finally {
        sendBtn.disabled = false;
      }
    });

    snapshotBtn.addEventListener("click", async () => {
      const projectId = projectIdInput.value.trim();
      const repoOwner = repoOwnerInput.value.trim();
      const repoName = repoNameInput.value.trim();
      if (!projectId || !repoOwner || !repoName) return;
      snapshotBtn.disabled = true;
      addMessage("system", "Creating snapshot in GitHub…");
      try {
        const res = await fetch("/api/snapshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, repoOwner, repoName }),
        });
        const data = await res.json();
        if (res.ok) {
          addMessage("system", "Snapshot saved at " + data.path);
        } else {
          addMessage("system", "Snapshot failed: " + (data || ""));
        }
      } catch (err) {
        console.error(err);
        addMessage("system", "Snapshot request failed.");
      } finally {
        snapshotBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = (await request.json().catch(() => null)) as
        | { projectId?: string; repoOwner?: string; repoName?: string; message?: string }
        | null;
      if (!body || !body.projectId) {
        return new Response("Missing projectId", { status: 400 });
      }
      const id = env.CODING_ASSISTANT_AGENT.idFromName(body.projectId);
      const stub = env.CODING_ASSISTANT_AGENT.get(id);
      return stub.fetch(new Request(new URL("/chat", request.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/snapshot") {
      const body = (await request.json().catch(() => null)) as
        | { projectId?: string; repoOwner?: string; repoName?: string }
        | null;
      if (!body || !body.projectId) {
        return new Response("Missing projectId", { status: 400 });
      }
      const id = env.CODING_ASSISTANT_AGENT.idFromName(body.projectId);
      const stub = env.CODING_ASSISTANT_AGENT.get(id);
      return stub.fetch(new Request(new URL("/snapshot", request.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    return new Response("Not found", { status: 404 });
  },
};

export { CodingAssistantAgent };


