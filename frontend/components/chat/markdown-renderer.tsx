"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

interface MarkdownRendererProps {
  content: string
  className?: string
  isStreaming?: boolean
}

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-3 mt-6 text-xl font-semibold text-stone-950 first:mt-0 theme-dark:text-zinc-50">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-6 text-lg font-semibold text-stone-950 first:mt-0 theme-dark:text-zinc-50">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-stone-900 first:mt-0 theme-dark:text-zinc-100">{children}</h3>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5 marker:text-stone-400 theme-dark:marker:text-zinc-500">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5 marker:text-stone-500 theme-dark:marker:text-zinc-500">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-emerald-300 bg-emerald-50/50 py-2 pl-4 pr-3 text-stone-600 theme-dark:border-emerald-800 theme-dark:bg-emerald-950/30 theme-dark:text-zinc-300">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-4 transition-colors hover:text-emerald-800 theme-dark:text-emerald-400 theme-dark:decoration-emerald-700 theme-dark:hover:text-emerald-300"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-5 border-stone-200 theme-dark:border-zinc-800" />,
  pre: ({ children }) => (
    <pre className="my-4 max-w-full overflow-x-auto rounded-lg border border-stone-800 bg-stone-950 px-4 py-3 font-mono text-[13px] leading-6 text-stone-100 shadow-sm theme-dark:border-zinc-700 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit [&>code]:ring-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const isBlock = Boolean(className?.startsWith("language-"))
    if (isBlock) {
      return <code className={cn("font-mono", className)}>{children}</code>
    }

    return (
      <code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.9em] text-stone-800 ring-1 ring-inset ring-stone-200/70 theme-dark:bg-zinc-800 theme-dark:text-zinc-100 theme-dark:ring-zinc-700">
        {children}
      </code>
    )
  },
  table: ({ children }) => (
    <div className="my-4 max-w-full overflow-x-auto rounded-lg border border-stone-200 theme-dark:border-zinc-700">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-stone-100/80 text-stone-700 theme-dark:bg-zinc-800 theme-dark:text-zinc-200">{children}</thead>,
  th: ({ children }) => <th className="border-b border-stone-200 px-3 py-2 font-semibold theme-dark:border-zinc-700">{children}</th>,
  td: ({ children }) => <td className="border-b border-stone-100 px-3 py-2 align-top last:border-b-0 theme-dark:border-zinc-800">{children}</td>,
}

export function MarkdownRenderer({ content, className, isStreaming = false }: MarkdownRendererProps) {
  return (
    <div className={cn("min-w-0 max-w-full text-[15px] leading-7 text-stone-800 theme-dark:text-zinc-200", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
        {content}
      </ReactMarkdown>
      {isStreaming && (
        <span
          role="status"
          aria-label="Generating response"
          className="ml-1 inline-block h-[1em] w-0.5 translate-y-[0.15em] rounded-full bg-emerald-500 motion-safe:animate-pulse"
        />
      )}
    </div>
  )
}
