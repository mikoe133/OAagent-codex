"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowUpRight, Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copyText } from "@/lib/copy-text"
import type { KnowledgeSource } from "@/lib/knowledge-sources"
import { cn } from "@/lib/utils"

type PreviewPosition = {
  x: number
  y: number
}

// 暂时关闭知识库引用的悬浮预览，恢复时改为 true。
const KNOWLEDGE_SOURCE_PREVIEW_ENABLED = false

export function KnowledgeSourceShowcase({ sources }: { sources: KnowledgeSource[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [isMounted, setIsMounted] = useState(false)
  const [previewPosition, setPreviewPosition] = useState<PreviewPosition>({ x: 24, y: 24 })
  const frameRef = useRef<number | null>(null)
  const pendingPositionRef = useRef<PreviewPosition>({ x: 24, y: 24 })

  useEffect(() => {
    setIsMounted(true)
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  if (sources.length === 0) {
    return null
  }

  const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    const previewWidth = 320
    const previewHeight = 140
    const previewOffset = 8
    const viewportInset = 16
    const showOnRight = event.clientX + previewOffset + previewWidth <= window.innerWidth - viewportInset
    const showBelow = event.clientY + previewOffset + previewHeight <= window.innerHeight - viewportInset
    pendingPositionRef.current = {
      x: showOnRight
        ? event.clientX + previewOffset
        : Math.max(viewportInset, event.clientX - previewWidth - previewOffset),
      y: showBelow
        ? event.clientY + previewOffset
        : Math.max(viewportInset, event.clientY - previewHeight - previewOffset),
    }
    if (frameRef.current !== null) {
      return
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      setPreviewPosition(pendingPositionRef.current)
    })
  }

  const hoveredSource = hoveredIndex === null ? null : sources[hoveredIndex]
  const previewLayer = KNOWLEDGE_SOURCE_PREVIEW_ENABLED && isMounted
    ? createPortal(
        <div
          aria-hidden="true"
          data-slot="knowledge-source-preview"
          className="pointer-events-none fixed z-[100] hidden w-80 overflow-hidden rounded-2xl border border-white/70 bg-white/95 shadow-[0_24px_70px_rgba(28,25,23,0.18)] backdrop-blur-xl transition-[opacity,transform] duration-200 ease-out pointer-fine:block theme-dark:border-zinc-700/80 theme-dark:bg-zinc-900/95 theme-dark:shadow-[0_24px_70px_rgba(0,0,0,0.46)]"
          style={{
            left: previewPosition.x,
            top: previewPosition.y,
            opacity: hoveredSource ? 1 : 0,
            transform: hoveredSource ? "translate3d(0,0,0) scale(1)" : "translate3d(0,6px,0) scale(0.96)",
          }}
        >
          <div className="relative overflow-hidden px-5 py-4">
            <p className="text-base font-semibold leading-6 text-stone-900 theme-dark:text-zinc-100">
              {hoveredSource?.title}
            </p>
            <p className="mt-2 line-clamp-4 text-xs leading-5 text-stone-500 theme-dark:text-zinc-400">
              {hoveredSource?.description}
            </p>
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <section
      data-slot="knowledge-source-showcase"
      onMouseMove={KNOWLEDGE_SOURCE_PREVIEW_ENABLED ? handleMouseMove : undefined}
      className="relative mt-8 w-full"
      aria-labelledby="knowledge-source-heading"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2
          id="knowledge-source-heading"
          className="text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-stone-500 theme-dark:text-zinc-400"
        >
          知识库引用
        </h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[0.625rem] font-medium tabular-nums text-stone-500 theme-dark:bg-zinc-800 theme-dark:text-zinc-400">
          {sources.length} 条
        </span>
      </div>

      {previewLayer}

      <div className="border-y border-stone-200/80 theme-dark:border-zinc-800">
        {sources.map((source, index) => (
          <div
            key={source.sourceUrl}
            onMouseEnter={KNOWLEDGE_SOURCE_PREVIEW_ENABLED ? () => setHoveredIndex(index) : undefined}
            onMouseLeave={KNOWLEDGE_SOURCE_PREVIEW_ENABLED ? () => setHoveredIndex(null) : undefined}
            className="group/source relative flex items-start gap-3 border-b border-stone-200/80 px-3 py-4 transition-colors duration-200 last:border-b-0 hover:bg-stone-50/80 focus-within:bg-sky-50/70 theme-dark:border-zinc-800 theme-dark:hover:bg-zinc-900/70 theme-dark:focus-within:bg-sky-950/30"
          >
            <a
              href={source.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50"
              aria-label={`打开知识库引用：${source.title}`}
            >
              <div className="min-w-0">
                <div className="inline-flex max-w-full items-center gap-2">
                  <h3 className="truncate text-[0.9375rem] font-medium tracking-tight text-stone-900 theme-dark:text-zinc-100">
                    {source.title}
                  </h3>
                  <ArrowUpRight
                    className="h-4 w-4 shrink-0 -translate-x-1 translate-y-1 text-stone-400 opacity-0 transition-all duration-200 group-hover/source:translate-x-0 group-hover/source:translate-y-0 group-hover/source:opacity-100 group-focus-visible/source:translate-x-0 group-focus-visible/source:translate-y-0 group-focus-visible/source:opacity-100 theme-dark:text-zinc-500"
                    aria-hidden="true"
                  />
                </div>
                <p
                  className={cn(
                    "mt-1 w-2/3 truncate text-xs leading-5 text-stone-500 transition-colors duration-200",
                    "group-hover/source:text-stone-700 group-focus-visible/source:text-stone-700",
                    "theme-dark:text-zinc-500 theme-dark:group-hover/source:text-zinc-300 theme-dark:group-focus-visible/source:text-zinc-300",
                  )}
                >
                  {source.description}
                </p>
              </div>
            </a>
            <KnowledgeSourceCopyButton source={source} />
          </div>
        ))}
      </div>
    </section>
  )
}

function KnowledgeSourceCopyButton({ source }: { source: KnowledgeSource }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
      }
    }
  }, [])

  const handleCopy = async () => {
    try {
      await copyText(source.originalContent)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current)
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 1500)
  }

  const copied = copyState === "copied"
  const label = copied
    ? "引用原文已复制"
    : copyState === "failed"
      ? "复制引用原文失败"
      : `复制引用原文：${source.title}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-slot="knowledge-source-copy"
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={handleCopy}
          aria-label={label}
          disabled={copied}
          className="pointer-events-none relative mt-0.5 h-8 w-8 rounded-lg border-stone-200 bg-transparent text-stone-500 opacity-0 shadow-none transition-opacity duration-200 group-hover/source:pointer-events-auto group-hover/source:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 dark:bg-transparent theme-dark:border-zinc-700 theme-dark:bg-transparent theme-dark:text-zinc-400 theme-dark:hover:border-sky-900 theme-dark:hover:bg-sky-950/40 theme-dark:hover:text-sky-300"
        >
          <span
            className={cn(
              "absolute transition-all duration-200",
              copied ? "scale-100 opacity-100" : "scale-0 opacity-0",
            )}
          >
            <Check className="h-4 w-4 text-emerald-600 theme-dark:text-emerald-400" aria-hidden="true" />
          </span>
          <span
            className={cn(
              "absolute transition-all duration-200",
              copied ? "scale-0 opacity-0" : "scale-100 opacity-100",
            )}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="px-2 py-1 text-xs">
        {copied ? "已复制" : copyState === "failed" ? "复制失败" : "复制原文"}
      </TooltipContent>
    </Tooltip>
  )
}
