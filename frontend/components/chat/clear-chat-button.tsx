"use client"

import type { ButtonHTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"
import styles from "./clear-chat-button.module.css"

type ClearChatButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode
}

export function ClearChatButton({ children = "Clear", className, type = "button", ...props }: ClearChatButtonProps) {
  return (
    <div className={cn(styles.root, className)}>
      <div className={styles.buttonWrap}>
        <button {...props} type={type} className={styles.button}>
          <span className={styles.label}>{children}</span>
        </button>
        <div className={styles.buttonShadow} />
      </div>
    </div>
  )
}
