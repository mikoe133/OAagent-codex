"use client"

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react"
import { PanelLeftClose, PanelLeftOpen, SquarePen } from "lucide-react"
import { gsap } from "gsap"
import { MessageList } from "./message-list"
import { Composer } from "./composer"
import { Button } from "@/components/ui/button"
import Sider, {
  type ChatSessionListItem,
  type SessionIndicatorState,
} from "@/components/siderbar/Sider"
import {
  DEFAULT_MODEL_PROVIDER,
  getDefaultModel,
  isModelForProvider,
  isModelProvider,
  type AIModel,
  type ModelProvider,
} from "@/lib/model-catalog"
import {
  drainChatSseBuffer,
  isToolTimelineEvent,
  mergeMessageTraceDelta,
  mergeToolTimelineEvent,
  type ChatStreamEvent,
  type TraceMessage,
  type ToolStep,
} from "./chat-stream"
import { resolveLoadedSessionMessages } from "./session-messages"
// import LineSidebar from "./siderbar"

// Data model for messages
export type MessageStatus = "streaming" | "completed" | "stopped" | "failed"
export type MessageFeedback = "like" | "dislike" | null

export interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: Date
  imageData?: string
  toolSteps?: ToolStep[]
  traceMessages?: TraceMessage[]
  status?: MessageStatus
  error?: string
  feedback?: MessageFeedback
}

export type { ToolStep, ToolStepStatus, TraceMessage } from "./chat-stream"

// localStorage key for persisting messages
const STORAGE_KEY = "chat-messages"
const MODEL_STORAGE_KEY = "chat-selected-model"
const MODEL_PROVIDER_STORAGE_KEY = "chat-model-provider"
const AGENT_SESSION_STORAGE_KEY = "chat-agent-session-id"
const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
const SIDEBAR_WIDTH = 320
const SIDEBAR_DESKTOP_QUERY = "(min-width: 640px)"
const COLLAPSED_CONTROL_LEFT = 16
const EXPANDED_CONTROL_LEFT = SIDEBAR_WIDTH + COLLAPSED_CONTROL_LEFT
const TYPEWRITER_INTERVAL_MS = 18
const SESSION_INDICATOR_VIEWED_HOLD_MS = 1500
const SESSION_INDICATOR_FADE_MS = 500
const FLOATING_CONTROL_BUTTON_CLASS =
  "h-10 w-10 rounded-full bg-zinc-100 text-stone-600 hover:bg-zinc-200 theme-dark:bg-zinc-800 theme-dark:text-zinc-300 theme-dark:hover:bg-zinc-700"

type ChatSessionRecord = {
  sessionId: string
  recordId?: string | number
  messages?: StoredMessage[]
}

type StoredMessage = {
  id?: unknown
  role?: unknown
  content?: unknown
  createdAt?: unknown
  imageData?: unknown
  toolSteps?: unknown
  status?: unknown
  error?: unknown
  feedback?: unknown
}

type ChatSessionResponse = {
  session?: ChatSessionRecord
}

type ActiveSessionRun = {
  requestId: string
  controller: AbortController
}

type SessionIndicatorTimers = {
  pause?: ReturnType<typeof setTimeout>
  dismiss?: ReturnType<typeof setTimeout>
}

// Generates a unique ID for messages
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

function createAgentSessionId(): string {
  return `web-${generateId()}`
}

function getOrCreateAgentSessionId(): string {
  if (typeof window === "undefined") {
    return createAgentSessionId()
  }

  try {
    const stored = localStorage.getItem(AGENT_SESSION_STORAGE_KEY)
    if (stored && AGENT_SESSION_ID_PATTERN.test(stored)) {
      return stored
    }

    const sessionId = createAgentSessionId()
    localStorage.setItem(AGENT_SESSION_STORAGE_KEY, sessionId)
    return sessionId
  } catch {
    return createAgentSessionId()
  }
}

function persistAgentSessionId(sessionId: string): void {
  try {
    localStorage.setItem(AGENT_SESSION_STORAGE_KEY, sessionId)
  } catch (error) {
    console.error("Failed to save agent session id:", error)
  }
}

function resolveTypewriterStep(pendingLength: number): number {
  if (pendingLength > 2400) return 24
  if (pendingLength > 1200) return 16
  if (pendingLength > 600) return 10
  if (pendingLength > 240) return 6
  if (pendingLength > 80) return 3
  return 1
}

function nextTypewriterEndIndex(text: string, startIndex: number, maxChars: number): number {
  let index = startIndex

  for (let count = 0; count < maxChars && index < text.length; count += 1) {
    const codePoint = text.codePointAt(index)
    index += codePoint && codePoint > 0xffff ? 2 : 1
  }

  return index
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function createChatSession(sessionId: string): Promise<ChatSessionRecord | null> {
  const response = await fetch("/api/chat/sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId }),
  })

  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent("/chat")}`)
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`)
  }

  const payload = (await response.json()) as ChatSessionResponse
  return payload.session || null
}

async function loadChatSession(session: ChatSessionListItem): Promise<ChatSessionRecord | null> {
  const searchParams = new URLSearchParams()
  if (session.recordId) {
    searchParams.set("recordId", String(session.recordId))
  } else {
    searchParams.set("sessionId", session.sessionId)
  }

  const response = await fetch(`/api/chat/sessions?${searchParams.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  })

  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent("/chat")}`)
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to load session: ${response.status}`)
  }

  const payload = (await response.json()) as ChatSessionResponse
  return payload.session || null
}

async function saveChatSession(input: {
  sessionId: string
  recordId: string | number | null
  messages: Message[]
}): Promise<ChatSessionRecord | null> {
  const response = await fetch("/api/chat/sessions", {
    method: "PATCH",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      recordId: input.recordId,
      messages: input.messages.map(serializeMessage),
    }),
  })

  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent("/chat")}`)
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to save session: ${response.status}`)
  }

  const payload = (await response.json()) as ChatSessionResponse
  return payload.session || null
}

async function deleteChatSession(session: ChatSessionListItem): Promise<void> {
  const response = await fetch("/api/chat/sessions", {
    method: "DELETE",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(session),
  })

  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent("/chat")}`)
    throw new Error("Authentication required")
  }

  if (!response.ok) {
    throw new Error(await readResponseError(response))
  }
}

async function readResponseError(response: Response): Promise<string> {
  const fallback = `Request failed with status ${response.status}`
  const text = await response.text()
  if (!text.trim()) {
    return fallback
  }

  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown }
    return stringValue(payload.error) || stringValue(payload.message) || fallback
  } catch {
    return text.trim()
  }
}

function serializeMessage(message: Message): StoredMessage {
  return {
    ...message,
    createdAt: message.createdAt.toISOString(),
  }
}

function normalizeStoredMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map(normalizeStoredMessage).filter((message): message is Message => Boolean(message))
}

function normalizeStoredMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const message = value as StoredMessage
  if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
    return null
  }

  const createdAt = typeof message.createdAt === "string" ? new Date(message.createdAt) : new Date()
  const status = normalizeStoredMessageStatus(message.status, message.role)
  const feedback = message.feedback === "like" || message.feedback === "dislike" ? message.feedback : null
  const messageError = stringValue(message.error)

  return {
    id: typeof message.id === "string" && message.id ? message.id : generateId(),
    role: message.role,
    content: message.content,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    ...(typeof message.imageData === "string" ? { imageData: message.imageData } : {}),
    ...(Array.isArray(message.toolSteps) ? { toolSteps: normalizeStoredToolSteps(message.toolSteps) } : {}),
    ...(status ? { status } : {}),
    ...(messageError ? { error: messageError } : {}),
    ...(feedback ? { feedback } : {}),
  }
}

function normalizeStoredMessageStatus(value: unknown, role: "user" | "assistant"): MessageStatus | undefined {
  if (role === "user") {
    return undefined
  }
  if (value === "streaming") {
    return "stopped"
  }
  if (value === "completed" || value === "stopped" || value === "failed") {
    return value
  }
  return "completed"
}

function normalizeStoredToolSteps(value: unknown[]): ToolStep[] {
  return value.map(normalizeStoredToolStep).filter((step): step is ToolStep => Boolean(step))
}

function normalizeStoredToolStep(value: unknown): ToolStep | null {
  const step = toRecord(value)
  if (!step) {
    return null
  }

  const id = stringValue(step.id)
  const type = stringValue(step.type)
  const title = stringValue(step.title)
  const description = stringValue(step.description)
  const status = normalizeStoredToolStatus(step.status)
  const input = typeof step.input === "string" && step.input.trim() ? step.input : null
  const output = typeof step.output === "string" && step.output.trim() ? step.output : null

  if (!id || !type || !title || !description) {
    return null
  }

  return {
    id,
    type,
    title,
    description,
    status,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  }
}

function normalizeStoredToolStatus(value: unknown): ToolStep["status"] {
  if (value === "running") {
    return "info"
  }
  if (value === "completed" || value === "failed" || value === "info") {
    return value
  }
  return "info"
}

export function ChatShell({ oaNavigationUrl }: { oaNavigationUrl: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set())
  const [sessionIndicatorStates, setSessionIndicatorStates] = useState<Map<string, SessionIndicatorState>>(
    () => new Map(),
  )
  const [error, setError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>(DEFAULT_MODEL_PROVIDER)
  const [selectedModel, setSelectedModel] = useState<AIModel>(() => getDefaultModel(DEFAULT_MODEL_PROVIDER))
  const [agentSessionId, setAgentSessionId] = useState("")
  const [activeRecordId, setActiveRecordId] = useState<string | number | null>(null)
  const [sessionListRefreshKey, setSessionListRefreshKey] = useState(0)
  const [sessionListFocusKey, setSessionListFocusKey] = useState(0)
  const [isSiderCollapsed, setIsSiderCollapsed] = useState(false)
  const [isMobileSiderOpen, setIsMobileSiderOpen] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const siderRef = useRef<HTMLElement | null>(null)
  const sidebarControlsRef = useRef<HTMLDivElement | null>(null)
  const messageLayoutRef = useRef<HTMLDivElement | null>(null)
  const composerLayoutRef = useRef<HTMLDivElement | null>(null)
  const hasAppliedSiderLayoutRef = useRef(false)
  const activeSessionIdRef = useRef("")
  const activeSessionRunsRef = useRef(new Map<string, ActiveSessionRun>())
  const sessionIndicatorStatesRef = useRef(new Map<string, SessionIndicatorState>())
  const sessionIndicatorTimersRef = useRef(new Map<string, SessionIndicatorTimers>())
  const messagesRef = useRef<Message[]>([])
  const sessionMessagesRef = useRef(new Map<string, Message[]>())
  const sessionSaveQueuesRef = useRef(new Map<string, Promise<void>>())
  const deletedSessionIdsRef = useRef(new Set<string>())
  const isStreaming = Boolean(agentSessionId && runningSessionIds.has(agentSessionId))

  // Load messages from localStorage on mount
  useEffect(() => {
    try {
      let storedMessages: Message[] = []
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        storedMessages = normalizeStoredMessages(parsed)
        messagesRef.current = storedMessages
        setMessages(storedMessages)
      }
      const savedProvider = localStorage.getItem(MODEL_PROVIDER_STORAGE_KEY)
      const provider = isModelProvider(savedProvider) ? savedProvider : DEFAULT_MODEL_PROVIDER
      const savedModel = localStorage.getItem(MODEL_STORAGE_KEY)
      setSelectedProvider(provider)
      if (isModelForProvider(provider, savedModel)) {
        setSelectedModel(savedModel)
      } else {
        const defaultModel = getDefaultModel(provider)
        setSelectedModel(defaultModel)
        localStorage.setItem(MODEL_STORAGE_KEY, defaultModel)
      }
      const currentSessionId = getOrCreateAgentSessionId()
      activeSessionIdRef.current = currentSessionId
      sessionMessagesRef.current.set(currentSessionId, storedMessages)
      setAgentSessionId(currentSessionId)
    } catch (e) {
      console.error("Failed to load from localStorage:", e)
    } finally {
      setIsLoaded(true)
    }
  }, [])

  useEffect(() => {
    activeSessionIdRef.current = agentSessionId
  }, [agentSessionId])

  useEffect(
    () => () => {
      sessionIndicatorTimersRef.current.forEach(({ pause, dismiss }) => {
        if (pause) clearTimeout(pause)
        if (dismiss) clearTimeout(dismiss)
      })
      sessionIndicatorTimersRef.current.clear()
    },
    [],
  )

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    messagesRef.current = messages

    const currentSessionId = activeSessionIdRef.current
    if (currentSessionId) {
      sessionMessagesRef.current.set(currentSessionId, messages)
    }

    if (!isLoaded) {
      return
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    } catch (e) {
      console.error("Failed to save messages to localStorage:", e)
    }
  }, [isLoaded, messages])

  const animateSiderLayout = useCallback(
    (animate: boolean) => {
      if (typeof window === "undefined") {
        return
      }

      const isDesktop = window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches
      const sider = siderRef.current
      const controls = sidebarControlsRef.current
      const layoutTargets = [messageLayoutRef.current, composerLayoutRef.current].filter(
        (target): target is HTMLDivElement => Boolean(target),
      )
      const tweenTargets = [sider, controls, ...layoutTargets].filter(
        (target): target is HTMLElement => Boolean(target),
      )

      if (tweenTargets.length > 0) {
        gsap.killTweensOf(tweenTargets)
      }

      if (!isDesktop) {
        if (sider) {
          gsap.set(sider, { clearProps: "transform,opacity,visibility,pointerEvents" })
        }
        if (controls) {
          gsap.set(controls, { clearProps: "left" })
        }
        if (layoutTargets.length > 0) {
          gsap.set(layoutTargets, { clearProps: "left" })
        }
        return
      }

      const duration = animate ? 0.42 : 0
      const ease = "power3.inOut"
      const nextLayoutLeft = isSiderCollapsed ? 0 : SIDEBAR_WIDTH
      const nextControlLeft = isSiderCollapsed ? COLLAPSED_CONTROL_LEFT : EXPANDED_CONTROL_LEFT

      if (sider) {
        if (!isSiderCollapsed) {
          gsap.set(sider, { pointerEvents: "auto", visibility: "visible" })
        }

        gsap.to(sider, {
          x: isSiderCollapsed ? -SIDEBAR_WIDTH : 0,
          autoAlpha: isSiderCollapsed ? 0 : 1,
          duration,
          ease,
          onComplete: () => {
            if (isSiderCollapsed) {
              gsap.set(sider, { pointerEvents: "none" })
            }
          },
        })
      }

      if (controls) {
        gsap.to(controls, {
          left: nextControlLeft,
          duration,
          ease,
        })
      }

      if (layoutTargets.length > 0) {
        gsap.to(layoutTargets, {
          left: nextLayoutLeft,
          duration,
          ease,
        })
      }
    },
    [isSiderCollapsed],
  )

  useLayoutEffect(() => {
    animateSiderLayout(hasAppliedSiderLayoutRef.current)
    hasAppliedSiderLayoutRef.current = true
  }, [animateSiderLayout])

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    const handleResize = () => {
      animateSiderLayout(false)
      if (window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches) {
        setIsMobileSiderOpen(false)
      }
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [animateSiderLayout])

  useEffect(() => {
    if (!isMobileSiderOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileSiderOpen(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isMobileSiderOpen])

  const handleModelChange = useCallback(
    (model: AIModel) => {
      if (!isModelForProvider(selectedProvider, model)) {
        return
      }
      setSelectedModel(model)
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    },
    [selectedProvider],
  )

  const handleProviderChange = useCallback((provider: ModelProvider) => {
    const defaultModel = getDefaultModel(provider)
    setSelectedProvider(provider)
    setSelectedModel(defaultModel)
    localStorage.setItem(MODEL_PROVIDER_STORAGE_KEY, provider)
    localStorage.setItem(MODEL_STORAGE_KEY, defaultModel)
  }, [])

  const persistMessages = useCallback(
    (sessionId: string, recordId: string | number | null, nextMessages: Message[]) => {
      if (deletedSessionIdsRef.current.has(sessionId)) {
        return Promise.resolve()
      }

      const previousSave = sessionSaveQueuesRef.current.get(sessionId) || Promise.resolve()
      const currentSave = previousSave
        .catch(() => undefined)
        .then(async () => {
          if (deletedSessionIdsRef.current.has(sessionId)) {
            return
          }

          try {
            const session = await saveChatSession({ sessionId, recordId, messages: nextMessages })
            if (session?.recordId && activeSessionIdRef.current === sessionId) {
              setActiveRecordId(session.recordId)
            }
          } catch (saveError) {
            console.error("Failed to save chat session:", saveError)
          } finally {
            setSessionListRefreshKey((value) => value + 1)
          }
        })

      sessionSaveQueuesRef.current.set(sessionId, currentSave)
      void currentSave.finally(() => {
        if (sessionSaveQueuesRef.current.get(sessionId) === currentSave) {
          sessionSaveQueuesRef.current.delete(sessionId)
        }
      })

      return currentSave
    },
    [],
  )

  const clearSessionIndicatorTimers = useCallback((sessionId: string) => {
    const timers = sessionIndicatorTimersRef.current.get(sessionId)
    if (timers?.pause) clearTimeout(timers.pause)
    if (timers?.dismiss) clearTimeout(timers.dismiss)
    sessionIndicatorTimersRef.current.delete(sessionId)
  }, [])

  const setSessionIndicatorState = useCallback(
    (sessionId: string, state: SessionIndicatorState) => {
      sessionIndicatorStatesRef.current.set(sessionId, state)
      setSessionIndicatorStates(new Map(sessionIndicatorStatesRef.current))
    },
    [],
  )

  const clearSessionIndicator = useCallback(
    (sessionId: string) => {
      clearSessionIndicatorTimers(sessionId)
      if (sessionIndicatorStatesRef.current.delete(sessionId)) {
        setSessionIndicatorStates(new Map(sessionIndicatorStatesRef.current))
      }
    },
    [clearSessionIndicatorTimers],
  )

  const dismissSessionIndicator = useCallback(
    (sessionId: string) => {
      if (sessionIndicatorStatesRef.current.get(sessionId) !== "paused") {
        return
      }

      clearSessionIndicatorTimers(sessionId)
      setSessionIndicatorState(sessionId, "dismissing")
      const dismiss = setTimeout(() => {
        if (sessionIndicatorStatesRef.current.get(sessionId) === "dismissing") {
          sessionIndicatorStatesRef.current.delete(sessionId)
          setSessionIndicatorStates(new Map(sessionIndicatorStatesRef.current))
        }
        sessionIndicatorTimersRef.current.delete(sessionId)
      }, SESSION_INDICATOR_FADE_MS)
      sessionIndicatorTimersRef.current.set(sessionId, { dismiss })
    },
    [clearSessionIndicatorTimers, setSessionIndicatorState],
  )

  const pauseSessionIndicator = useCallback(
    (sessionId: string) => {
      clearSessionIndicatorTimers(sessionId)
      setSessionIndicatorState(sessionId, "paused")

      if (activeSessionIdRef.current !== sessionId) {
        return
      }

      const pause = setTimeout(() => {
        if (activeSessionIdRef.current !== sessionId) {
          sessionIndicatorTimersRef.current.delete(sessionId)
          return
        }
        dismissSessionIndicator(sessionId)
      }, SESSION_INDICATOR_VIEWED_HOLD_MS)
      sessionIndicatorTimersRef.current.set(sessionId, { pause })
    },
    [clearSessionIndicatorTimers, dismissSessionIndicator, setSessionIndicatorState],
  )

  // Send a message to the AI
  const sendMessage = useCallback(
    async (content: string, imageData?: string) => {
      if (!content.trim() && !imageData) return

      const currentAgentSessionId = agentSessionId || getOrCreateAgentSessionId()
      if (activeSessionRunsRef.current.has(currentAgentSessionId)) {
        return
      }

      setError(null)
      const conversationMessages = messagesRef.current

      const userMessage: Message = {
        id: generateId(),
        role: "user",
        content: content.trim() || "Describe this image",
        createdAt: new Date(),
        imageData,
      }

      const assistantMessage: Message = {
        id: generateId(),
        role: "assistant",
        content: "",
        createdAt: new Date(),
        status: "streaming",
      }

      if (!agentSessionId) {
        activeSessionIdRef.current = currentAgentSessionId
        setAgentSessionId(currentAgentSessionId)
      }

      const requestId = generateId()
      const controller = new AbortController()
      activeSessionRunsRef.current.set(currentAgentSessionId, { requestId, controller })
      setRunningSessionIds((current) => new Set(current).add(currentAgentSessionId))
      clearSessionIndicatorTimers(currentAgentSessionId)
      setSessionIndicatorState(currentAgentSessionId, "running")

      const newMessages = [...conversationMessages, userMessage, assistantMessage]
      let currentMessages = newMessages
      messagesRef.current = newMessages
      sessionMessagesRef.current.set(currentAgentSessionId, newMessages)
      setMessages(newMessages)
      void persistMessages(currentAgentSessionId, activeRecordId, newMessages)

      let cancelPendingTypewriter = () => {}
      let accumulatedContent = ""
      let visibleContent = ""
      let currentToolSteps: ToolStep[] = []
      let currentTraceMessages: TraceMessage[] = []

      const isCurrentSessionRun = () =>
        activeSessionRunsRef.current.get(currentAgentSessionId)?.requestId === requestId

      const publishSessionMessages = (nextMessages: Message[]) => {
        if (!isCurrentSessionRun()) {
          return
        }

        currentMessages = nextMessages
        sessionMessagesRef.current.set(currentAgentSessionId, nextMessages)
        if (activeSessionIdRef.current === currentAgentSessionId) {
          messagesRef.current = nextMessages
          setMessages(nextMessages)
        }
      }

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: currentAgentSessionId,
            messages: [...conversationMessages, userMessage].map((m) => ({
              role: m.role,
              content: m.content,
              imageData: m.imageData,
            })),
            provider: selectedProvider,
            model: selectedModel,
          }),
          signal: controller.signal,
        })

        if (response.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent("/chat")}`)
          throw new Error("Please sign in again.")
        }

        if (!response.ok) {
          throw new Error(await readResponseError(response))
        }

        const reader = response.body?.getReader()
        const decoder = new TextDecoder()

        if (!reader) {
          throw new Error("No response body")
        }

        let typewriterTimer: ReturnType<typeof setTimeout> | null = null
        let typewriterCancelled = false
        let typewriterFlushPromise: Promise<void> | null = null
        let resolveTypewriterFlush: (() => void) | null = null

        const updateAssistantMessage = (content: string) => {
          const nextMessages = currentMessages.map((message) =>
            message.id === assistantMessage.id ? { ...message, content, status: "streaming" as const } : message,
          )
          publishSessionMessages(nextMessages)
        }

        const updateAssistantToolSteps = (nextSteps: ToolStep[]) => {
          currentToolSteps = nextSteps
          const nextMessages = currentMessages.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  toolSteps: nextSteps.length > 0 ? nextSteps : undefined,
                }
              : message,
          )
          publishSessionMessages(nextMessages)
        }

        const updateAssistantTraceMessages = (nextTraceMessages: TraceMessage[]) => {
          currentTraceMessages = nextTraceMessages
          const nextMessages = currentMessages.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  traceMessages: nextTraceMessages.length > 0 ? nextTraceMessages : undefined,
                }
              : message,
          )
          publishSessionMessages(nextMessages)
        }

        const resolveFlushIfIdle = () => {
          if (visibleContent.length >= accumulatedContent.length && resolveTypewriterFlush) {
            resolveTypewriterFlush()
            resolveTypewriterFlush = null
            typewriterFlushPromise = null
          }
        }

        const runTypewriterTick = () => {
          typewriterTimer = null

          if (typewriterCancelled) {
            resolveFlushIfIdle()
            return
          }

          const pendingLength = accumulatedContent.length - visibleContent.length
          if (pendingLength <= 0) {
            resolveFlushIfIdle()
            return
          }

          const nextEndIndex = nextTypewriterEndIndex(
            accumulatedContent,
            visibleContent.length,
            resolveTypewriterStep(pendingLength),
          )
          visibleContent = accumulatedContent.slice(0, nextEndIndex)
          updateAssistantMessage(visibleContent)

          if (visibleContent.length < accumulatedContent.length) {
            typewriterTimer = setTimeout(runTypewriterTick, TYPEWRITER_INTERVAL_MS)
            return
          }

          resolveFlushIfIdle()
        }

        const scheduleTypewriter = () => {
          if (typewriterTimer || typewriterCancelled) {
            return
          }

          typewriterTimer = setTimeout(runTypewriterTick, TYPEWRITER_INTERVAL_MS)
        }

        const waitForTypewriterFlush = () => {
          if (visibleContent.length >= accumulatedContent.length) {
            return Promise.resolve()
          }

          if (!typewriterFlushPromise) {
            typewriterFlushPromise = new Promise<void>((resolve) => {
              resolveTypewriterFlush = resolve
            })
          }

          scheduleTypewriter()
          return typewriterFlushPromise
        }

        const cancelTypewriter = () => {
          typewriterCancelled = true

          if (typewriterTimer) {
            clearTimeout(typewriterTimer)
            typewriterTimer = null
          }

          if (resolveTypewriterFlush) {
            resolveTypewriterFlush()
            resolveTypewriterFlush = null
            typewriterFlushPromise = null
          }
        }
        cancelPendingTypewriter = cancelTypewriter

        const appendAssistantContent = (delta: string) => {
          if (!delta) {
            return
          }

          accumulatedContent += delta
          scheduleTypewriter()
        }

        const applyFinalContent = (finalContent: string) => {
          if (!finalContent || finalContent === accumulatedContent) {
            return
          }

          if (finalContent.startsWith(accumulatedContent)) {
            appendAssistantContent(finalContent.slice(accumulatedContent.length))
            return
          }

          accumulatedContent = finalContent
          if (finalContent.startsWith(visibleContent)) {
            scheduleTypewriter()
          } else {
            visibleContent = finalContent
            updateAssistantMessage(finalContent)
          }
        }

        let terminalStreamError: Error | null = null

        const handleChatStreamEvent = (event: ChatStreamEvent) => {
          if (isToolTimelineEvent(stringValue(event.type))) {
            updateAssistantToolSteps(mergeToolTimelineEvent(currentToolSteps, event))
            return
          }

          if (event.type === "message.delta" && typeof event.delta === "string") {
            const latestToolStepId = currentToolSteps[currentToolSteps.length - 1]?.id ?? null
            updateAssistantTraceMessages(
              mergeMessageTraceDelta(currentTraceMessages, event, latestToolStepId),
            )
            appendAssistantContent(event.delta)
            return
          }

          if (event.type === "run.completed") {
            const finalResponse = toRecord(event.result)?.finalResponse
            if (typeof finalResponse === "string") {
              applyFinalContent(finalResponse)
            }
            return
          }

          if (event.type === "run.failed") {
            terminalStreamError = new Error(typeof event.error === "string" ? event.error : "Agent run failed")
          }
        }

        const isEventStream = response.headers.get("content-type")?.includes("text/event-stream") ?? false
        if (isEventStream) {
          let streamBuffer = ""

          while (true) {
            const { done, value } = await reader.read()

            if (done) break

            streamBuffer += decoder.decode(value, { stream: true })
            streamBuffer = drainChatSseBuffer(streamBuffer, handleChatStreamEvent)
            if (terminalStreamError) {
              await reader.cancel().catch(() => undefined)
              throw terminalStreamError
            }
          }

          streamBuffer += decoder.decode()
          drainChatSseBuffer(`${streamBuffer}\n\n`, handleChatStreamEvent)
          if (terminalStreamError) {
            await reader.cancel().catch(() => undefined)
            throw terminalStreamError
          }
        } else {
          while (true) {
            const { done, value } = await reader.read()

            if (done) break

            appendAssistantContent(decoder.decode(value, { stream: true }))
          }

          appendAssistantContent(decoder.decode())
        }

        await waitForTypewriterFlush()
        cancelTypewriter()
        currentToolSteps = currentToolSteps.map((step) =>
          step.status === "running" ? { ...step, status: "completed" as const } : step,
        )

        const completedMessages: Message[] = [
          ...conversationMessages,
          userMessage,
          {
            ...assistantMessage,
            content: accumulatedContent,
            status: "completed",
            ...(currentToolSteps.length > 0 ? { toolSteps: currentToolSteps } : {}),
          },
        ]

        publishSessionMessages(completedMessages)

        void persistMessages(currentAgentSessionId, activeRecordId, completedMessages)
      } catch (e) {
        cancelPendingTypewriter()

        const wasStopped = e instanceof Error && e.name === "AbortError"
        const errorMessage = e instanceof Error ? e.message : "An error occurred"
        currentToolSteps = currentToolSteps.map((step) =>
          step.status === "running"
            ? { ...step, status: wasStopped ? ("info" as const) : ("failed" as const) }
            : step,
        )

        const terminalMessages: Message[] = [
          ...conversationMessages,
          userMessage,
          {
            ...assistantMessage,
            content: accumulatedContent || visibleContent,
            status: wasStopped ? "stopped" : "failed",
            ...(!wasStopped ? { error: errorMessage } : {}),
            ...(currentToolSteps.length > 0 ? { toolSteps: currentToolSteps } : {}),
          },
        ]

        publishSessionMessages(terminalMessages)
        if (!wasStopped && activeSessionIdRef.current === currentAgentSessionId && isCurrentSessionRun()) {
          console.error("Error sending message:", e)
          setError(errorMessage)
        }

        void persistMessages(currentAgentSessionId, activeRecordId, terminalMessages)
      } finally {
        if (activeSessionRunsRef.current.get(currentAgentSessionId)?.requestId === requestId) {
          activeSessionRunsRef.current.delete(currentAgentSessionId)
          setRunningSessionIds((current) => {
            const next = new Set(current)
            next.delete(currentAgentSessionId)
            return next
          })
          pauseSessionIndicator(currentAgentSessionId)
        }
      }
    },
    [
      selectedProvider,
      selectedModel,
      agentSessionId,
      activeRecordId,
      persistMessages,
      clearSessionIndicatorTimers,
      pauseSessionIndicator,
      setSessionIndicatorState,
    ],
  )

  const retry = useCallback(() => {
    if (messages.length === 0) return
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")
    if (lastUserMessage) {
      const index = messages.findIndex((m) => m.id === lastUserMessage.id)
      const retryMessages = messages.slice(0, index)
      messagesRef.current = retryMessages
      if (agentSessionId) {
        sessionMessagesRef.current.set(agentSessionId, retryMessages)
      }
      setMessages(retryMessages)
      setError(null)
      setTimeout(() => sendMessage(lastUserMessage.content, lastUserMessage.imageData), 100)
    }
  }, [agentSessionId, messages, sendMessage])

  const stopStreaming = useCallback(() => {
    activeSessionRunsRef.current.get(agentSessionId)?.controller.abort()
  }, [agentSessionId])

  const handleMessageFeedback = useCallback(
    (messageId: string, feedback: Message["feedback"]) => {
      const nextMessages = messagesRef.current.map((message) =>
        message.id === messageId ? { ...message, feedback: feedback ?? null } : message,
      )
      messagesRef.current = nextMessages
      setMessages(nextMessages)

      const currentSessionId = activeSessionIdRef.current
      if (currentSessionId) {
        sessionMessagesRef.current.set(currentSessionId, nextMessages)
        void persistMessages(currentSessionId, activeRecordId, nextMessages)
      }
    },
    [activeRecordId, persistMessages],
  )

  const startNewSession = useCallback(() => {
    setSessionListFocusKey((value) => value + 1)

    if (!isStreaming && messagesRef.current.length === 0) {
      setError(null)
      return
    }

    const nextAgentSessionId = createAgentSessionId()

    messagesRef.current = []
    sessionMessagesRef.current.set(nextAgentSessionId, [])
    setMessages([])
    setError(null)
    localStorage.removeItem(STORAGE_KEY)
    activeSessionIdRef.current = nextAgentSessionId
    setAgentSessionId(nextAgentSessionId)
    setActiveRecordId(null)
    persistAgentSessionId(nextAgentSessionId)
    setSessionListRefreshKey((value) => value + 1)

    void createChatSession(nextAgentSessionId)
      .then((session) => {
        if (session?.recordId && activeSessionIdRef.current === nextAgentSessionId) {
          setActiveRecordId(session.recordId)
        }
      })
      .catch((error) => {
        console.error("Failed to create chat session:", error)
      })
      .finally(() => {
        setSessionListRefreshKey((value) => value + 1)
      })
  }, [isStreaming])

  const handleDeleteSession = useCallback(
    async (session: ChatSessionListItem) => {
      const { sessionId } = session
      deletedSessionIdsRef.current.add(sessionId)
      clearSessionIndicator(sessionId)

      const activeRun = activeSessionRunsRef.current.get(sessionId)
      if (activeRun) {
        activeSessionRunsRef.current.delete(sessionId)
        activeRun.controller.abort()
        setRunningSessionIds((current) => {
          const next = new Set(current)
          next.delete(sessionId)
          return next
        })
      }
      sessionMessagesRef.current.delete(sessionId)

      try {
        await sessionSaveQueuesRef.current.get(sessionId)?.catch(() => undefined)
        await deleteChatSession(session)
        sessionSaveQueuesRef.current.delete(sessionId)

        if (activeSessionIdRef.current === sessionId) {
          activeSessionIdRef.current = ""
          messagesRef.current = []
          setAgentSessionId("")
          setActiveRecordId(null)
          setMessages([])
          setError(null)
          try {
            localStorage.removeItem(STORAGE_KEY)
            localStorage.removeItem(AGENT_SESSION_STORAGE_KEY)
          } catch (storageError) {
            console.error("Failed to clear deleted session state:", storageError)
          }
        }

        setSessionListRefreshKey((value) => value + 1)
      } catch (error) {
        deletedSessionIdsRef.current.delete(sessionId)
        throw error
      }
    },
    [clearSessionIndicator],
  )

  const handleSelectSession = useCallback(
    async (session: ChatSessionListItem) => {
      let selectedSessionId = session.sessionId
      const cachedMessages = sessionMessagesRef.current.get(session.sessionId)
      setError(null)
      setIsLoaded(Boolean(cachedMessages))
      activeSessionIdRef.current = session.sessionId
      setAgentSessionId(session.sessionId)
      setActiveRecordId(session.recordId ?? null)
      persistAgentSessionId(session.sessionId)
      dismissSessionIndicator(session.sessionId)
      if (cachedMessages) {
        messagesRef.current = cachedMessages
        setMessages(cachedMessages)
      } else {
        messagesRef.current = []
        setMessages([])
      }

      try {
        const loadedSession = await loadChatSession(session)
        if (activeSessionIdRef.current !== session.sessionId) {
          return
        }
        const nextSessionId = loadedSession?.sessionId || session.sessionId
        selectedSessionId = nextSessionId

        activeSessionIdRef.current = nextSessionId
        setAgentSessionId(nextSessionId)
        setActiveRecordId(loadedSession?.recordId ?? session.recordId ?? null)
        const nextMessages = resolveLoadedSessionMessages(
          sessionMessagesRef.current.get(nextSessionId),
          normalizeStoredMessages(loadedSession?.messages),
          activeSessionRunsRef.current.has(nextSessionId) || sessionSaveQueuesRef.current.has(nextSessionId),
        )
        sessionMessagesRef.current.set(nextSessionId, nextMessages)
        messagesRef.current = nextMessages
        setMessages(nextMessages)
        persistAgentSessionId(nextSessionId)
      } catch (error) {
        if (activeSessionIdRef.current !== session.sessionId) {
          return
        }
        console.error("Failed to load chat session:", error)
        if (!cachedMessages) {
          messagesRef.current = []
          setMessages([])
        }
        setError(error instanceof Error ? error.message : "Failed to load chat session")
      } finally {
        if (activeSessionIdRef.current === selectedSessionId) {
          setIsLoaded(true)
        }
      }
    },
    [dismissSessionIndicator],
  )

  const toggleSider = useCallback(() => {
    setIsSiderCollapsed((current) => !current)
  }, [])

  const closeMobileSider = useCallback(() => {
    setIsMobileSiderOpen(false)
  }, [])

  const handleMobileNewSession = useCallback(() => {
    closeMobileSider()
    startNewSession()
  }, [closeMobileSider, startNewSession])

  const handleMobileSelectSession = useCallback(
    (session: ChatSessionListItem) => {
      closeMobileSider()
      void handleSelectSession(session)
    },
    [closeMobileSider, handleSelectSession],
  )

  const SiderToggleIcon = isSiderCollapsed ? PanelLeftOpen : PanelLeftClose

  return (
    <div
      data-slot="chat-shell"
      className="relative h-dvh bg-stone-50 theme-dark:bg-zinc-950"
      style={{
        boxShadow:
          "rgba(14, 63, 126, 0.04) 0px 0px 0px 1px, rgba(42, 51, 69, 0.04) 0px 1px 1px -0.5px, rgba(42, 51, 70, 0.04) 0px 3px 3px -1.5px, rgba(42, 51, 70, 0.04) 0px 6px 6px -3px, rgba(14, 63, 126, 0.04) 0px 12px 12px -6px, rgba(14, 63, 126, 0.04) 0px 24px 24px -12px",
      }}
    >
      <div ref={sidebarControlsRef} className="absolute left-4 top-7 z-50 hidden flex-col gap-3 sm:flex sm:left-[21rem]">
        <Button
          onClick={toggleSider}
          variant="ghost"
          size="icon"
          className={FLOATING_CONTROL_BUTTON_CLASS}
          aria-controls="chat-sider"
          aria-expanded={!isSiderCollapsed}
          aria-label={isSiderCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <SiderToggleIcon className="h-5 w-5" />
        </Button>
      </div>
      <Button
        onClick={() => setIsMobileSiderOpen(true)}
        variant="ghost"
        size="icon"
        className={`${FLOATING_CONTROL_BUTTON_CLASS} absolute left-4 top-4 z-20 sm:hidden`}
        aria-controls="chat-sider"
        aria-expanded={isMobileSiderOpen}
        aria-label="Open conversations"
      >
        <PanelLeftOpen className="h-5 w-5" />
      </Button>
      <Button
        onClick={startNewSession}
        variant="ghost"
        size="icon"
        className={`${FLOATING_CONTROL_BUTTON_CLASS} absolute left-4 top-20 z-20 sm:hidden`}
        aria-label="New chat"
      >
        <SquarePen className="h-5 w-5" />
      </Button>
      {isMobileSiderOpen && (
        <button
          data-slot="mobile-sider-backdrop"
          type="button"
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] sm:hidden"
          onClick={closeMobileSider}
          aria-label="Dismiss conversations"
        />
      )}
      <Sider
        ref={siderRef}
        activeSessionId={agentSessionId}
        activeRecordId={activeRecordId}
        isCollapsed={isSiderCollapsed}
        isMobileOpen={isMobileSiderOpen}
        focusSessionKey={sessionListFocusKey}
        onMobileClose={closeMobileSider}
        onNewSession={handleMobileNewSession}
        onSelectSession={handleMobileSelectSession}
        onDeleteSession={handleDeleteSession}
        refreshKey={sessionListRefreshKey}
        selectedProvider={selectedProvider}
        onProviderChange={handleProviderChange}
        providerSwitchDisabled={isStreaming}
        sessionIndicatorStates={sessionIndicatorStates}
      />
      {/*
      <div className="absolute left-0 top-1/2 z-30 -translate-y-1/2">
        <LineSidebar
          // 侧边栏条目名称数组
          items={["Overview", "Components", "Animations", "Backgrounds", "Showcase"]}
          // 高亮色
          accentColor="#E48AD9"
          // 文字颜色
          textColor="var(--color-gray-400)"
          // 滑块颜色
          markerColor="#6c6c6c"
          // 是否显示序号
          showIndex
          // 是否显示滑块
          showMarker
          // 鼠标靠近条目的感应范围
          proximityRadius={100}
          // 最大偏移量
          maxShift={20}
          // 滑块偏移的渐变类型（如"smooth"）
          falloff="smooth"
          // 滑块长度
          markerLength={50}
          // 滑块与每个条目之间的间隔
          markerGap={10}
          // 刻度缩放因子
          tickScale={0.5}
          // 是否显示刻度缩放
          scaleTick
          // 条目间距
          itemGap={30}
          // 字号缩放
          fontSize={1}
          // 平滑度参数
          smoothing={100}
          // 默认激活的条目索引
          defaultActive={0}
          // 点击条目时的回调
          onItemClick={(index, label) => console.log(index, label)}
        />
      </div>
      */}

      <div ref={messageLayoutRef} className="absolute inset-0 sm:left-80">
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          error={error}
          onRetry={retry}
          onFeedback={handleMessageFeedback}
          isLoaded={isLoaded}
          oaNavigationUrl={oaNavigationUrl}
        />
      </div>

      <Composer
        layoutRef={composerLayoutRef}
        onSend={sendMessage}
        onStop={stopStreaming}
        isStreaming={isStreaming}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
      />
    </div>
  )
}
