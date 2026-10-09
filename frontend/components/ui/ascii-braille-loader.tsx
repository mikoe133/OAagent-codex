"use client"

import { useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

// ASCII Braille frame set from beui.dev/components/motion/loader.
const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]

type AsciiBrailleLoaderProps = {
  size?: number
  speed?: number
  label?: string
  className?: string
}

export function AsciiBrailleLoader({
  size = 24,
  speed = 1,
  label = "加载中",
  className,
}: AsciiBrailleLoaderProps) {
  const reduce = useReducedMotion() ?? false
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const step = ((reduce ? speed * 2.5 : speed) / FRAMES.length) * 1000
    const interval = setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), step)
    return () => clearInterval(interval)
  }, [speed, reduce])

  return (
    <span
      data-slot="ascii-braille-loader"
      role="status"
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <span aria-hidden="true" className="font-mono leading-none tabular-nums" style={{ fontSize: size, lineHeight: 1 }}>
        {FRAMES[frame]}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
