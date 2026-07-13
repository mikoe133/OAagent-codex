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

interface MessageListProps {
  messages: Message[]
  isStreaming: boolean
  error: string | null
  onRetry: () => void
  onFeedback: (messageId: string, feedback: Message["feedback"]) => void
  isLoaded: boolean // Added isLoaded prop to know when localStorage is loaded
}

const LAUNCH_SOUND_URL = "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/launch-SUi0itAGHr1wtvdDYYG5bzFLsIYHtP.mp3"

export function MessageList({ messages, isStreaming, error, onRetry, onFeedback, isLoaded }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const rafRef = useRef<number | null>(null)
  const [hasAnimated, setHasAnimated] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastScrollRef = useRef<number>(0)
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
    if (!containerRef.current) return
    // Immediate scroll to bottom when messages change
    const container = containerRef.current
    container.scrollTop = container.scrollHeight
    setAutoScroll(true)
  }, [messages.length])

  useEffect(() => {
    if (!isStreaming || !autoScroll || !containerRef.current) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    const container = containerRef.current
    lastScrollRef.current = container.scrollTop

    const smoothScroll = () => {
      if (!container) return

      const { scrollHeight, clientHeight } = container
      const targetScroll = scrollHeight - clientHeight
      const currentScroll = lastScrollRef.current
      const diff = targetScroll - currentScroll

      if (diff > 0.5) {
        const newScroll = currentScroll + diff * 0.03
        lastScrollRef.current = newScroll
        container.scrollTop = newScroll
      }

      rafRef.current = requestAnimationFrame(smoothScroll)
    }

    // Start immediately
    rafRef.current = requestAnimationFrame(smoothScroll)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isStreaming, autoScroll])

  // Detect if user scrolls up to disable auto-scroll
  const handleScroll = () => {
    if (!containerRef.current || isStreaming) return

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 150
    setAutoScroll(isAtBottom)
  }

  const scrollToLatest = () => {
    const container = containerRef.current
    if (!container) return
    setAutoScroll(true)
    lastScrollRef.current = container.scrollHeight - container.clientHeight
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" })
  }

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
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={(event) => {
        if (event.deltaY < 0) setAutoScroll(false)
      }}
      onTouchMove={() => setAutoScroll(false)}
      className={cn(
        "absolute inset-0 border-none",
        resolveMessageListOverflow({
          messageCount: messages.length,
          isStreaming,
          hasError: Boolean(error),
        }),
      )}
      role="log"
      aria-label="Chat messages"
      aria-live="polite"
    >
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-7 px-4 pb-40 pt-24 sm:px-8 lg:px-12">
        {messages.length === 0 && !error && !isStreaming && (
          <div className="flex min-h-[calc(100dvh-16rem)] flex-col items-center justify-center text-center text-stone-400">
            <div className={`mb-4 ${hasAnimated ? "orb-intro" : ""}`}>
              <AnimatedOrb size={128} />
            </div>
            <p className={`text-lg font-medium text-gray-500 ${hasAnimated ? "text-blur-intro" : ""}`}>
              Hi, my name is RWKVOS
            </p>
            <p className={`mt-1 text-sm text-gray-400 ${hasAnimated ? "text-blur-intro-delay" : ""}`}>
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
            />
          ))}

        {showTypingIndicator && <TypingIndicator />}

        {error && (
          <Alert
            status="danger"
            role="alert"
            className="items-center border border-red-200/80 bg-red-50/90 shadow-[0_4px_18px_rgba(127,29,29,0.06)]"
          >
            <Alert.Indicator />
            <Alert.Content className="min-w-0 flex-1">
              <Alert.Title className="text-red-800">Something went wrong</Alert.Title>
              <Alert.Description className="break-words text-red-600">{error}</Alert.Description>
            </Alert.Content>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRetry}
              className="text-red-600 transition-colors hover:bg-red-100 hover:text-red-700"
              aria-label="Retry sending message"
            >
              <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </Alert>
        )}

        <div ref={bottomRef} aria-hidden="true" className="h-8" />
      </div>

      {!autoScroll && messages.length > 0 && (
        <div className="pointer-events-none sticky bottom-36 z-20 -mt-24 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={scrollToLatest}
            aria-label="Scroll to latest message"
            title="Scroll to latest"
            className="pointer-events-auto h-9 w-9 rounded-full border-stone-200 bg-white text-stone-600 shadow-md hover:bg-stone-50"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
