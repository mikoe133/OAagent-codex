"use client"

import { Download, File, FileArchive, FileSpreadsheet, FileText, ImageIcon, Presentation } from "lucide-react"
import { attachmentUrl, type ChatAttachment } from "@/lib/chat-attachments"
import { cn } from "@/lib/utils"

function fileAppearance(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() || ""
  if (/^(png|jpe?g|gif|webp)$/.test(extension)) return { icon: ImageIcon, tone: "bg-violet-50 text-violet-500 theme-dark:bg-violet-400/10 theme-dark:text-violet-300" }
  if (/^(xls|xlsx|csv)$/.test(extension)) return { icon: FileSpreadsheet, tone: "bg-emerald-50 text-emerald-600 theme-dark:bg-emerald-400/10 theme-dark:text-emerald-300" }
  if (/^(ppt|pptx)$/.test(extension)) return { icon: Presentation, tone: "bg-amber-50 text-amber-600 theme-dark:bg-amber-400/10 theme-dark:text-amber-300" }
  if (extension === "pdf") return { icon: FileText, tone: "bg-rose-50 text-rose-500 theme-dark:bg-rose-400/10 theme-dark:text-rose-300" }
  if (extension === "zip") return { icon: FileArchive, tone: "bg-amber-50 text-amber-600 theme-dark:bg-amber-400/10 theme-dark:text-amber-300" }
  if (/^(docx?|txt|md|json|log)$/.test(extension)) return { icon: FileText, tone: "bg-sky-50 text-sky-600 theme-dark:bg-sky-400/10 theme-dark:text-sky-300" }
  return { icon: File, tone: "bg-stone-100 text-stone-500 theme-dark:bg-zinc-800 theme-dark:text-zinc-400" }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

export function MessageAttachments({ files }: { files: ChatAttachment[] }) {
  return (
    <ul aria-label="消息附件" className="mb-2.5 flex w-[22rem] max-w-full flex-col gap-2">
      {files.map(file => {
        const { icon: Icon, tone } = fileAppearance(file.name)
        const extension = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : "FILE"
        return (
          <li key={file.id} className="min-w-0">
            <a
              data-slot="message-attachment"
              href={attachmentUrl(file)}
              download={file.name}
              aria-label={`下载附件：${file.name}`}
              title={file.name}
              className="group/attachment flex min-w-0 items-center gap-3 rounded-2xl border border-stone-200/80 bg-white px-3.5 py-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.025)] transition-[background-color,border-color,box-shadow] hover:border-stone-300 hover:bg-stone-50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 focus-visible:ring-offset-2 theme-dark:border-zinc-700/80 theme-dark:bg-zinc-900 theme-dark:hover:border-zinc-600 theme-dark:hover:bg-zinc-800 theme-dark:focus-visible:ring-offset-zinc-950"
            >
              <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", tone)} aria-hidden="true">
                <Icon className="h-5 w-5" strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 [overflow-wrap:anywhere] text-sm font-medium leading-5 text-stone-800 theme-dark:text-zinc-100">{file.name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[0.6875rem] leading-4 text-stone-500 theme-dark:text-zinc-400">
                  <span className="max-w-full truncate font-medium tracking-wide">{extension}</span>
                  <span aria-hidden="true">·</span>
                  <span className="whitespace-nowrap tabular-nums">{formatFileSize(file.size)}</span>
                </span>
              </span>
              <Download aria-hidden="true" className="h-4 w-4 shrink-0 text-stone-400 transition-colors group-hover/attachment:text-stone-700 group-focus-visible/attachment:text-stone-700 theme-dark:text-zinc-500 theme-dark:group-hover/attachment:text-zinc-200 theme-dark:group-focus-visible/attachment:text-zinc-200" strokeWidth={1.7} />
            </a>
          </li>
        )
      })}
    </ul>
  )
}
