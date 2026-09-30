"use client"

import { useEffect, useRef, useState } from "react"
import { MessageBubble } from "./message-bubble"
import type { Message } from "./chat-shell"
import { TypingIndicator } from "./typing-indicator"
import { ArrowDown, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AnimatedOrb } from "./animated-orb"
import { Alert } from "@/components/ui/hero-alert"
import { cn } from "@/lib/utils"
import { resolveMessageListOverflow } from "./message-list-layout"
import { createMessageListScroll } from "./message-list-scroll"

interface MessageListProps {
  messages: Message[]
  isStreaming: boolean
  error: string | null
  retryLabel?: string
  retryHint?: string
  onRetry?: () => void
  onFeedback: (messageId: string, feedback: Message["feedback"]) => void
  isLoaded: boolean // Added isLoaded prop to know when localStorage is loaded
  oaNavigationUrl: string
}

const LAUNCH_SOUND_URL = "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/launch-SUi0itAGHr1wtvdDYYG5bzFLsIYHtP.mp3"

export function MessageList({
  messages,
  isStreaming,
  error,
  onRetry,
  retryLabel,
  retryHint,
  onFeedback,
  isLoaded,
  oaNavigationUrl,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<ReturnType<typeof createMessageListScroll> | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [hasAnimated, setHasAnimated] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const hasPlayedIntroRef = useRef(false) // Track if intro has played

  useEffect(() => {
    if (!isLoaded) return // Wait for localStorage to load

    // Only animate if no messages were loaded (fresh start)
    if (messages.length === 0 && !hasPlayedIntroRef.current) {
      setHasAnimated(true)
      hasPlayedIntroRef.current = true

      audioRef.current = new Audio(LAUNCH_SOUND_URL)
      audioRef.current.volume = 0.5
      audioRef.current.play().catch(() => {
        // Ignore autoplay errors - browser may block without user interaction
      })
    } else if (messages.length > 0) {
      // Skip animation if messages exist
      setHasAnimated(false)
      hasPlayedIntroRef.current = true
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [isLoaded, messages.length])

  useEffect(() => {
    if (!isLoaded || !containerRef.current || !contentRef.current) return
    const container = containerRef.current
    const scroll = createMessageListScroll(container, {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
    }, setIsAtBottom)
    scrollRef.current = scroll
    scroll.scrollToLatest()
    // Includes Trace expansion/collapse, final markdown, images, font size,
    // and the padding reserved for the changing composer height.
    const observer = new ResizeObserver(() => scroll.onResize())
    observer.observe(contentRef.current, { box: "border-box" })
    observer.observe(container)
    return () => {
      observer.disconnect()
      scroll.dispose()
      scrollRef.current = null
    }
  }, [isLoaded])

  useEffect(() => { scrollRef.current?.scrollToLatest() }, [messages.length])

  const lastMessage = messages[messages.length - 1]
  const lastMessageHasToolSteps = Boolean(lastMessage?.toolSteps?.length)
  const showTypingIndicator =
    isStreaming &&
    (messages.length === 0 ||
      lastMessage?.role === "user" ||
      (lastMessage?.role === "assistant" && lastMessage?.content === "" && !lastMessageHasToolSteps))

  if (!isLoaded) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <AnimatedOrb size={64} />
      </div>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        onScroll={() => scrollRef.current?.onScroll()}
        onWheel={(event) => {
          if (event.deltaY < 0) scrollRef.current?.pause()
        }}
        onTouchMove={() => scrollRef.current?.pause()}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) scrollRef.current?.pause()
        }}
        className={cn(
          "chat-message-scrollbar absolute inset-0 overflow-x-hidden border-none",
          resolveMessageListOverflow({
            messageCount: messages.length,
            isStreaming,
            hasError: Boolean(error),
          }),
        )}
        role="log"
        tabIndex={0}
        aria-label="Chat messages"
        aria-live="polite"
      >
        <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-7 px-4 pb-[var(--chat-composer-space,10rem)] pt-24 sm:px-8 lg:px-12">
          {messages.length === 0 && !error && !isStreaming && (
            <div className="flex min-h-[calc(100dvh-16rem)] flex-col items-center justify-center text-center text-stone-400 theme-dark:text-zinc-500">
              <div className={`mb-4 ${hasAnimated ? "orb-intro" : ""}`}>
                <AnimatedOrb size={128} />
              </div>
              <p className={`text-lg font-medium text-gray-500 theme-dark:text-zinc-400 ${hasAnimated ? "text-blur-intro" : ""}`}>
                Hi, my name is RWKVOS
              </p>
              <p className={`mt-1 text-sm text-gray-400 theme-dark:text-zinc-500 ${hasAnimated ? "text-blur-intro-delay" : ""}`}>
                Send a message to begin chatting with OA Agent
              </p>
            </div>
          )}

          {messages
            .filter((message) => {
              if (
                isStreaming &&
                message.role === "assistant" &&
                message === lastMessage &&
                message.content === "" &&
                !message.toolSteps?.length
              ) {
                return false
              }
              return true
            })
            .map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                isStreaming={isStreaming && message.role === "assistant" && message === lastMessage}
                onFeedback={onFeedback}
                oaNavigationUrl={oaNavigationUrl}
              />
            ))}

          {showTypingIndicator && <TypingIndicator />}

          {error && (
            <Alert
              status="danger"
              role="alert"
              className="items-center border border-red-200/80 bg-red-50/90 shadow-[0_4px_18px_rgba(127,29,29,0.06)] theme-dark:border-red-900/70 theme-dark:bg-red-950/45"
            >
              <Alert.Indicator />
              <Alert.Content className="min-w-0 flex-1">
                <Alert.Title className="text-red-800 theme-dark:text-red-300">Something went wrong</Alert.Title>
                <Alert.Description className="break-words text-red-600 theme-dark:text-red-400">{error}</Alert.Description>
                {retryHint && <p className="mt-2 text-sm text-red-600 theme-dark:text-red-400">{retryHint}</p>}
              </Alert.Content>
              {onRetry && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRetry}
                  className="text-red-600 transition-colors hover:bg-red-100 hover:text-red-700 theme-dark:text-red-400 theme-dark:hover:bg-red-950/70 theme-dark:hover:text-red-300"
                  aria-label={retryLabel || "Retry sending message"}
                >
                  <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
                  {retryLabel || "Retry"}
                </Button>
              )}
            </Alert>
          )}

          <div aria-hidden="true" className="h-8 shrink-0" />
        </div>
      </div>

      {!isAtBottom && messages.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[var(--chat-composer-space,10rem)] z-20 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => scrollRef.current?.scrollToLatest()}
            aria-label="Scroll to latest message"
            title="Scroll to latest"
            className="pointer-events-auto h-9 w-9 rounded-full border-stone-200 bg-white text-stone-600 shadow-md hover:bg-stone-50 theme-dark:border-zinc-700 theme-dark:bg-zinc-900 theme-dark:text-zinc-300 theme-dark:hover:bg-zinc-800"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
      )}
    </>
  )
}
