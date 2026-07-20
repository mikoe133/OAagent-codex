"use client"

import { ShiningText } from "@/components/ui/shining-text"
import { ChevronRight } from "lucide-react"

export function TypingIndicator() {
  return (
    <div
      data-slot="thinking-indicator"
      className="mr-auto flex max-w-full items-center gap-1 py-1 animate-in fade-in duration-300"
      role="status"
      aria-label="Agent is thinking"
    >
      <ShiningText text="Thinking" baseColor="#9e9fa9" />
      <ChevronRight className="h-4 w-4 shrink-0 text-[#9e9fa9] theme-dark:text-zinc-400" aria-hidden="true" />
    </div>
  )
}
