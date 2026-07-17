import type React from "react"
import type { Metadata, Viewport } from "next"
import { Analytics } from "@vercel/analytics/next"
import "@heroui/styles/css"
import "./globals.css"
// import "../components/chat/siderbar.css"

export const metadata: Metadata = {
  title: "OA Agent",
  description: "Chat with OA Agent powered by Gemini",
  generator: "v0.app",
  icons: {
    icon: "/logo/R-light.png",
    shortcut: "/logo/R-light.png",
    apple: "/logo/R-light.png",
  },
}

export const viewport: Viewport = {
  themeColor: "#fafaf9",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`font-sans antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
