"use client"

import { forwardRef, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react"
import { ChevronsUpDown, LogOut, Search, Trash2, UserRound, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { AUTH_TOKEN_STORAGE_KEY, AUTH_USER_STORAGE_KEY, type AuthUser } from "@/lib/auth"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { matchesSessionIdentity, prioritizeSessionItem } from "./session-list-order"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/m3-dropdown-menu"

type NavItem = {
  name: string
  href: string
  sessionId?: string
  recordId?: string | number
  searchText?: string
}

type Section = {
  title: string
  items: NavItem[]
}

type AgentSession = {
  sessionId: string
  summary: string | null
  updatedAt: string
  recordId?: string | number
  messages?: AgentSessionMessage[]
}

type AgentSessionMessage = {
  content?: string
  role?: string
}

type SessionsResponse = {
  sessions?: unknown
}

type SiderUser = Pick<AuthUser, "email"> & {
  name: string
}

type SiderProps = {
  activeSessionId?: string
  activeRecordId?: string | number | null
  isCollapsed?: boolean
  focusSessionKey?: number
  prioritizedSessionId?: string | null
  onSelectSession?: (session: ChatSessionListItem) => void
  refreshKey?: number
}

export type ChatSessionListItem = {
  sessionId: string
  recordId?: string | number
}

type NavLinkProps = {
  children: ReactNode
  href?: string
  className?: string
  activeClassName?: string
  active?: boolean
  onSelect?: () => void
  title?: string
}

const DEFAULT_TITLE = "New Section"
const TITLE_LENGTH = 18

const defaultItem: NavItem = {
  name: DEFAULT_TITLE,
  href: "#new-section",
}

const defaultSections: Section[] = [
  {
    title: "Conversations",
    items: [defaultItem],
  },
]

const NavLink = ({
  children,
  href = "#",
  className = "",
  activeClassName = "",
  active = false,
  onSelect,
  title,
}: NavLinkProps) => {
  return (
    <a
      href={href}
      onClick={onSelect}
      className={cn(className, active && activeClassName)}
      title={title}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </a>
  )
}

const Title = ({ children }: { children: ReactNode }) => (
  <h3 className="px-4 pb-3 text-xs font-semibold uppercase tracking-normal text-slate-500 md:px-8">
    {children}
  </h3>
)

const SearchBox = ({
  hasValue = false,
  onClear,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  hasValue?: boolean
  onClear?: () => void
}) => (
  <div className="relative w-full">
    <Search className="absolute inset-y-0 left-3 my-auto h-5 w-5 text-slate-400" aria-hidden="true" />
    <input
      {...props}
      type="search"
      className="w-full rounded-lg border border-slate-200 bg-white/80 py-2 pl-12 pr-10 text-sm text-slate-700 shadow-sm outline-none transition duration-200 placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-slate-900/10"
    />
    {hasValue ? (
      <button
        type="button"
        aria-label="Clear search"
        className="absolute inset-y-0 right-2 my-auto flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10"
        onClick={onClear}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    ) : null}
  </div>
)

const UserInfo = ({ user, onLogout }: { user: SiderUser; onLogout: () => void }) => (
  <div className="flex w-full items-center gap-3 px-6 py-4 text-left">
    <UserRound className="h-5 w-5 shrink-0 text-slate-950" strokeWidth={1.8} aria-hidden="true" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium leading-5 text-slate-950">{user.name}</span>
      <span className="block truncate text-xs leading-4 text-slate-500">{user.email}</span>
    </span>
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="h-8 w-8 shrink-0 rounded-md text-slate-950 transition-colors duration-150 hover:bg-slate-100 data-[state=open]:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10"
        aria-label="Open user menu"
      >
        <ChevronsUpDown className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={10}
        className="z-[9999] w-40 rounded-xl border-slate-200 bg-white p-1 shadow-[0_14px_32px_rgba(15,23,42,0.14)]"
      >
        <DropdownMenuItem
          onSelect={onLogout}
          className="rounded-lg text-sm text-red-600 focus:bg-red-50 focus:text-red-600"
        >
          <LogOut className="h-4 w-4 text-red-600" aria-hidden="true" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
)

const DeleteConversationButton = ({ name, onConfirm }: { name: string; onConfirm: () => void }) => {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const descriptionId = useId()

  function handleConfirm() {
    setOpen(false)
    onConfirm()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Delete ${name}`}
          className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#f5f5f5] opacity-0 transition-[opacity,background-color] duration-150 hover:bg-[#eeeeee] focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f56565]/25 group-hover:opacity-100 data-[state=open]:bg-[#eeeeee] data-[state=open]:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <Trash2 className="size-3.5 text-[#f56565]" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="center"
        sideOffset={10}
        collisionPadding={12}
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="z-[100] w-60 rounded-lg border-slate-200 bg-white p-3 text-slate-950 shadow-[0_12px_32px_rgba(15,23,42,0.14)]"
      >
        <p id={titleId} className="text-sm font-semibold">
          删除此对话？
        </p>
        <p id={descriptionId} className="mt-1 text-xs leading-5 text-slate-500">
          删除后将无法恢复。
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="h-8 rounded-md px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10"
            onClick={() => setOpen(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="h-8 rounded-md bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
            onClick={handleConfirm}
          >
            确认删除
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const SectionsList = ({
  items,
  activeHref,
  onSelect,
  onDelete,
}: {
  items: NavItem[]
  activeHref: string
  onSelect: (item: NavItem) => void
  onDelete: (href: string) => void
}) => (
  <div className="px-4 text-slate-600 md:px-8">
    <ul>
      {items.map((item) => (
        <li
          key={item.href}
          className="group flex items-center"
          data-session-id={item.sessionId}
          data-record-id={item.recordId === undefined ? undefined : String(item.recordId)}
        >
          <NavLink
            href={item.href}
            active={activeHref === item.href}
            activeClassName="border-[#4f39f7] text-[#0f1828]"
            className="block min-w-0 flex-1 border-l border-slate-200 px-4 py-2.5 text-sm font-medium transition duration-150 hover:border-[#4f39f7] hover:text-[#0f1828]"
            onSelect={() => onSelect(item)}
            title={item.name}
          >
            <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{item.name}</span>
          </NavLink>
          <DeleteConversationButton name={item.name} onConfirm={() => onDelete(item.href)} />
        </li>
      ))}
    </ul>
  </div>
)

const Sider = forwardRef<HTMLElement, SiderProps>(
  (
    {
      activeSessionId,
      activeRecordId = null,
      isCollapsed = false,
      focusSessionKey = 0,
      prioritizedSessionId = null,
      onSelectSession,
      refreshKey = 0,
    },
    ref,
  ) => {
    const [sections, setSections] = useState<Section[]>(defaultSections)
    const [activeHref, setActiveHref] = useState(defaultItem.href)
    const [query, setQuery] = useState("")
    const [user, setUser] = useState<SiderUser>(() => buildFallbackUser())
    const sessionListRef = useRef<HTMLDivElement>(null)
    const handledFocusSessionKeyRef = useRef(focusSessionKey)

    function handleDeleteItem(href: string) {
      const nextSections = sections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => item.href !== href),
        }))
        .filter((section) => section.items.length > 0)
      const normalizedSections = nextSections.length > 0 ? nextSections : defaultSections
      const fallbackHref = normalizedSections[0]?.items[0]?.href || defaultItem.href

      setSections(normalizedSections)
      setActiveHref((current) => {
        const stillExists = normalizedSections.some((section) => section.items.some((item) => item.href === current))
        return stillExists ? current : fallbackHref
      })
    }

    function handleSelectItem(item: NavItem) {
      setActiveHref(item.href)
      if (item.sessionId) {
        onSelectSession?.({
          sessionId: item.sessionId,
          ...(item.recordId ? { recordId: item.recordId } : {}),
        })
      }
    }

    async function handleLogout() {
      clearStoredAuth()

      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
        })
      } catch (error) {
        console.error("Failed to clear session cookie:", error)
      } finally {
        window.location.assign("/login")
      }
    }

    useEffect(() => {
      setUser(readStoredUser())
    }, [])

    useEffect(() => {
      if (activeSessionId) {
        setActiveHref(buildSessionHref(activeSessionId, activeRecordId))

        if (prioritizedSessionId === activeSessionId) {
          setSections((currentSections) => {
            const activeIdentity = {
              sessionId: activeSessionId,
              recordId: activeRecordId,
            }
            const currentItems = currentSections
              .flatMap((section) => section.items)
              .filter((item) => item.sessionId)
              .filter(
                (item) =>
                  !(
                    activeRecordId !== null &&
                    activeRecordId !== undefined &&
                    item.sessionId === activeSessionId &&
                    item.recordId === undefined
                  ),
              )
            const nextItems = currentItems.some((item) => matchesSessionIdentity(item, activeIdentity))
              ? currentItems
              : [buildSessionItem(activeSessionId, activeRecordId), ...currentItems]

            return buildConversationSections(prioritizeSessionItem(nextItems, activeIdentity))
          })
        }
      }
    }, [activeRecordId, activeSessionId, prioritizedSessionId])

    useEffect(() => {
      const abortController = new AbortController()

      async function loadSessions() {
        try {
          const response = await fetch("/api/chat/sessions", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: abortController.signal,
          })

          if (!response.ok) {
            const fallbackItems = resolveSessionItems(
              undefined,
              activeSessionId,
              activeRecordId,
              prioritizedSessionId,
            )
            setSections(buildConversationSections(fallbackItems))
            setActiveHref(resolvePreferredHref(fallbackItems, activeSessionId, activeRecordId))
            return
          }

          const payload = (await response.json()) as SessionsResponse
          const nextItems = resolveSessionItems(
            payload.sessions,
            activeSessionId,
            activeRecordId,
            prioritizedSessionId,
          )

          setSections(buildConversationSections(nextItems))
          setActiveHref((current) => {
            const preferredHref = resolvePreferredHref(nextItems, activeSessionId, activeRecordId)
            return nextItems.some((item) => item.href === current) && !activeSessionId && activeRecordId === null
              ? current
              : preferredHref
          })
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return
          }

          const fallbackItems = resolveSessionItems(
            undefined,
            activeSessionId,
            activeRecordId,
            prioritizedSessionId,
          )
          setSections(buildConversationSections(fallbackItems))
          setActiveHref(resolvePreferredHref(fallbackItems, activeSessionId, activeRecordId))
        }
      }

      void loadSessions()

      return () => abortController.abort()
    }, [activeRecordId, activeSessionId, prioritizedSessionId, refreshKey])

    const filteredSections = useMemo(() => {
      const normalizedQuery = normalizeSearchText(query)

      if (!normalizedQuery) {
        return sections
      }

      const queryTerms = normalizedQuery.split(" ").filter(Boolean)
      return sections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => matchesSessionQuery(item, queryTerms)),
        }))
        .filter((section) => section.items.length > 0)
    }, [query, sections])

    useEffect(() => {
      if (handledFocusSessionKeyRef.current === focusSessionKey || !activeSessionId) {
        return
      }

      if (query) {
        setQuery("")
        return
      }

      const sessionItems = sessionListRef.current?.querySelectorAll<HTMLElement>("[data-session-id]")
      const targetRecordId = activeRecordId === null ? null : String(activeRecordId)
      const activeItem = Array.from(sessionItems || []).find((item) => {
        if (item.dataset.sessionId !== activeSessionId) {
          return false
        }

        return targetRecordId === null || item.dataset.recordId === targetRecordId
      })

      if (!activeItem) {
        return
      }

      handledFocusSessionKeyRef.current = focusSessionKey
      sessionListRef.current?.scrollTo({
        top: 0,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      })
    }, [activeRecordId, activeSessionId, filteredSections, focusSessionKey, query])

    return (
      <nav
        ref={ref}
        id="chat-sider"
        aria-hidden={isCollapsed}
        className="fixed left-0 top-0 z-40 hidden h-full w-80 flex-col overflow-hidden border-r border-slate-200 bg-white/95 shadow-[16px_0_60px_rgba(15,23,42,0.06)] backdrop-blur-xl sm:flex">
        <div className="shrink-0 space-y-6 border-b border-slate-200 bg-white/95 pb-6 backdrop-blur-xl">
          <div className="px-4 md:px-8 mt-6">
            <SearchBox
              value={query}
              hasValue={query.trim().length > 0}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery("")}
              placeholder="Search conversations"
              aria-label="Search conversations"
            />
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={sessionListRef}
            className="min-h-0 h-full space-y-7 overflow-y-auto py-20 scroll-py-20 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {filteredSections.length > 0 ? (
              filteredSections.map((section) => (
                <div key={section.title}>
                  {/* <Title>{section.title}</Title> */}
                  <SectionsList
                    items={section.items}
                    activeHref={activeHref}
                    onSelect={handleSelectItem}
                    onDelete={handleDeleteItem}
                  />
                </div>
              ))
            ) : (
              <p className="px-8 text-sm text-slate-400">
                {query.trim() ? `No conversations matching "${query.trim()}"` : "No conversations"}
              </p>
            )}
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-white/95 backdrop-blur-[2px]"
            style={{
              WebkitMaskImage:
                "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
              maskImage:
                "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
            }}
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-white/95 backdrop-blur-[2px]"
            style={{
              WebkitMaskImage:
                "linear-gradient(to top, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
              maskImage:
                "linear-gradient(to top, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
            }}
            aria-hidden="true"
          />
        </div>
        <div className="shrink-0 border-t border-slate-100 bg-white/95">
          <UserInfo user={user} onLogout={handleLogout} />
        </div>
      </nav>
    )
  },
)

Sider.displayName = "Sider"

export default Sider

function resolveSessionItems(
  value: unknown,
  activeSessionId?: string,
  activeRecordId?: string | number | null,
  prioritizedSessionId?: string | null,
): NavItem[] {
  const items: NavItem[] = Array.isArray(value)
    ? value.filter(isAgentSession).map((session) => ({
        name: resolveSessionTitle(session.summary),
        href: buildSessionHref(session.sessionId, session.recordId),
        sessionId: session.sessionId,
        ...(session.recordId !== undefined ? { recordId: session.recordId } : {}),
        searchText: buildSessionSearchText(session),
      }))
    : []

  if (
    activeSessionId &&
    !items.some((item) =>
      matchesSessionIdentity(item, {
        sessionId: activeSessionId,
        recordId: activeRecordId,
      }),
    )
  ) {
    items.unshift(buildSessionItem(activeSessionId, activeRecordId))
  }

  const normalizedItems = items.length > 0 ? items : [defaultItem]
  const priorityRecordId = prioritizedSessionId === activeSessionId ? activeRecordId : null

  return prioritizeSessionItem(
    normalizedItems,
    prioritizedSessionId
      ? {
          sessionId: prioritizedSessionId,
          recordId: priorityRecordId,
        }
      : null,
  )
}

function buildConversationSections(items: NavItem[]): Section[] {
  return [
    {
      title: "Conversations",
      items,
    },
  ]
}

function buildSessionItem(sessionId: string, recordId?: string | number | null): NavItem {
  return {
    name: DEFAULT_TITLE,
    href: buildSessionHref(sessionId, recordId),
    sessionId,
    ...(recordId !== null && recordId !== undefined ? { recordId } : {}),
    searchText: normalizeSearchText([DEFAULT_TITLE, sessionId].join(" ")),
  }
}

function buildSessionHref(sessionId: string, recordId?: string | number | null): string {
  if (recordId !== null && recordId !== undefined && String(recordId).trim()) {
    return `#record-${encodeURIComponent(String(recordId))}`
  }

  return `#session-${encodeURIComponent(sessionId)}`
}

function resolvePreferredHref(items: NavItem[], activeSessionId?: string, activeRecordId?: string | number | null): string {
  if (activeSessionId) {
    const activeHref = buildSessionHref(activeSessionId, activeRecordId)
    if (items.some((item) => item.href === activeHref)) {
      return activeHref
    }

    const sessionItem = items.find((item) => item.sessionId === activeSessionId)
    if (sessionItem) {
      return sessionItem.href
    }
  }

  return items[0]?.href || defaultItem.href
}

function resolveSessionTitle(summary: string | null): string {
  if (!summary) {
    return DEFAULT_TITLE
  }

  const normalized = summary.replace(/\s+/g, " ").trim()
  const content = normalized
    .replace(/^(用户|助手)\s*[:：]\s*/, "")
    .split(/\s+(?:用户|助手)\s*[:：]/)[0]
    ?.trim()

  if (!content) {
    return DEFAULT_TITLE
  }

  const chars = Array.from(content)
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH).join("")}...` : content
}

function buildSessionSearchText(session: AgentSession): string {
  const messageText = Array.isArray(session.messages)
    ? session.messages.map((message) => message.content || "").join(" ")
    : ""

  return normalizeSearchText(
    [
      session.summary,
      session.sessionId,
      session.recordId === undefined ? null : String(session.recordId),
      messageText,
    ]
      .filter((item): item is string => Boolean(item))
      .join(" "),
  )
}

function matchesSessionQuery(item: NavItem, queryTerms: string[]): boolean {
  if (queryTerms.length === 0) {
    return true
  }

  const searchText = item.searchText || normalizeSearchText(item.name)
  return queryTerms.every((term) => searchText.includes(term))
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function isAgentSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== "object") {
    return false
  }

  const session = value as Partial<AgentSession>
  return (
    typeof session.sessionId === "string" &&
    (typeof session.summary === "string" || session.summary === null) &&
    typeof session.updatedAt === "string"
  )
}

function readStoredUser(): SiderUser {
  if (typeof window === "undefined") {
    return buildFallbackUser()
  }

  return (
    normalizeStoredUser(window.localStorage.getItem(AUTH_USER_STORAGE_KEY)) ||
    normalizeStoredUser(window.sessionStorage.getItem(AUTH_USER_STORAGE_KEY)) ||
    buildFallbackUser()
  )
}

function clearStoredAuth(): void {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.removeItem(AUTH_USER_STORAGE_KEY)
  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  window.sessionStorage.removeItem(AUTH_USER_STORAGE_KEY)
  window.sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

function normalizeStoredUser(value: string | null): SiderUser | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<AuthUser>
    if (typeof parsed.email !== "string" || !parsed.email.trim()) {
      return null
    }

    const email = parsed.email.trim()
    return {
      email,
      name: resolveUserDisplayName(email),
    }
  } catch {
    return null
  }
}

function buildFallbackUser(): SiderUser {
  return {
    name: "KL",
    email: "kl@example.com",
  }
}

function resolveUserDisplayName(email: string): string {
  const localPart = email.split("@")[0]?.trim()
  if (!localPart) {
    return "User"
  }

  const initials = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase())
    .join("")

  return initials || localPart.slice(0, 2).toUpperCase()
}
