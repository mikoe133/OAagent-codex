"use client"

import Image from "next/image"
import * as React from "react"
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react"

import { cn } from "@/lib/utils"

export type AnimatedTooltipItem = {
  id: number
  name: string
  designation: string
  image: string
}

type AnimatedTooltipProps = {
  items: AnimatedTooltipItem[]
  className?: string
  children?: React.ReactNode
  openOnClick?: boolean
}

export function AnimatedTooltip({
  items,
  className,
  children,
  openOnClick = false,
}: AnimatedTooltipProps) {
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null)
  const [pinnedIndex, setPinnedIndex] = React.useState<number | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const springConfig = { stiffness: 100, damping: 5 }
  const pointerOffset = useMotionValue(0)
  const rotate = useSpring(
    useTransform(pointerOffset, [-100, 100], [-45, 45]),
    springConfig,
  )
  const translateX = useSpring(
    useTransform(pointerOffset, [-100, 100], [-50, 50]),
    springConfig,
  )

  React.useEffect(() => {
    if (pinnedIndex === null) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setPinnedIndex(null)
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [pinnedIndex])

  const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    pointerOffset.set(event.clientX - bounds.left - bounds.width / 2)
  }

  const renderItem = (item: AnimatedTooltipItem, trigger?: React.ReactNode) => {
    const isOpen = hoveredIndex === item.id || pinnedIndex === item.id
    return (
      <div
        className="group relative"
        key={item.id}
        onMouseEnter={() => setHoveredIndex(item.id)}
        onMouseLeave={() => setHoveredIndex(null)}
        onFocusCapture={() => setHoveredIndex(item.id)}
        onBlurCapture={() => setHoveredIndex(null)}
        onMouseMove={handleMouseMove}
        onClick={() => {
          if (openOnClick) {
            setPinnedIndex((current) => current === item.id ? null : item.id)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPinnedIndex(null)
          }
        }}
      >
        <AnimatePresence mode="popLayout">
          {isOpen ? (
            <motion.div
              id={`animated-tooltip-${item.id}`}
              role="tooltip"
              initial={{ opacity: 0, y: 20, scale: 0.6 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                transition: {
                  type: "spring",
                  stiffness: 260,
                  damping: 10,
                },
              }}
              exit={{ opacity: 0, y: 20, scale: 0.6 }}
              style={{
                translateX,
                rotate,
                whiteSpace: "nowrap",
              }}
              className="absolute -top-20 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center justify-center rounded-md bg-foreground px-4 py-2 text-xs shadow-xl"
            >
              <div className="absolute inset-x-10 -bottom-px z-30 h-px w-[20%] bg-gradient-to-r from-transparent via-emerald-500 to-transparent" />
              <div className="absolute left-10 -bottom-px z-30 h-px w-[40%] bg-gradient-to-r from-transparent via-sky-500 to-transparent" />
              <div className="relative z-30 text-base font-bold text-background">
                {item.name}
              </div>
              <div className="text-xs text-muted-foreground">
                {item.designation}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {trigger ?? (
          <Image
            height={100}
            width={100}
            src={item.image}
            alt={item.name}
            className="relative !m-0 h-14 w-14 rounded-full border-2 border-background object-cover object-top !p-0 transition duration-500 group-hover:z-30 group-hover:scale-105"
          />
        )}
      </div>
    )
  }

  return (
    <div ref={containerRef} className={cn("flex items-center gap-2", className)}>
      {children && items.length === 1
        ? renderItem(items[0]!, children)
        : items.map((item) => renderItem(item))}
    </div>
  )
}
