import { type DragEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import './App.css'

type Role = 'user' | 'assistant'

interface Message {
  id: string
  role: Role
  content: string
  timestamp: number
}

interface VirtualFile {
  id: string
  path: string
  content: string
}

interface ChatSession {
  id: string
  name: string
  messages: Message[]
}

interface Project {
  id: string
  name: string
  files: VirtualFile[]
  chats: ChatSession[]
  activeChatId: string
  activeFileId?: string
  openFileIds?: string[]
  /** KV project id when this is a shared/imported copy; used to load owner's chat history for the model only */
  importedProjectId?: string
}

const USER_STORAGE_KEY = 'cf-assistant-user-id'
const AUTH_TOKEN_KEY = 'cf-assistant-auth-token'
const AUTH_USERNAME_KEY = 'cf-assistant-auth-username'

interface AppState {
  projects: Project[]
  activeProjectId: string
}

const STORAGE_KEY = 'cf-assistant-state-v1'

function detectLanguage(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.go')) return 'go'
  if (lower.endsWith('.rs')) return 'rust'
  if (lower.endsWith('.java')) return 'java'
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c'
  if (lower.endsWith('.cpp') || lower.endsWith('.hpp') || lower.endsWith('.cc')) return 'cpp'
  return undefined
}

function createInitialState(): AppState {
  const defaultProjectId = crypto.randomUUID()
  const defaultChatId = crypto.randomUUID()
  const defaultFileId = crypto.randomUUID()

  const defaultProject: Project = {
    id: defaultProjectId,
    name: 'Untitled Project',
    files: [
      {
        id: defaultFileId,
        path: 'src/main.ts',
        content: `// Example project file\n// Describe this file in chat to get suggestions.\n\nexport function add(a: number, b: number) {\n  return a + b\n}\n`,
      },
      {
        id: crypto.randomUUID(),
        path: 'README.md',
        content: `# New Project\n\nDescribe your project here. The assistant can see the contents of open files when you ask questions.\n`,
      },
    ],
    chats: [
      {
        id: defaultChatId,
        name: 'Chat 1',
        messages: [],
      },
    ],
    activeChatId: defaultChatId,
    activeFileId: defaultFileId,
    openFileIds: [defaultFileId],
  }

  return {
    projects: [defaultProject],
    activeProjectId: defaultProjectId,
  }
}

function extractCodeSnippet(reply: string): string | null {
  const trimmed = reply.trim()
  if (!trimmed) return null
  const fenceStart = trimmed.indexOf('```')
  if (fenceStart === -1) {
    return trimmed
  }
  const firstNewline = trimmed.indexOf('\n', fenceStart + 3)
  const afterHeaderIndex = firstNewline === -1 ? fenceStart + 3 : firstNewline + 1
  const fenceEnd = trimmed.indexOf('```', afterHeaderIndex)
  const inner =
    fenceEnd === -1 ? trimmed.slice(afterHeaderIndex) : trimmed.slice(afterHeaderIndex, fenceEnd)
  return inner.trim() || null
}

function userWantsActiveFileRewrite(message: string): boolean {
  const m = message.toLowerCase()
  return (
    /\b(remove|delete|strip|omit|drop|undo|revert)\b/.test(m) ||
    /\b(get rid of|take out|take away|clear out|no longer)\b/.test(m) ||
    /\b(don't add|do not add|dont add|stop adding|no console|without (those |the )?logs?)\b/.test(m) ||
    /\b(remove those|remove the|delete those|delete the)\b/.test(m) ||
    /\b(rewrite|replace)\b.*\b(file|code)\b/.test(m) ||
    /\b(refactor|update|change)\b.*\b(file|code)\b/.test(m) ||
    /\b(whole file|entire file|full file)\b/.test(m)
  )
}

function extractLargestCodeFence(reply: string): string | null {
  const re = /```[\w.-]*\n([\s\S]*?)```/g
  let best: string | null = null
  let bestLen = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(reply)) !== null) {
    const inner = m[1].trim()
    if (inner.length > bestLen) {
      bestLen = inner.length
      best = inner
    }
  }
  return best
}

function isPlausibleFullFileReplace(oldContent: string, newSnippet: string): boolean {
  const oldT = oldContent.trim()
  const newT = newSnippet.trim()
  const oldLines = oldContent.split('\n').length
  const newLines = newSnippet.split('\n').length
  if (newLines < 2) return false
  if (oldT.length > 150 && newT.length < Math.min(80, oldT.length * 0.12)) return false
  if (oldLines <= 8) {
    return newLines >= Math.max(2, Math.ceil(oldLines * 0.45))
  }
  const minNew = Math.max(5, Math.floor(oldLines * 0.4))
  return newLines >= minNew
}

function App() {
  const [authToken, setAuthToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : window.localStorage.getItem(AUTH_TOKEN_KEY),
  )
  const [authUsername, setAuthUsername] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : window.localStorage.getItem(AUTH_USERNAME_KEY),
  )
  const userId = authUsername ?? 'guest'

  const [state, setState] = useState<AppState>(() => {
    if (typeof window === 'undefined') return createInitialState()
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return createInitialState()
    try {
      const parsed = JSON.parse(stored) as AppState
      if (!parsed.projects || parsed.projects.length === 0) {
        return createInitialState()
      }
      return parsed
    } catch {
      return createInitialState()
    }
  })

  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [authFormUsername, setAuthFormUsername] = useState('')
  const [authFormPassword, setAuthFormPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const [shareTargetUsername, setShareTargetUsername] = useState('')
  const [importIncoming, setImportIncoming] = useState<{ id: string; name: string; ownerId?: string }[]>(
    [],
  )
  const [importOutgoing, setImportOutgoing] = useState<{ id: string; name: string; sharedWith?: string }[]>(
    [],
  )
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importListFetched, setImportListFetched] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<'chat' | 'context'>('chat')
  const [projectContentsOpen, setProjectContentsOpen] = useState(true)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renamingProjectName, setRenamingProjectName] = useState('')
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [renamingChatName, setRenamingChatName] = useState('')
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  const [renamingFilePath, setRenamingFilePath] = useState('')
  const [suggestedEdit, setSuggestedEdit] = useState<{ fileId: string; content: string } | null>(null)
  const [inlineSuggestion, setInlineSuggestion] = useState<string | null>(null)
  const [inlineSuggestionLoading, setInlineSuggestionLoading] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const inlineSuggestionAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!accountMenuOpen) return
    function onPointerDown(e: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [accountMenuOpen])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (authUsername) {
      window.localStorage.setItem(USER_STORAGE_KEY, authUsername)
    }
  }, [authUsername])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const projectId = params.get('project')
    if (!projectId) return
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json())
      .then(
        (data: {
          id?: string
          name?: string
          files?: { path: string; content: string }[]
          chats?: { id?: string; name: string }[]
          error?: string
        }) => {
        if (data.error) return
        const files: VirtualFile[] = (data.files ?? []).map((f) => ({
          id: crypto.randomUUID(),
          path: f.path,
          content: f.content ?? '',
        }))
        const chats: ChatSession[] = (data.chats ?? []).map((c) => ({
          id: c.id ?? crypto.randomUUID(),
          name: c.name ?? 'Chat',
          messages: [],
        }))
        const newProject: Project = {
          id: crypto.randomUUID(),
          name: (data.name ?? 'Imported') + ' (imported)',
          files,
          chats: chats.length ? chats : [{ id: crypto.randomUUID(), name: 'Chat 1', messages: [] }],
          activeChatId: chats[0]?.id ?? crypto.randomUUID(),
          activeFileId: files[0]?.id,
          importedProjectId: projectId,
        }
        if (newProject.chats.length) newProject.activeChatId = newProject.chats[0].id
        if (newProject.files.length) newProject.activeFileId = newProject.files[0].id
        setState((prev) => ({
          ...prev,
          projects: [...prev.projects, newProject],
          activeProjectId: newProject.id,
        }))
        window.history.replaceState({}, '', window.location.pathname)
      })
      .catch(() => {})
  }, [])

  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? state.projects[0]
  const activeChat =
    activeProject.chats.find((c) => c.id === activeProject.activeChatId) ?? activeProject.chats[0]
  const activeFile =
    activeProject.files.find((f) => f.id === activeProject.activeFileId) ?? activeProject.files[0]

  const sharingTotal = importIncoming.length + importOutgoing.length

  const openFileIds =
    (activeProject.openFileIds && activeProject.openFileIds.length > 0
      ? activeProject.openFileIds
      : activeProject.activeFileId
        ? [activeProject.activeFileId]
        : activeProject.files[0]
          ? [activeProject.files[0].id]
          : [])

  const openFiles: VirtualFile[] = openFileIds
    .map((id) => activeProject.files.find((f) => f.id === id))
    .filter((f): f is VirtualFile => Boolean(f))

  const currentFileContent = activeFile?.content ?? ''
  const suggestedContentForActive =
    suggestedEdit && activeFile && suggestedEdit.fileId === activeFile.id
      ? suggestedEdit.content
      : null

  const suggestedDiffLines =
    suggestedContentForActive != null
      ? (() => {
          const oldLines = currentFileContent.split('\n')
          const newLines = suggestedContentForActive.split('\n')
          const maxLen = Math.max(oldLines.length, newLines.length)
          const result: { newText: string; status: 'same' | 'changed' | 'added' }[] = []
          for (let i = 0; i < maxLen; i += 1) {
            const oldLine = oldLines[i]
            const newLine = newLines[i]
            if (newLine === undefined) continue
            let status: 'same' | 'changed' | 'added' = 'same'
            if (oldLine === undefined) {
              status = 'added'
            } else if (newLine !== oldLine) {
              status = 'changed'
            }
            result.push({ newText: newLine, status })
          }
          return result
        })()
      : []

  // Lightweight, debounced “while typing” code suggestion in the editor.
  useEffect(() => {
    if (!activeFile) {
      setInlineSuggestion(null)
      return
    }
    const content = activeFile.content
    if (!content.trim()) {
      setInlineSuggestion(null)
      return
    }

    const handle = window.setTimeout(async () => {
      try {
        inlineSuggestionAbortRef.current?.abort()
        const controller = new AbortController()
        inlineSuggestionAbortRef.current = controller
        setInlineSuggestionLoading(true)

        const prompt =
          'You are a code completion assistant. ' +
          'Given the file below, suggest the next few lines of code. ' +
          'Respond with ONLY the suggested code, no explanation, and keep it under ~5 lines.\n\n' +
          `File path: ${activeFile.path}\n\n` +
          'Current file contents:\n\n' +
          content

        const sessionId = makeSessionId(userId, activeProject.id, activeChat.id)
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId,
            message: prompt,
            ...(activeProject.importedProjectId
              ? { projectId: activeProject.importedProjectId, chatId: activeChat.id }
              : {}),
          }),
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(`Request failed: ${res.status}`)
        }
        const data = (await res.json()) as { reply: string }
        const suggestion = (data.reply ?? '').trim()
        setInlineSuggestion(suggestion || null)
      } catch {
        // Ignore errors for inline suggestions; keep UX quiet.
      } finally {
        setInlineSuggestionLoading(false)
      }
    }, 1200)

    return () => {
      window.clearTimeout(handle)
      inlineSuggestionAbortRef.current?.abort()
    }
  }, [
    activeFile?.id,
    activeFile?.content,
    activeProject.id,
    activeProject.importedProjectId,
    activeChat.id,
    userId,
  ])

  const messages = activeChat?.messages ?? []

  function makeSessionId(currentUserId: string, projectId: string, chatId: string) {
    return `${currentUserId}:${projectId}:${chatId}`
  }

  async function handleAuthSubmit(e: FormEvent) {
    e.preventDefault()
    const username = authFormUsername.trim()
    const password = authFormPassword
    if (!username || !password) {
      setAuthError('Username and password are required')
      return
    }
    setAuthError(null)
    setAuthLoading(true)
    try {
      const endpoint = authMode === 'signup' ? '/api/signup' : '/api/login'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = (await res.json()) as { username?: string; token?: string; error?: string }
      if (!res.ok) {
        setAuthError(data.error ?? 'Request failed')
        return
      }
      if (data.token && data.username) {
        window.localStorage.setItem(AUTH_TOKEN_KEY, data.token)
        window.localStorage.setItem(AUTH_USERNAME_KEY, data.username)
        setAuthToken(data.token)
        setAuthUsername(data.username)
        try {
          const resState = await fetch('/api/user-state', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${data.token}`,
            },
          })
          if (resState.ok) {
            const payload = (await resState.json()) as { state?: AppState | null }
            if (payload.state && payload.state.projects && payload.state.projects.length > 0) {
              setState(payload.state)
            }
          }
        } catch {
          // ignore state load failures; user can continue with local state
        }
        setAuthFormUsername('')
        setAuthFormPassword('')
        setAccountMenuOpen(false)
      }
    } catch {
      setAuthError('Network error. Is the Worker running?')
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleSuggestEdit() {
    if (!activeFile || isSending) return

    const systemPrompt =
      'You are a code-editing assistant. Given the current file, ' +
      'return ONLY the full updated file contents, with no explanation or commentary.'

    const promptText =
      `${systemPrompt}\n\n` +
      `File path: ${activeFile.path}\n\n` +
      `Current contents:\n\n` +
      activeFile.content

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: `Suggest an edit for ${activeFile.path}.`,
      timestamp: Date.now(),
    }

    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              chats: p.chats.map((c) =>
                c.id === activeChat.id
                  ? {
                      ...c,
                      messages: [...c.messages, userMessage],
                    }
                  : c,
              ),
            }
          : p,
      ),
    }))

    setIsSending(true)
    try {
      const sessionId = makeSessionId(userId, activeProject.id, activeChat.id)
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          message: promptText,
          ...(activeProject.importedProjectId
            ? { projectId: activeProject.importedProjectId, chatId: activeChat.id }
            : {}),
        }),
      })

      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`)
      }

      const data = (await res.json()) as {
        reply: string
        messages?: { role: Role; content: string; timestamp: number }[]
      }

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply,
        timestamp: Date.now(),
      }

      setState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === activeProject.id
            ? {
                ...p,
                chats: p.chats.map((c) =>
                  c.id === activeChat.id
                    ? {
                        ...c,
                        messages: [...c.messages, assistantMessage],
                      }
                    : c,
                ),
              }
            : p,
        ),
      }))

      setSuggestedEdit({
        fileId: activeFile.id,
        content: data.reply,
      })
    } catch (err) {
      console.error(err)
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          'There was an error asking the agent to suggest an edit. Is the Cloudflare Worker running?',
        timestamp: Date.now(),
      }
      setState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === activeProject.id
            ? {
                ...p,
                chats: p.chats.map((c) =>
                  c.id === activeChat.id
                    ? {
                        ...c,
                        messages: [...c.messages, assistantMessage],
                      }
                    : c,
                ),
              }
            : p,
        ),
      }))
    } finally {
      setIsSending(false)
    }
  }

  function handleLogout() {
    window.localStorage.removeItem(AUTH_TOKEN_KEY)
    window.localStorage.removeItem(AUTH_USERNAME_KEY)
    window.localStorage.removeItem(STORAGE_KEY)
    setAuthToken(null)
    setAuthUsername(null)
    setAccountMenuOpen(false)
    setState(createInitialState())
  }

  useEffect(() => {
    if (!authToken || !authUsername) return
    const handle = window.setTimeout(() => {
      fetch('/api/user-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ state }),
      }).catch(() => {})
    }, 800)
    return () => {
      window.clearTimeout(handle)
    }
  }, [state, authToken, authUsername])

  function handleSwitchProject(projectId: string) {
    setState((prev) => ({
      ...prev,
      activeProjectId: projectId,
    }))
  }

  function handleNewProject() {
    const name = window.prompt('Project name?', 'New Project')
    if (!name) return

    const projectId = crypto.randomUUID()
    const chatId = crypto.randomUUID()
    const fileId = crypto.randomUUID()

    const newProject: Project = {
      id: projectId,
      name,
      files: [
        {
          id: fileId,
          path: 'src/main.ts',
          content: `// ${name} main file\n\nexport function main() {\n  console.log('Hello from ${name}')\n}\n`,
        },
      ],
      chats: [
        {
          id: chatId,
          name: 'Chat 1',
          messages: [],
        },
      ],
      activeChatId: chatId,
      activeFileId: fileId,
    }

    setState((prev) => ({
      ...prev,
      projects: [...prev.projects, newProject],
      activeProjectId: projectId,
    }))
  }

  function handleNewChat() {
    const name = window.prompt('Chat name?', `Chat ${activeProject.chats.length + 1}`) ?? ''
    const chatId = crypto.randomUUID()
    const chat: ChatSession = {
      id: chatId,
      name: name || `Chat ${activeProject.chats.length + 1}`,
      messages: [],
    }
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              chats: [...p.chats, chat],
              activeChatId: chatId,
            }
          : p,
      ),
    }))
  }

  function handleSwitchChat(chatId: string) {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              activeChatId: chatId,
            }
          : p,
      ),
    }))
  }

  function handleNewFile() {
    const path = window.prompt('File path?', 'src/new-file.ts')
    if (!path) return
    const fileId = crypto.randomUUID()
    const file: VirtualFile = {
      id: fileId,
      path,
      content: '',
    }
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              files: [...p.files, file],
              activeFileId: fileId,
            }
          : p,
      ),
    }))
  }

  function handleSwitchFile(fileId: string) {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => {
        if (p.id !== activeProject.id) return p
        const baseOpen = p.openFileIds && p.openFileIds.length > 0
          ? p.openFileIds
          : p.activeFileId
            ? [p.activeFileId]
            : []
        const nextOpen = Array.from(new Set([...baseOpen, fileId]))
        return {
          ...p,
          activeFileId: fileId,
          openFileIds: nextOpen,
        }
      }),
    }))
  }

  function handleCloseFileTab(fileId: string) {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => {
        if (p.id !== activeProject.id) return p
        const currentOpen =
          p.openFileIds && p.openFileIds.length > 0
            ? p.openFileIds
            : p.activeFileId
              ? [p.activeFileId]
              : []
        const nextOpen = currentOpen.filter((id) => id !== fileId)
        let nextActive = p.activeFileId
        if (p.activeFileId === fileId) {
          nextActive = nextOpen[0] ?? p.files.find((f) => f.id !== fileId)?.id
        }
        return {
          ...p,
          activeFileId: nextActive,
          openFileIds: nextOpen,
        }
      }),
    }))
  }

  function startRenameProject(projectId: string, currentName: string) {
    setRenamingProjectId(projectId)
    setRenamingProjectName(currentName)
  }

  function handleRenameProjectSubmit(e: FormEvent) {
    e.preventDefault()
    const name = renamingProjectName.trim()
    if (!name || !renamingProjectId) {
      setRenamingProjectId(null)
      return
    }
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === renamingProjectId ? { ...p, name } : p,
      ),
    }))
    setRenamingProjectId(null)
  }

  function handleDeleteProject(projectId: string) {
    if (!window.confirm('Delete this project? Chats and files will be removed.')) return
    setState((prev) => {
      const list = prev.projects.filter((p) => p.id !== projectId)
      if (!list.length) {
        const initial = createInitialState()
        return { ...prev, projects: initial.projects, activeProjectId: initial.activeProjectId }
      }
      const nextActive =
        prev.activeProjectId === projectId ? list[0].id : prev.activeProjectId
      return { ...prev, projects: list, activeProjectId: nextActive }
    })
  }

  function startRenameChat(chatId: string, currentName: string) {
    setRenamingChatId(chatId)
    setRenamingChatName(currentName)
  }

  function handleRenameChatSubmit(e: FormEvent) {
    e.preventDefault()
    const name = renamingChatName.trim()
    if (!name || !renamingChatId) {
      setRenamingChatId(null)
      return
    }
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              chats: p.chats.map((c) =>
                c.id === renamingChatId ? { ...c, name } : c,
              ),
            }
          : p,
      ),
    }))
    setRenamingChatId(null)
  }

  function handleDeleteChat(chatId: string) {
    if (!window.confirm('Delete this chat? Message history will be removed.')) return
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => {
        if (p.id !== activeProject.id) return p
        const chats = p.chats.filter((c) => c.id !== chatId)
        if (!chats.length) {
          const newChat: ChatSession = {
            id: crypto.randomUUID(),
            name: 'Chat 1',
            messages: [],
          }
          return { ...p, chats: [newChat], activeChatId: newChat.id }
        }
        const nextActive =
          p.activeChatId === chatId ? chats[0].id : p.activeChatId
        return { ...p, chats, activeChatId: nextActive }
      }),
    }))
  }

  function startRenameFile(fileId: string, currentPath: string) {
    setRenamingFileId(fileId)
    setRenamingFilePath(currentPath)
  }

  function handleRenameFileSubmit(e: FormEvent) {
    e.preventDefault()
    const path = renamingFilePath.trim()
    if (!path || !renamingFileId) {
      setRenamingFileId(null)
      return
    }
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              files: p.files.map((f) =>
                f.id === renamingFileId ? { ...f, path } : f,
              ),
            }
          : p,
      ),
    }))
    setRenamingFileId(null)
  }

  function handleDeleteFile(fileId: string) {
    if (!window.confirm('Delete this file? Content cannot be recovered.')) return
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => {
        if (p.id !== activeProject.id) return p
        const files = p.files.filter((f) => f.id !== fileId)
        const nextActive =
          p.activeFileId === fileId ? (files[0]?.id ?? undefined) : p.activeFileId
        return { ...p, files, activeFileId: nextActive }
      }),
    }))
  }

  function handleCopyFilePath(path: string) {
    navigator.clipboard.writeText(path).catch(() => {})
  }

  function handleCopyText(text: string, feedbackId?: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    if (feedbackId != null) {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      setCopyFeedback(feedbackId)
      copyFeedbackTimerRef.current = setTimeout(() => {
        setCopyFeedback(null)
        copyFeedbackTimerRef.current = null
      }, 1500)
    }
  }

  async function handleShareProject() {
    if (!authToken || !authUsername) {
      setShareStatus('Log in to share projects.')
      return
    }
    const target = shareTargetUsername.trim().toLowerCase()
    if (!target) {
      setShareStatus('Enter a username to share with.')
      return
    }
    setShareStatus(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: activeProject.name,
          files: activeProject.files.map((f) => ({ path: f.path, content: f.content })),
          chats: activeProject.chats.map((c) => ({
            id: c.id,
            name: c.name,
            messages: c.messages.map((m) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
            })),
          })),
          shareWith: target,
        }),
      })
      const data = (await res.json()) as {
        projectId?: string
        username?: string
        error?: string
        detail?: string
        hint?: string
      }
      if (!res.ok) {
        if (res.status === 401) {
          setShareStatus(
            'Unauthorized — your login session is not valid on the server (often after KV or Worker changes). Log out, log in again, then share.',
          )
          return
        }
        const parts = [data.error, data.detail, data.hint].filter(Boolean)
        setShareStatus(parts.join(' ') || 'Failed to share')
        return
      }
      if (data.projectId) {
        setShareStatus(`Shared with "${target}". They can load it from their account.`)
        setShareTargetUsername('')
      }
    } catch {
      setShareStatus('Network error.')
    }
  }

  async function handleImportList() {
    if (!authToken || !authUsername) {
      setImportError('Log in to load projects shared with you.')
      return
    }
    setImportError(null)
    setImportLoading(true)
    try {
      const res = await fetch('/api/projects?list=sharing', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })
      const text = await res.text()
      let data: {
        incoming?: { id: string; name: string; ownerId?: string }[]
        outgoing?: { id: string; name: string; sharedWith?: string }[]
        error?: string
      } = {}
      try {
        data = text ? (JSON.parse(text) as typeof data) : {}
      } catch {
        setImportError(
          `Bad response from API (${res.status}). Start the Worker: cd worker && npx wrangler dev --port 8787`,
        )
        setImportIncoming([])
        setImportOutgoing([])
        setImportListFetched(false)
        return
      }
      if (!res.ok) {
        if (res.status === 401) {
          setImportError(
            `Unauthorized — your session is not valid on this Worker (restart or KV change often causes this). Log out and log in again. You must be logged in as the exact username your partner typed in "Share with username" (you are "${authUsername ?? '?'}"). You and your partner must use the same app + Worker (e.g. both localhost:5173 → same wrangler dev) so shares land in the same KV.`,
          )
        } else {
          setImportError(data.error ?? `Failed to load (${res.status})`)
        }
        setImportIncoming([])
        setImportOutgoing([])
        setImportListFetched(false)
        return
      }
      setImportIncoming(data.incoming ?? [])
      setImportOutgoing(data.outgoing ?? [])
      setImportListFetched(true)
    } catch {
      setImportError(
        'Could not reach the API. Is the Cloudflare Worker running on http://127.0.0.1:8787?',
      )
      setImportIncoming([])
      setImportOutgoing([])
      setImportListFetched(false)
    } finally {
      setImportLoading(false)
    }
  }

  async function handleImportProject(projectId: string) {
    setImportError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}`)
      const data = (await res.json()) as {
        id?: string
        name?: string
        files?: { path: string; content: string }[]
        chats?: { id?: string; name: string; messages?: unknown[] }[]
        error?: string
      }
      if (!res.ok) {
        setImportError(data.error ?? 'Failed to load project')
        return
      }
      const kvProjectId = data.id ?? projectId
      const files: VirtualFile[] = (data.files ?? []).map((f) => ({
        id: crypto.randomUUID(),
        path: f.path,
        content: f.content ?? '',
      }))
      const chats: ChatSession[] = (data.chats ?? []).map((c) => ({
        id: c.id ?? crypto.randomUUID(),
        name: c.name ?? 'Chat',
        messages: [],
      }))
      const chatId = chats[0]?.id
      const fileId = files[0]?.id
      const newProject: Project = {
        id: crypto.randomUUID(),
        name: data.name ?? 'Imported',
        files,
        chats: chats.length ? chats : [{ id: crypto.randomUUID(), name: 'Chat 1', messages: [] }],
        activeChatId: chatId ?? crypto.randomUUID(),
        activeFileId: fileId,
        importedProjectId: kvProjectId,
      }
      if (newProject.chats.length && !chatId) {
        newProject.activeChatId = newProject.chats[0].id
      }
      if (newProject.files.length && !fileId) {
        newProject.activeFileId = newProject.files[0].id
      }
      setState((prev) => ({
        ...prev,
        projects: [...prev.projects, newProject],
        activeProjectId: newProject.id,
      }))
      setImportIncoming((prev) => prev.filter((p) => p.id !== projectId))
      setImportOutgoing((prev) => prev.filter((p) => p.id !== projectId))
    } catch {
      setImportError('Network error.')
    }
  }

  function handleUpdateFileContent(content: string) {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              files: p.files.map((f) =>
                f.id === activeFile.id
                  ? {
                      ...f,
                      content,
                    }
                  : f,
              ),
            }
          : p,
      ),
    }))
  }

  async function handleFileDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!e.dataTransfer?.files?.length) return

    const droppedFiles = Array.from(e.dataTransfer.files)
    const fileEntries = await Promise.all(
      droppedFiles.map(async (file) => ({
        path: file.name,
        content: await file.text(),
      })),
    )

    setState((prev) => {
      const updatedProjects = prev.projects.map((p) => {
        if (p.id !== activeProject.id) return p

        const existingPaths = new Set(p.files.map((f) => f.path))
        const newFiles: VirtualFile[] = []
        let lastFileId = p.activeFileId

        for (const entry of fileEntries) {
          let candidatePath = entry.path
          let suffix = 1
          while (existingPaths.has(candidatePath)) {
            const dotIndex = entry.path.lastIndexOf('.')
            const base = dotIndex > 0 ? entry.path.slice(0, dotIndex) : entry.path
            const ext = dotIndex > 0 ? entry.path.slice(dotIndex) : ''
            candidatePath = `${base} (${suffix})${ext}`
            suffix += 1
          }
          existingPaths.add(candidatePath)

          const id = crypto.randomUUID()
          newFiles.push({
            id,
            path: candidatePath,
            content: entry.content,
          })
          lastFileId = id
        }

        return {
          ...p,
          files: [...p.files, ...newFiles],
          activeFileId: lastFileId ?? p.activeFileId,
        }
      })

      return {
        ...prev,
        projects: updatedProjects,
      }
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isSending) return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }

    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              chats: p.chats.map((c) =>
                c.id === activeChat.id
                  ? {
                      ...c,
                      messages: [...c.messages, userMessage],
                    }
                  : c,
              ),
            }
          : p,
      ),
    }))
    setInput('')
    setIsSending(true)

    try {
      const sessionId = makeSessionId(userId, activeProject.id, activeChat.id)
      const openFileSummary = activeFile
        ? `\n\nActive file: ${activeFile.path}\n\n${activeFile.content}`
        : ''

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          message: trimmed + openFileSummary,
          ...(activeProject.importedProjectId
            ? { projectId: activeProject.importedProjectId, chatId: activeChat.id }
            : {}),
        }),
      })

      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`)
      }

      const data = (await res.json()) as {
        reply: string
        messages?: { role: Role; content: string; timestamp: number }[]
      }

      const wantsRewrite = Boolean(activeFile && userWantsActiveFileRewrite(trimmed))
      const snippet = wantsRewrite
        ? extractLargestCodeFence(data.reply) ?? extractCodeSnippet(data.reply)
        : extractCodeSnippet(data.reply)
      const rewriteFile = Boolean(
        wantsRewrite &&
          snippet &&
          activeFile &&
          isPlausibleFullFileReplace(activeFile.content, snippet),
      )

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply,
        timestamp: Date.now(),
      }

      setState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => {
          if (p.id !== activeProject.id) return p
          return {
            ...p,
            chats: p.chats.map((c) =>
              c.id === activeChat.id
                ? {
                    ...c,
                    messages: [...c.messages, assistantMessage],
                  }
                : c,
            ),
            files:
              snippet && activeFile
                ? p.files.map((f) => {
                    if (f.id !== activeFile.id) return f
                    if (rewriteFile) {
                      const next = snippet.endsWith('\n') ? snippet : `${snippet}\n`
                      return { ...f, content: next }
                    }
                    if (wantsRewrite && !rewriteFile) {
                      return f
                    }
                    const needsNewline = f.content.length > 0 && !f.content.endsWith('\n')
                    const next =
                      f.content + (needsNewline ? '\n' : '') + snippet + (snippet.endsWith('\n') ? '' : '\n')
                    return { ...f, content: next }
                  })
                : p.files,
          }
        }),
      }))
    } catch (err) {
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          'There was an error talking to the Cloudflare Worker. Is it running locally?',
        timestamp: Date.now(),
      }
      setState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === activeProject.id
            ? {
                ...p,
                chats: p.chats.map((c) =>
                  c.id === activeChat.id
                    ? {
                        ...c,
                        messages: [...c.messages, assistantMessage],
                      }
                    : c,
                ),
              }
            : p,
        ),
      }))
      console.error(err)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="app-root">
      {copyFeedback != null && (
        <div className="copy-toast" role="status" aria-live="polite">
          Copied
        </div>
      )}
      <header className="app-titlebar">
        <div className="app-title">Cloudflare Code Assistant</div>
        <div className="app-title-right">
          <span className="app-badge">Workers AI</span>
          <span className="app-badge subtle">MVP</span>
          <div className="account-dropdown" ref={accountMenuRef}>
            <button
              type="button"
              className="account-trigger"
              onClick={() => setAccountMenuOpen((o) => !o)}
              aria-expanded={accountMenuOpen}
              aria-haspopup="true"
            >
              {authUsername ?? 'Log in / Sign up'}
            </button>
            {accountMenuOpen && (
              <div className="account-menu">
                {authToken && authUsername ? (
                  <>
                    <div className="account-menu-signed">Signed in as {authUsername}</div>
                    <button type="button" className="chat-send-button secondary" onClick={handleLogout}>
                      Log out
                    </button>
                  </>
                ) : (
                  <>
                    <div className="auth-tabs">
                      <button
                        type="button"
                        className={authMode === 'login' ? 'auth-tab active' : 'auth-tab'}
                        onClick={() => { setAuthMode('login'); setAuthError(null) }}
                      >
                        Log in
                      </button>
                      <button
                        type="button"
                        className={authMode === 'signup' ? 'auth-tab active' : 'auth-tab'}
                        onClick={() => { setAuthMode('signup'); setAuthError(null) }}
                      >
                        Sign up
                      </button>
      </div>
                    <form className="auth-form" onSubmit={handleAuthSubmit}>
                      <input
                        className="account-input"
                        type="text"
                        autoComplete="username"
                        placeholder="Username"
                        value={authFormUsername}
                        onChange={(e) => setAuthFormUsername(e.target.value)}
                      />
                      <input
                        className="account-input"
                        type="password"
                        autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                        placeholder="Password"
                        value={authFormPassword}
                        onChange={(e) => setAuthFormPassword(e.target.value)}
                      />
                      {authError && <p className="auth-error">{authError}</p>}
                      <button type="submit" className="chat-send-button" disabled={authLoading}>
                        {authLoading ? '…' : authMode === 'signup' ? 'Sign up' : 'Log in'}
        </button>
                    </form>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-section-title">Projects</div>
            {state.projects.map((project) => (
              <div key={project.id}>
                <div className="sidebar-row">
                  <button
                    type="button"
                    className={`sidebar-row-label ${project.id === activeProject.id ? 'active' : ''}`}
                    onClick={() => handleSwitchProject(project.id)}
                  >
                    {project.id === activeProject.id ? '● ' : '○ '}
                    <span className="sidebar-row-text">{project.name}</span>
                  </button>
                  <div className="sidebar-row-actions">
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRenameProject(project.id, project.name)
                      }}
                      aria-label="Rename project"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteProject(project.id)
                      }}
                      aria-label="Delete project"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                </div>
                {renamingProjectId === project.id && (
                  <form
                    className="sidebar-rename-row"
                    onSubmit={handleRenameProjectSubmit}
                  >
                    <input
                      className="sidebar-rename-input"
                      type="text"
                      autoFocus
                      value={renamingProjectName}
                      onChange={(e) => setRenamingProjectName(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      onClick={() => setRenamingProjectId(null)}
                      aria-label="Cancel rename"
                    >
                      ✕
                    </button>
                    <button
                      type="submit"
                      className="sidebar-icon-btn"
                      aria-label="Save new project name"
                    >
                      ✓
                    </button>
                  </form>
                )}
              </div>
            ))}
            <button type="button" className="sidebar-button secondary" onClick={handleNewProject}>
              + New project
            </button>
          </div>
          <div className="sidebar-project-content" aria-label={`Contents of project ${activeProject.name}`}>
            <button
              type="button"
              className="sidebar-project-dropdown-trigger"
              onClick={() => setProjectContentsOpen((o) => !o)}
              aria-expanded={projectContentsOpen}
            >
              <span className={`sidebar-project-chevron ${projectContentsOpen ? 'open' : ''}`} aria-hidden>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
              <span className="sidebar-project-label-text">
                <span className="sidebar-project-name">{activeProject.name}</span>
              </span>
            </button>
            {projectContentsOpen && (
            <>
            <div className="sidebar-section sidebar-subsection">
              <div className="sidebar-section-title">Chats</div>
            {activeProject.chats.map((chat) => (
              <div key={chat.id}>
                <div className="sidebar-row">
                  <button
                    type="button"
                    className={`sidebar-row-label ${chat.id === activeChat.id ? 'active' : ''}`}
                    onClick={() => handleSwitchChat(chat.id)}
                  >
                    {chat.id === activeChat.id ? '● ' : '○ '}
                    <span className="sidebar-row-text">{chat.name}</span>
                  </button>
                  <div className="sidebar-row-actions">
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRenameChat(chat.id, chat.name)
                      }}
                      aria-label="Rename chat"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteChat(chat.id)
                      }}
                      aria-label="Delete chat"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                </div>
                {renamingChatId === chat.id && (
                  <form
                    className="sidebar-rename-row"
                    onSubmit={handleRenameChatSubmit}
                  >
                    <input
                      className="sidebar-rename-input"
                      type="text"
                      autoFocus
                      value={renamingChatName}
                      onChange={(e) => setRenamingChatName(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      onClick={() => setRenamingChatId(null)}
                      aria-label="Cancel rename"
                    >
                      ✕
                    </button>
                    <button
                      type="submit"
                      className="sidebar-icon-btn"
                      aria-label="Save new chat name"
                    >
                      ✓
                    </button>
                  </form>
                )}
              </div>
            ))}
            <button type="button" className="sidebar-button secondary" onClick={handleNewChat}>
              + New chat
            </button>
            </div>
            <div
              className="sidebar-section sidebar-subsection sidebar-files-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
            >
              <div className="sidebar-section-title">Files</div>
            {activeProject.files.map((file) => (
              <div key={file.id}>
                <div className="sidebar-row">
                  <button
                    type="button"
                    className={`sidebar-row-label ${file.id === activeFile.id ? 'active' : ''}`}
                    onClick={() => handleSwitchFile(file.id)}
                  >
                    {file.id === activeFile.id ? '● ' : '○ '}
                    <span className="sidebar-row-text" title={file.path}>{file.path}</span>
                  </button>
                  <div className="sidebar-row-actions">
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRenameFile(file.id, file.path)
                      }}
                      aria-label="Rename file"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Copy path"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCopyFilePath(file.path)
                      }}
                      aria-label="Copy file path"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteFile(file.id)
                      }}
                      aria-label="Delete file"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                </div>
                {renamingFileId === file.id && (
                  <form
                    className="sidebar-rename-row"
                    onSubmit={handleRenameFileSubmit}
                  >
                    <input
                      className="sidebar-rename-input"
                      type="text"
                      autoFocus
                      value={renamingFilePath}
                      onChange={(e) => setRenamingFilePath(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sidebar-icon-btn"
                      onClick={() => setRenamingFileId(null)}
                      aria-label="Cancel rename"
                    >
                      ✕
                    </button>
                    <button
                      type="submit"
                      className="sidebar-icon-btn"
                      aria-label="Save new file path"
                    >
                      ✓
                    </button>
                  </form>
                )}
              </div>
            ))}
            <button type="button" className="sidebar-button secondary" onClick={handleNewFile}>
              + New file
            </button>
            <div className="sidebar-drop-hint">
              Drag &amp; drop files here to add them to this project.
            </div>
            </div>
            </>
            )}
          </div>
        </aside>
        <main className="main-pane">
          <div className="main-pane-editor">
            <div className="editor-tabs" role="tablist">
              {openFiles.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  role="tab"
                  aria-selected={file.id === activeFile?.id}
                  className={`editor-tab ${file.id === activeFile?.id ? 'active' : ''}`}
                  onClick={() => handleSwitchFile(file.id)}
                >
                  <span className="editor-tab-title">{file.path}</span>
                  <span
                    className="editor-tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCloseFileTab(file.id)
                    }}
                    aria-label="Close file tab"
                  >
                    ×
                  </span>
                </button>
              ))}
              {!openFiles.length && (
                <div className="editor-tabs-empty">No file open</div>
              )}
            </div>
            <div className="editor-header">
              <div className="editor-title">{activeFile?.path ?? 'No file selected'}</div>
              <div className="editor-header-actions">
                {suggestedEdit && activeFile && suggestedEdit.fileId === activeFile.id && (
                  <div className="editor-suggest-pill">
                    <span className="editor-suggest-text">Suggested edit ready</span>
                    <button
                      type="button"
                      className="editor-suggest-btn accept"
                      onClick={() => {
                        handleUpdateFileContent(suggestedEdit.content)
                        setSuggestedEdit(null)
                      }}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="editor-suggest-btn"
                      onClick={() => setSuggestedEdit(null)}
                    >
                      Reject
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="editor-suggest-trigger"
                  disabled={!activeFile || isSending}
                  onClick={handleSuggestEdit}
                >
                  Suggest edit
                </button>
                {activeFile && (
                  <button
                    type="button"
                    className="editor-suggest-trigger"
                    onClick={() => handleCopyText(activeFile.content, 'file')}
                  >
                    {copyFeedback === 'file' ? 'Copied' : 'Copy file'}
                  </button>
                )}
              </div>
            </div>
            {suggestedContentForActive && (
              <div className="editor-diff">
                <div className="editor-diff-title-row">
                  <span className="editor-diff-title">Highlighted suggested changes</span>
                  <button
                    type="button"
                    className="editor-diff-copy-all"
                    onClick={() => handleCopyText(suggestedContentForActive, 'diff-all')}
                  >
                    {copyFeedback === 'diff-all' ? 'Copied' : 'Copy all'}
                  </button>
                </div>
                <div className="editor-diff-body">
                  {suggestedDiffLines.map((line, idx) => (
                    <div
                      key={idx}
                      className={`editor-diff-line editor-diff-${line.status}`}
                    >
                      <span className="editor-diff-gutter">{idx + 1}</span>
                      <span className="editor-diff-text">{line.newText}</span>
                      <button
                        type="button"
                        className="editor-diff-line-copy"
                        onClick={() => handleCopyText(line.newText, 'diff-' + idx)}
                        aria-label={`Copy line ${idx + 1}`}
                        title="Copy line"
                      >
                        {copyFeedback === 'diff-' + idx ? '✓' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {activeFile ? (
              <>
                <div className="editor-monaco-wrapper">
                  <Editor
                    className="editor-monaco"
                    language={detectLanguage(activeFile.path)}
                    value={activeFile.content}
                    onChange={(value) => handleUpdateFileContent(value ?? '')}
                    theme="vs-dark"
                    options={{
                      fontSize: 13,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                  />
                </div>
                {(inlineSuggestionLoading || inlineSuggestion) && (
                  <div className="editor-inline-suggestion">
                    {inlineSuggestionLoading && !inlineSuggestion && (
                      <span className="editor-inline-suggestion-text">Getting suggestion…</span>
                    )}
                    {inlineSuggestion && (
                      <>
                        <span className="editor-inline-suggestion-label">Suggestion:</span>
                        <pre className="editor-inline-suggestion-code">{inlineSuggestion}</pre>
                        <button
                          type="button"
                          className="editor-inline-suggestion-btn"
                          onClick={() => {
                            const base = activeFile.content
                            const needsNewline = base.length && !base.endsWith('\n')
                            const next =
                              base + (needsNewline ? '\n' : '') + inlineSuggestion + '\n'
                            handleUpdateFileContent(next)
                            setInlineSuggestion(null)
                          }}
                        >
                          Insert
                        </button>
                        <button
                          type="button"
                          className="editor-inline-suggestion-btn secondary"
                          onClick={() => setInlineSuggestion(null)}
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="editor-empty">Select or add a file in the sidebar.</div>
            )}
          </div>
          <div className="main-pane-right">
            <div className="panel-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={rightPanelTab === 'chat'}
                className={`panel-tab ${rightPanelTab === 'chat' ? 'active' : ''}`}
                onClick={() => setRightPanelTab('chat')}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightPanelTab === 'context'}
                className={`panel-tab ${rightPanelTab === 'context' ? 'active' : ''}`}
                onClick={() => setRightPanelTab('context')}
              >
                Context
              </button>
            </div>
            <div className="panel-content">
              {rightPanelTab === 'chat' && (
                <>
                  <div className="chat-header">
                    <div className="chat-subtitle">
                      Project: {activeProject.name} · Chat: {activeChat.name}
                    </div>
                  </div>
                  <div className="chat-window">
                    {messages.length === 0 && (
                      <div className="chat-empty">
                        <div className="chat-empty-title">Welcome to Cloudflare Code Assistant</div>
                        <div className="chat-empty-subtitle">
                          Edit files on the left and ask questions here.
                        </div>
                      </div>
                    )}
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`chat-message chat-message-${m.role}`}
                    >
                      <div className="chat-message-meta">
                        <span className="chat-message-author">
                          {m.role === 'user' ? 'You' : 'Assistant'}
                        </span>
                        <button
                          type="button"
                          className="chat-copy-btn"
                          onClick={() => handleCopyText(m.content, 'chat-' + m.id)}
                          aria-label="Copy message text"
                        >
                          {copyFeedback === 'chat-' + m.id ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="chat-message-bubble">
                        <pre className="chat-message-text">{m.content}</pre>
                      </div>
                    </div>
                  ))}
                    {isSending && (
                      <div className="chat-message chat-message-assistant">
                        <div className="chat-message-meta">
                          <span className="chat-message-author">Assistant</span>
                        </div>
                        <div className="chat-message-bubble">
                          <span className="chat-typing">Thinking…</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <form className="chat-input-row" onSubmit={handleSubmit}>
                    <textarea
                      className="chat-input"
                      placeholder="Ask about your project or paste code…"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      rows={3}
                    />
                    <div className="chat-input-actions">
                      <button
                        type="submit"
                        disabled={isSending || !input.trim()}
                        className="chat-send-button"
                      >
                        {isSending ? 'Sending…' : 'Send'}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {rightPanelTab === 'context' && (
                <div className="right-pane right-pane-in-panel">
                  <div className="right-pane-section">
                    <div className="right-pane-title">Context</div>
                    <div className="right-pane-body">
                      <p>
                        This assistant now supports multiple projects, chats, and virtual files. The
                        currently active file is appended to your prompt when you send a message.
                      </p>
                      <p>
                        Use this to simulate different repositories or files when testing the Worker and
                        UI, similar to a lightweight Cursor-like experience.
        </p>
      </div>
                  </div>
                  <div className="right-pane-section">
                    <div className="right-pane-title">Share &amp; import</div>
                    <div className="right-pane-body">
                      <p>Share the current project with another user so it appears in their shared projects list.</p>
                      <p className="right-pane-label" style={{ marginTop: '0.5rem' }}>
                        Share with username
                      </p>
                      <div className="auth-form">
                        <input
                          className="account-input"
                          type="text"
                          placeholder="Partner's username"
                          value={shareTargetUsername}
                          onChange={(e) => setShareTargetUsername(e.target.value)}
                        />
                        <button
                          type="button"
                          className="chat-send-button secondary"
                          onClick={handleShareProject}
                        >
                          Share current project
                        </button>
                      </div>
                      {shareStatus && (
                        <p className={shareStatus.startsWith('Shared') ? 'share-status' : 'auth-error'}>
                          {shareStatus}
                        </p>
                      )}
                      <p className="right-pane-label" style={{ marginTop: '0.75rem' }}>
                        Projects shared with you
                      </p>
                      <p className="right-pane-hint">
                        Click below to refresh. You&apos;ll see projects <strong>others shared with you</strong> and
                        projects <strong>you shared with someone</strong>—open any copy in your workspace. Sharing uses
                        the same Cloudflare KV as this Worker: if you get Unauthorized, log out and log in again; you
                        and your partner should use the same dev setup (same machine or same deployed URL).
                      </p>
                      <div className="auth-form">
                        <button
                          type="button"
                          className="chat-send-button"
                          disabled={importLoading}
                          onClick={handleImportList}
                        >
                          {importLoading ? 'Loading…' : 'Load shared projects'}
                        </button>
                        {importError && <p className="auth-error">{importError}</p>}
                      </div>
                      {importListFetched && (
                        <div className="shared-projects-panel" aria-live="polite">
                          <div className="shared-projects-panel-title">
                            {sharingTotal === 0
                              ? 'No sharing activity yet'
                              : `${sharingTotal} ${sharingTotal === 1 ? 'project' : 'projects'} (incoming + outgoing)`}
                          </div>
                          {sharingTotal === 0 ? (
                            <p className="shared-projects-empty">
                              Share a project with someone (enter their username and click Share)—then click Load again
                              and it will appear under &quot;You shared&quot;. Recipients see it under &quot;Shared with
                              you&quot; when they load.
                            </p>
                          ) : (
                            <>
                              {importIncoming.length > 0 && (
                                <>
                                  <div className="shared-projects-subheading">Shared with you</div>
                                  <ul className="shared-projects-list">
                                    {importIncoming.map((p) => (
                                      <li key={`in-${p.id}`} className="shared-projects-row">
                                        <div className="shared-projects-meta">
                                          <span className="shared-projects-name">{p.name}</span>
                                          {p.ownerId && (
                                            <span className="shared-projects-owner">from @{p.ownerId}</span>
                                          )}
                                        </div>
                                        <button
                                          type="button"
                                          className="shared-projects-open-btn"
                                          onClick={() => handleImportProject(p.id)}
                                        >
                                          Open
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                              {importOutgoing.length > 0 && (
                                <>
                                  <div className="shared-projects-subheading shared-projects-subheading-out">
                                    You shared
                                  </div>
                                  <ul className="shared-projects-list">
                                    {importOutgoing.map((p) => (
                                      <li key={`out-${p.id}`} className="shared-projects-row">
                                        <div className="shared-projects-meta">
                                          <span className="shared-projects-name">{p.name}</span>
                                          {p.sharedWith && (
                                            <span className="shared-projects-owner">with @{p.sharedWith}</span>
                                          )}
                                        </div>
                                        <button
                                          type="button"
                                          className="shared-projects-open-btn"
                                          onClick={() => handleImportProject(p.id)}
                                        >
                                          Open
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
