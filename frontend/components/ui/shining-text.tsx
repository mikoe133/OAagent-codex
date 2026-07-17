"use client"

import { motion } from "motion/react"

import { cn } from "@/lib/utils"

type ShiningTextProps = {
  text: string
  className?: string
}

export function ShiningText({ text, className }: ShiningTextProps) {
  return (
    <motion.span
      className={cn(
        "inline-block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap bg-[linear-gradient(110deg,#404040,35%,#fff,50%,#404040,75%,#404040)] bg-[length:200%_100%] bg-clip-text text-sm font-medium text-transparent",
        className,
      )}
      initial={{ backgroundPosition: "200% 0" }}
      animate={{ backgroundPosition: "-200% 0" }}
      transition={{
        repeat: Infinity,
        duration: 2,
        ease: "linear",
      }}
    >
      {text}
    </motion.span>
  )
}
