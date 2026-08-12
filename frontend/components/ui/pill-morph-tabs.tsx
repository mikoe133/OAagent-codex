"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export interface PillTab {
  value: string
  label: React.ReactNode
  panel?: React.ReactNode
}

interface PillMorphTabsProps {
  items?: PillTab[]
  defaultValue?: string
  onValueChange?: (value: string) => void
  actions?: React.ReactNode
  className?: string
}

const DEFAULT_ITEMS: PillTab[] = [
  { value: "overview", label: "Overview", panel: <div>Overview content</div> },
  { value: "features", label: "Features", panel: <div>Feature list</div> },
  { value: "pricing", label: "Pricing", panel: <div>Pricing & plans</div> },
  { value: "faq", label: "FAQ", panel: <div>FAQ content</div> },
]

export default function PillMorphTabs({
  items = DEFAULT_ITEMS,
  defaultValue,
  onValueChange,
  actions,
  className,
}: PillMorphTabsProps) {
  const firstValue = items[0]?.value ?? "tab-0"
  const [value, setValue] = React.useState(defaultValue ?? firstValue)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRefs = React.useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null)
  const [isExpanding, setIsExpanding] = React.useState(false)
  const shouldReduceMotion = useReducedMotion()

  const measure = React.useCallback(() => {
    const list = listRef.current
    const activeTrigger = triggerRefs.current[value]

    if (!list || !activeTrigger) {
      setIndicator(null)
      return
    }

    const listRect = list.getBoundingClientRect()
    const triggerRect = activeTrigger.getBoundingClientRect()
    setIndicator({
      left: triggerRect.left - listRect.left + list.scrollLeft,
      width: triggerRect.width,
    })
  }, [value])

  React.useEffect(() => {
    measure()

    const resizeObserver = new ResizeObserver(measure)
    const list = listRef.current
    const triggers = Object.values(triggerRefs.current)

    if (list) {
      resizeObserver.observe(list)
    }
    triggers.forEach((trigger) => {
      if (trigger) {
        resizeObserver.observe(trigger)
      }
    })
    window.addEventListener("resize", measure)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [measure])

  React.useEffect(() => {
    if (!items.some((item) => item.value === value)) {
      setValue(firstValue)
    }
  }, [firstValue, items, value])

  React.useEffect(() => {
    if (shouldReduceMotion) {
      return
    }

    setIsExpanding(true)
    const timeoutId = window.setTimeout(() => setIsExpanding(false), 300)
    return () => window.clearTimeout(timeoutId)
  }, [shouldReduceMotion, value])

  React.useEffect(() => {
    onValueChange?.(value)
  }, [onValueChange, value])

  if (!items.length) {
    return null
  }

  return (
    <div className={cn("w-full", className)}>
      <Tabs value={value} onValueChange={setValue} className="gap-0">
        <div
          data-slot="pill-morph-header"
          className="flex flex-wrap items-center justify-start gap-3"
        >
          <div className="relative isolate inline-flex max-w-full">
            {indicator ? (
              <motion.div
                layout
                initial={false}
                animate={{ left: indicator.left, width: indicator.width }}
                transition={
                  shouldReduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 300, damping: 28 }
                }
                aria-hidden="true"
                data-slot="pill-morph-glow"
                className="pointer-events-none absolute top-1/2 z-0 h-16 rounded-full opacity-40 blur-2xl"
                style={{
                  background: "linear-gradient(90deg, #7c3aed, #06b6d4)",
                  left: indicator.left,
                  width: indicator.width,
                }}
              />
            ) : null}

            <div
              ref={listRef}
              data-slot="pill-morph-track"
              className="relative z-10 inline-flex max-w-full items-center rounded-full border border-stone-200/50 bg-stone-100/95 p-1 backdrop-blur-sm theme-dark:border-white/10 theme-dark:bg-zinc-900/95"
            >
              {indicator ? (
                <motion.div
                  initial={false}
                  animate={{
                    left: indicator.left,
                    width: indicator.width,
                    scaleY: isExpanding ? 1.06 : 1,
                    borderRadius: isExpanding ? 24 : 999,
                  }}
                  transition={
                    shouldReduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 300, damping: 28 }
                  }
                  aria-hidden="true"
                  data-slot="pill-morph-indicator"
                  className="pointer-events-none absolute bottom-1 top-1 rounded-full bg-white shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-1 ring-black/[0.025] theme-dark:bg-zinc-700 theme-dark:ring-white/10"
                  style={{ left: indicator.left, width: indicator.width }}
                />
              ) : null}

              <TabsList className="relative h-auto gap-1 bg-transparent p-0">
                {items.map((item) => {
                  const isActive = item.value === value

                  return (
                    <TabsTrigger
                      key={item.value}
                      value={item.value}
                      ref={(element) => {
                        triggerRefs.current[item.value] = element
                      }}
                      className={cn(
                        "relative z-10 h-9 flex-none rounded-full bg-transparent px-4 py-2 text-sm font-medium shadow-none transition-colors hover:text-stone-950 data-[state=active]:bg-transparent data-[state=active]:shadow-none theme-dark:hover:text-white theme-dark:data-[state=active]:bg-transparent",
                        isActive
                          ? "text-stone-950 theme-dark:text-white"
                          : "text-stone-600 theme-dark:text-zinc-400",
                      )}
                    >
                      {item.label}
                    </TabsTrigger>
                  )
                })}
              </TabsList>
            </div>
          </div>

          {actions}
        </div>

        <div className="mt-4 min-h-[120px]">
          {items.map((item) => (
            <TabsContent key={item.value} value={item.value} className="mt-0 p-0">
              {item.panel ?? null}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  )
}
