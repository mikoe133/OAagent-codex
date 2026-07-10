import { ChatShell } from "@/components/chat/chat-shell"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Chat - OA Agent",
  description: "Chat with OA Agent powered by Gemini",
}

export default function ChatPage() {
  return <ChatShell />
}
