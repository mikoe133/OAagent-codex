"use client"

import type { ReactNode } from "react"
import { EllipsisVertical } from "lucide-react"

import { cn } from "@/lib/utils"

export interface BentoItem {
  title: string
  description: string
  icon: ReactNode
  status?: string
  tags?: string[]
  meta?: string
  metaIcon?: ReactNode
  colSpan?: number
  hasPersistentHover?: boolean
  onSelect?: () => void
  onClick?: () => void
}

export type BentoItems = BentoItem[]

type BentoGridProps = {
  items: BentoItems
  className?: string
}

function BentoGrid({ items, className }: BentoGridProps) {
  return (
    <div
      data-slot="bento-grid"
      className={cn(
        "mx-auto grid max-w-7xl grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),28rem))] justify-start gap-3 p-4",
        className,
      )}
    >
      {items.map((item, index) => (
        <article
          key={`${item.title}-${index}`}
          data-slot="bento-grid-item"
          className={cn(
            "group relative min-h-40 w-full max-w-md overflow-hidden rounded-xl border border-gray-100/80 bg-white p-4 transition-all duration-300 sm:min-h-32 sm:p-5 theme-dark:border-white/10 theme-dark:bg-black",
            "will-change-transform hover:-translate-y-0.5 hover:shadow-[0_2px_12px_rgba(0,0,0,0.03)] theme-dark:hover:shadow-[0_2px_12px_rgba(255,255,255,0.03)]",
            "col-span-1",
            item.hasPersistentHover &&
              "-translate-y-0.5 shadow-[0_2px_12px_rgba(0,0,0,0.03)] theme-dark:shadow-[0_2px_12px_rgba(255,255,255,0.03)]",
            item.onSelect && "cursor-pointer",
          )}
        >
          <div
            className={cn(
              "absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100",
              item.hasPersistentHover && "opacity-100",
            )}
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.02)_1px,transparent_1px)] bg-[length:4px_4px] theme-dark:bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.02)_1px,transparent_1px)]" />
          </div>

          <div className="relative flex min-h-32 items-start gap-3 pr-16 sm:min-h-24 sm:gap-4 sm:pr-20">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-black/5 transition-all duration-300 group-hover:bg-gradient-to-br theme-dark:bg-white/10">
              {item.icon}
            </div>

            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-medium tracking-tight text-gray-900 theme-dark:text-gray-100">
                {item.title}
              </h2>
              {item.meta ? (
                <div
                  data-slot="bento-grid-item-meta"
                  className="mt-1 flex min-w-0 items-center gap-1 text-xs font-normal text-gray-500 theme-dark:text-gray-400"
                >
                  {item.metaIcon}
                  <span className="truncate">{item.meta}</span>
                </div>
              ) : null}
              <p className="mt-2 line-clamp-2 text-sm font-[425] leading-5 text-gray-600 theme-dark:text-gray-300">
                {item.description}
              </p>

              {item.tags?.length ? (
                <>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-gray-500 sm:hidden theme-dark:text-gray-400">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="max-w-28 truncate rounded-md bg-black/5 px-2 py-1 backdrop-blur-sm transition-all duration-200 hover:bg-black/10 theme-dark:bg-white/10 theme-dark:hover:bg-white/20"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 hidden min-w-0 items-center gap-1.5 overflow-hidden text-xs text-gray-500 sm:flex theme-dark:text-gray-400">
                    {item.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="max-w-28 shrink-0 truncate rounded-md bg-black/5 px-2 py-1 backdrop-blur-sm transition-all duration-200 hover:bg-black/10 theme-dark:bg-white/10 theme-dark:hover:bg-white/20"
                      >
                        #{tag}
                      </span>
                    ))}
                    {item.tags.length > 3 ? <span className="shrink-0">+{item.tags.length - 3}</span> : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <span className="absolute right-4 top-4 rounded-lg bg-black/5 px-2 py-1 text-xs font-medium text-gray-600 backdrop-blur-sm transition-colors duration-300 group-hover:bg-black/10 sm:right-5 sm:top-5 theme-dark:bg-white/10 theme-dark:text-gray-300 theme-dark:group-hover:bg-white/20">
            {item.status || "Active"}
          </span>

          {item.onSelect ? (
            <button
              type="button"
              data-slot="bento-grid-item-select"
              aria-label={`查看任务对话：${item.title}`}
              onClick={item.onSelect}
              className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900/20 theme-dark:focus-visible:ring-white/30"
            />
          ) : null}

          {item.onClick ? (
            <button
              type="button"
              data-slot="bento-grid-item-action"
              aria-label={`编辑任务：${item.title}`}
              onClick={item.onClick}
              className="absolute bottom-3 right-3 z-20 flex size-8 items-center justify-center rounded-md text-gray-500 opacity-100 transition-all hover:bg-black/5 hover:text-gray-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 sm:bottom-4 sm:right-4 md:opacity-0 md:group-hover:opacity-100 theme-dark:text-gray-400 theme-dark:hover:bg-white/10 theme-dark:hover:text-gray-100 theme-dark:focus-visible:ring-white/30"
            >
              <EllipsisVertical className="size-4" aria-hidden="true" />
            </button>
          ) : null}

          <div
            className={cn(
              "absolute inset-0 -z-10 rounded-xl bg-gradient-to-br from-transparent via-gray-100/50 to-transparent p-px opacity-0 transition-opacity duration-300 group-hover:opacity-100 theme-dark:via-white/10",
              item.hasPersistentHover && "opacity-100",
            )}
          />
        </article>
      ))}
    </div>
  )
}

export { BentoGrid }
