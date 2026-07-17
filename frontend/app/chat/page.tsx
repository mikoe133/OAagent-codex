import { ChatShell } from "@/components/chat/chat-shell"
import { resolveOaNavigationUrl } from "@/lib/oa-navigation"
import type { Metadata } from "next"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Chat - OA Agent",
  description: "Chat with OA Agent powered by Gemini",
}

export default function ChatPage() {
  const oaApiBaseUrl = process.env.OA_DOCKER_API_BASE_URL || process.env.OA_API_BASE_URL
  return <ChatShell oaNavigationUrl={resolveOaNavigationUrl(oaApiBaseUrl)} />
}
