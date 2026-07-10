"use client"

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react"
import { PanelLeftClose, PanelLeftOpen, SquarePen } from "lucide-react"
import { gsap } from "gsap"
import { MessageList } from "./message-list"
import { Composer, type AIModel } from "./composer"
import { Button } from "@/components/ui/button"
import Sider, { type ChatSessionListItem } from "@/components/siderbar/Sider"
// import LineSidebar from "./siderbar"

// Data model for messages
export interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: Date
  imageData?: string
}

// localStorage key for persisting messages
const STORAGE_KEY = "chat-messages"
const MODEL_STORAGE_KEY = "chat-selected-model"
const AGENT_SESSION_STORAGE_KEY = "chat-agent-session-id"
const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
const SIDEBAR_WIDTH = 320
const SIDEBAR_DESKTOP_QUERY = "(min-width: 640px)"
const COLLAPSED_CONTROL_LEFT = 16
const EXPANDED_CONTROL_LEFT = SIDEBAR_WIDTH + COLLAPSED_CONTROL_LEFT
const TYPEWRITER_INTERVAL_MS = 18
const FLOATING_CONTROL_BUTTON_CLASS =
  "h-10 w-10 rounded-full bg-zinc-100 text-stone-600 hover:bg-zinc-200"

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
}

type ChatSessionResponse = {
  session?: ChatSessionRecord
}

type ChatStreamEvent = {
  type?: unknown
  delta?: unknown
  error?: unknown
  result?: {
    finalResponse?: unknown
  }
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

function drainChatSseBuffer(buffer: string, onEvent: (event: ChatStreamEvent) => void): string {
  const chunks = buffer.replace(/\r\n/g, "\n").split("\n\n")
  const remainder = chunks.pop() || ""

  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")

    if (!data) {
      continue
    }

    try {
      onEvent(JSON.parse(data) as ChatStreamEvent)
    } catch (error) {
      if (error instanceof SyntaxError) {
        continue
      }
      throw error
    }
  }

  return remainder
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

  return {
    id: typeof message.id === "string" && message.id ? message.id : generateId(),
    role: message.role,
    content: message.content,
    createdAt: typeof message.createdAt === "string" ? new Date(message.createdAt) : new Date(),
    ...(typeof message.imageData === "string" ? { imageData: message.imageData } : {}),
  }
}

export function ChatShell() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [selectedModel, setSelectedModel] = useState<AIModel>("google/gemini-2.0-flash-001")
  const [agentSessionId, setAgentSessionId] = useState("")
  const [activeRecordId, setActiveRecordId] = useState<string | number | null>(null)
  const [sessionListRefreshKey, setSessionListRefreshKey] = useState(0)
  const [isSiderCollapsed, setIsSiderCollapsed] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const siderRef = useRef<HTMLElement | null>(null)
  const sidebarControlsRef = useRef<HTMLDivElement | null>(null)
  const messageLayoutRef = useRef<HTMLDivElement | null>(null)
  const composerLayoutRef = useRef<HTMLDivElement | null>(null)
  const hasAppliedSiderLayoutRef = useRef(false)
  const activeSessionIdRef = useRef("")
  const messagesRef = useRef<Message[]>([])

  // Load messages from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        const storedMessages = normalizeStoredMessages(parsed)
        messagesRef.current = storedMessages
        setMessages(storedMessages)
      }
      const savedModel = localStorage.getItem(MODEL_STORAGE_KEY) as AIModel | null
      if (savedModel) {
        setSelectedModel(savedModel)
      }
      setAgentSessionId(getOrCreateAgentSessionId())
    } catch (e) {
      console.error("Failed to load from localStorage:", e)
    } finally {
      setIsLoaded(true)
    }
  }, [])

  useEffect(() => {
    activeSessionIdRef.current = agentSessionId
  }, [agentSessionId])

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    messagesRef.current = messages

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

    const handleResize = () => animateSiderLayout(false)

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [animateSiderLayout])

  const handleModelChange = useCallback((model: AIModel) => {
    setSelectedModel(model)
    localStorage.setItem(MODEL_STORAGE_KEY, model)
  }, [])

  // Send a message to the AI
  const sendMessage = useCallback(
    async (content: string, imageData?: string) => {
      if ((!content.trim() && !imageData) || isStreaming) return

      setError(null)

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
      }

      const newMessages = [...messages, userMessage, assistantMessage]
      messagesRef.current = newMessages
      setMessages(newMessages)
      setIsStreaming(true)

      const controller = new AbortController()
      setAbortController(controller)
      let cancelPendingTypewriter = () => {}

      try {
        const currentAgentSessionId = agentSessionId || getOrCreateAgentSessionId()
        if (!agentSessionId) {
          activeSessionIdRef.current = currentAgentSessionId
          setAgentSessionId(currentAgentSessionId)
        }

        const response = await fetch("/api/chat", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: currentAgentSessionId,
            messages: [...messages, userMessage].map((m) => ({
              role: m.role,
              content: m.content,
              imageData: m.imageData,
            })),
            model: selectedModel,
          }),
          signal: controller.signal,
        })

        if (response.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent("/chat")}`)
          throw new Error("Please sign in again.")
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const reader = response.body?.getReader()
        const decoder = new TextDecoder()

        if (!reader) {
          throw new Error("No response body")
        }

        let accumulatedContent = ""
        let visibleContent = ""
        let typewriterTimer: ReturnType<typeof setTimeout> | null = null
        let typewriterCancelled = false
        let typewriterFlushPromise: Promise<void> | null = null
        let resolveTypewriterFlush: (() => void) | null = null

        const updateAssistantMessage = (content: string) => {
          setMessages((prev) =>
            prev.map((msg) => (msg.id === assistantMessage.id ? { ...msg, content } : msg)),
          )
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
          visibleContent = ""
          updateAssistantMessage("")
          scheduleTypewriter()
        }

        const handleChatStreamEvent = (event: ChatStreamEvent) => {
          if (event.type === "message.delta" && typeof event.delta === "string") {
            appendAssistantContent(event.delta)
            return
          }

          if (event.type === "run.completed") {
            const finalResponse = event.result?.finalResponse
            if (typeof finalResponse === "string") {
              applyFinalContent(finalResponse)
            }
            return
          }

          if (event.type === "run.failed") {
            throw new Error(typeof event.error === "string" ? event.error : "Agent run failed")
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
          }

          streamBuffer += decoder.decode()
          drainChatSseBuffer(`${streamBuffer}\n\n`, handleChatStreamEvent)
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
        updateAssistantMessage(accumulatedContent)

        const completedMessages = [
          ...messages,
          userMessage,
          {
            ...assistantMessage,
            content: accumulatedContent,
          },
        ]
        messagesRef.current = completedMessages

        void saveChatSession({
          sessionId: currentAgentSessionId,
          recordId: activeRecordId,
          messages: completedMessages,
        })
          .then((session) => {
            if (session?.recordId && activeSessionIdRef.current === currentAgentSessionId) {
              setActiveRecordId(session.recordId)
            }
          })
          .catch((error) => {
            console.error("Failed to save chat session:", error)
          })
          .finally(() => {
            setSessionListRefreshKey((value) => value + 1)
          })

        setSessionListRefreshKey((value) => value + 1)
      } catch (e) {
        cancelPendingTypewriter()

        if (e instanceof Error && e.name === "AbortError") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessage.id ? { ...msg, content: msg.content || "[Cancelled]" } : msg,
            ),
          )
        } else {
          console.error("Error sending message:", e)
          setError(e instanceof Error ? e.message : "An error occurred")
          setMessages((prev) => {
            const nextMessages = prev.filter((msg) => msg.id !== assistantMessage.id)
            messagesRef.current = nextMessages
            return nextMessages
          })
        }
      } finally {
        setIsStreaming(false)
        setAbortController(null)
      }
    },
    [messages, isStreaming, selectedModel, agentSessionId, activeRecordId],
  )

  const retry = useCallback(() => {
    if (messages.length === 0) return
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")
    if (lastUserMessage) {
      const index = messages.findIndex((m) => m.id === lastUserMessage.id)
      setMessages(messages.slice(0, index))
      setError(null)
      setTimeout(() => sendMessage(lastUserMessage.content, lastUserMessage.imageData), 100)
    }
  }, [messages, sendMessage])

  const stopStreaming = useCallback(() => {
    if (abortController) {
      abortController.abort()
    }
  }, [abortController])

  const startNewSession = useCallback(() => {
    if (!isStreaming && messagesRef.current.length === 0) {
      setError(null)
      return
    }

    if (abortController) {
      abortController.abort()
    }

    const nextAgentSessionId = createAgentSessionId()

    messagesRef.current = []
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
  }, [abortController, isStreaming])

  const handleSelectSession = useCallback(
    async (session: ChatSessionListItem) => {
      if (abortController) {
        abortController.abort()
      }

      setError(null)
      setIsLoaded(false)
      activeSessionIdRef.current = session.sessionId
      setAgentSessionId(session.sessionId)
      setActiveRecordId(session.recordId ?? null)
      persistAgentSessionId(session.sessionId)

      try {
        const loadedSession = await loadChatSession(session)
        const nextSessionId = loadedSession?.sessionId || session.sessionId

        activeSessionIdRef.current = nextSessionId
        setAgentSessionId(nextSessionId)
        setActiveRecordId(loadedSession?.recordId ?? session.recordId ?? null)
        const loadedMessages = normalizeStoredMessages(loadedSession?.messages)
        messagesRef.current = loadedMessages
        setMessages(loadedMessages)
        persistAgentSessionId(nextSessionId)
      } catch (error) {
        console.error("Failed to load chat session:", error)
        setMessages([])
        setError(error instanceof Error ? error.message : "Failed to load chat session")
      } finally {
        setIsLoaded(true)
      }
    },
    [abortController],
  )

  const toggleSider = useCallback(() => {
    setIsSiderCollapsed((current) => !current)
  }, [])

  const SiderToggleIcon = isSiderCollapsed ? PanelLeftOpen : PanelLeftClose

  return (
    <div
      className="relative h-dvh bg-stone-50"
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
        <Button
          onClick={startNewSession}
          variant="ghost"
          size="icon"
          className={FLOATING_CONTROL_BUTTON_CLASS}
          aria-label="New chat"
        >
          <SquarePen className="h-5 w-5" />
        </Button>
      </div>
      <Button
        onClick={startNewSession}
        variant="ghost"
        size="icon"
        className={`${FLOATING_CONTROL_BUTTON_CLASS} absolute left-4 top-20 z-20 sm:hidden`}
        aria-label="New chat"
      >
        <SquarePen className="h-5 w-5" />
      </Button>
      <Sider
        ref={siderRef}
        activeSessionId={agentSessionId}
        isCollapsed={isSiderCollapsed}
        onSelectSession={handleSelectSession}
        refreshKey={sessionListRefreshKey}
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
        <MessageList messages={messages} isStreaming={isStreaming} error={error} onRetry={retry} isLoaded={isLoaded} />
      </div>

      <Composer
        layoutRef={composerLayoutRef}
        onSend={sendMessage}
        onStop={stopStreaming}
        isStreaming={isStreaming}
        disabled={!!error}
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
      />
    </div>
  )
}
