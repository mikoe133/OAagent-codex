"use client"

import { forwardRef, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react"
import { ChevronsUpDown, LogOut, Network, Pin, Search, SquarePen, SunMoon, Trash2, UserRound, X } from "lucide-react"
import { useTheme } from "next-themes"

import { cn } from "@/lib/utils"
import { AUTH_TOKEN_STORAGE_KEY, AUTH_USER_STORAGE_KEY, type AuthUser } from "@/lib/auth"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ShiningText } from "@/components/ui/shining-text"
import { matchesSessionIdentity, resolveStableSessionOrder, sortSessionItemsByPinnedOrder } from "./session-list-order"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MODEL_PROVIDERS, isModelProvider, type ModelProvider } from "@/lib/model-catalog"

type NavItem = {
  name: string
  href: string
  sessionId?: string
  recordId?: string | number
  searchText?: string
  createdAt?: string
}

type Section = {
  title: string
  items: NavItem[]
}

type AgentSession = {
  sessionId: string
  summary: string | null
  createdAt: string
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

type CurrentUserResponse = {
  user?: unknown
}

type SiderUser = Pick<AuthUser, "email"> & {
  name: string
}

export type SessionIndicatorState = "running" | "paused" | "dismissing"

type SiderProps = {
  activeSessionId?: string
  activeRecordId?: string | number | null
  isCollapsed?: boolean
  isMobileOpen?: boolean
  focusSessionKey?: number
  onMobileClose?: () => void
  onNewSession: () => void
  onSelectSession?: (session: ChatSessionListItem) => void
  onDeleteSession: (session: ChatSessionListItem) => Promise<void>
  selectedProvider: ModelProvider
  onProviderChange: (provider: ModelProvider) => void
  providerSwitchDisabled?: boolean
  sessionIndicatorStates: ReadonlyMap<string, SessionIndicatorState>
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
const PINNED_SESSIONS_STORAGE_KEY = "oa-agent-pinned-session-ids"
const THEME_MODES = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色模式" },
  { value: "dark", label: "暗色模式" },
] as const

type ThemeMode = (typeof THEME_MODES)[number]["value"]

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
  <div
    data-slot="sider-search"
    className="group/search relative flex h-10 w-full items-center rounded-lg bg-[#f4f4f5] transition-[background-color,box-shadow] duration-200 hover:bg-slate-100 focus-within:bg-white focus-within:shadow-[0_6px_20px_rgba(15,23,42,0.08)] theme-dark:bg-zinc-800 theme-dark:hover:bg-zinc-700 theme-dark:focus-within:bg-zinc-800 theme-dark:focus-within:shadow-[0_6px_20px_rgba(0,0,0,0.28)]"
  >
    <Search
      className="pointer-events-none absolute left-3.5 h-4 w-4 text-slate-400 transition-colors duration-200 group-focus-within/search:text-slate-600 theme-dark:text-zinc-500 theme-dark:group-focus-within/search:text-zinc-300"
      aria-hidden="true"
    />
    <input
      {...props}
      type="search"
      className="h-full w-full appearance-none rounded-lg bg-transparent pl-10 pr-10 text-[13px] leading-5 text-slate-700 outline-none placeholder:text-slate-400 theme-dark:text-zinc-100 theme-dark:placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
    />
    {hasValue ? (
      <button
        type="button"
        aria-label="Clear search"
        className="absolute right-2 flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-[background-color,color,box-shadow] duration-150 hover:bg-white hover:text-slate-700 hover:shadow-[0_1px_3px_rgba(15,23,42,0.08)] focus-visible:bg-white focus-visible:text-slate-700 focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_rgba(15,23,42,0.08)] theme-dark:text-zinc-500 theme-dark:hover:bg-zinc-700 theme-dark:hover:text-zinc-100 theme-dark:focus-visible:bg-zinc-700 theme-dark:focus-visible:text-zinc-100"
        onClick={onClear}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    ) : null}
  </div>
)

const UserInfo = ({
  user,
  onLogout,
  selectedProvider,
  onProviderChange,
  providerSwitchDisabled = false,
}: {
  user: SiderUser
  onLogout: () => void
  selectedProvider: ModelProvider
  onProviderChange: (provider: ModelProvider) => void
  providerSwitchDisabled?: boolean
}) => (
  <div className="flex w-full items-center gap-3 px-6 py-4 text-left">
    <UserRound className="h-5 w-5 shrink-0 text-slate-950 theme-dark:text-zinc-100" strokeWidth={1.8} aria-hidden="true" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium leading-5 text-slate-950 theme-dark:text-zinc-100">{user.name}</span>
      <span className="block truncate text-xs leading-4 text-slate-500 theme-dark:text-zinc-400">{user.email}</span>
    </span>
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="h-8 w-8 shrink-0 rounded-md text-slate-950 transition-colors duration-150 hover:bg-slate-100 data-[state=open]:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 theme-dark:text-zinc-100 theme-dark:hover:bg-zinc-800 theme-dark:data-[state=open]:bg-zinc-800 theme-dark:focus-visible:ring-white/15"
        aria-label="Open user menu"
      >
        <ChevronsUpDown className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={10}
        className="z-[9999] w-48 overflow-visible rounded-xl border-slate-200 bg-white p-1 shadow-[0_14px_32px_rgba(15,23,42,0.14)] theme-dark:border-zinc-700 theme-dark:bg-zinc-900 theme-dark:shadow-[0_14px_32px_rgba(0,0,0,0.4)]"
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={providerSwitchDisabled}
            className="h-11 rounded-lg px-3 text-sm text-slate-700 focus:bg-slate-100 data-[state=open]:bg-slate-100 theme-dark:text-zinc-200 theme-dark:focus:bg-zinc-800 theme-dark:data-[state=open]:bg-zinc-800"
          >
            <Network className="h-4 w-4 text-slate-500 theme-dark:text-zinc-400" aria-hidden="true" />
            模型提供商
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            sideOffset={8}
            className="z-[10000] w-40 rounded-xl border-slate-200 bg-white p-1 shadow-[0_14px_32px_rgba(15,23,42,0.14)] theme-dark:border-zinc-700 theme-dark:bg-zinc-900 theme-dark:shadow-[0_14px_32px_rgba(0,0,0,0.4)]"
          >
            <DropdownMenuRadioGroup
              value={selectedProvider}
              onValueChange={(value) => {
                if (isModelProvider(value)) {
                  onProviderChange(value)
                }
              }}
            >
              {MODEL_PROVIDERS.map((provider) => (
                <DropdownMenuRadioItem
                  key={provider.id}
                  value={provider.id}
                  className="h-10 rounded-lg text-sm text-slate-700 focus:bg-slate-100 theme-dark:text-zinc-200 theme-dark:focus:bg-zinc-800"
                >
                  {provider.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <ThemeModeMenu />
        <DropdownMenuSeparator className="mx-1 bg-slate-100 theme-dark:bg-zinc-800" />
        <DropdownMenuItem
          onSelect={onLogout}
          className="rounded-lg text-sm text-red-600 focus:bg-red-50 focus:text-red-600 theme-dark:text-red-400 theme-dark:focus:bg-red-950/50 theme-dark:focus:text-red-300"
        >
          <LogOut className="h-4 w-4 text-red-600 theme-dark:text-red-400" aria-hidden="true" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
)

const ThemeModeMenu = () => {
  const { theme, setTheme } = useTheme()
  const selectedTheme = isThemeMode(theme) ? theme : "light"

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="h-11 rounded-lg px-3 text-sm text-slate-700 focus:bg-slate-100 data-[state=open]:bg-slate-100 theme-dark:text-zinc-200 theme-dark:focus:bg-zinc-800 theme-dark:data-[state=open]:bg-zinc-800">
        <SunMoon className="h-4 w-4 text-slate-500 theme-dark:text-zinc-400" aria-hidden="true" />
        主题模式
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        className="z-[10000] w-40 rounded-xl border-slate-200 bg-white p-1 shadow-[0_14px_32px_rgba(15,23,42,0.14)] theme-dark:border-zinc-700 theme-dark:bg-zinc-900 theme-dark:shadow-[0_14px_32px_rgba(0,0,0,0.4)]"
      >
        <DropdownMenuRadioGroup value={selectedTheme} onValueChange={setTheme}>
          {THEME_MODES.map((mode) => (
            <DropdownMenuRadioItem
              key={mode.value}
              value={mode.value}
              className="h-10 rounded-lg text-sm text-slate-700 focus:bg-slate-100 theme-dark:text-zinc-200 theme-dark:focus:bg-zinc-800"
            >
              {mode.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const PinConversationButton = ({
  name,
  isPinned,
  onToggle,
}: {
  name: string
  isPinned: boolean
  onToggle: () => void
}) => (
  <button
    data-slot="session-pin-button"
    type="button"
    aria-label={`${isPinned ? "Unpin" : "Pin"} ${name}`}
    aria-pressed={isPinned}
    title={isPinned ? "取消置顶" : "置顶"}
    className={cn(
      "ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-[opacity,background-color,color] duration-150 focus:opacity-100 group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/25 theme-dark:focus-visible:ring-zinc-500/30",
      isPinned
        ? "bg-transparent text-[#cfd5df] opacity-100 hover:bg-transparent hover:text-slate-700 theme-dark:bg-transparent theme-dark:text-[#cfd5df] theme-dark:hover:bg-transparent theme-dark:hover:text-zinc-200"
        : "bg-[#f5f5f5] text-slate-400 opacity-0 hover:bg-[#f5f5f5] hover:text-slate-700 theme-dark:bg-zinc-800 theme-dark:text-zinc-500 theme-dark:hover:bg-zinc-800 theme-dark:hover:text-zinc-300",
    )}
    onClick={(event) => {
      event.preventDefault()
      event.stopPropagation()
      onToggle()
    }}
  >
    <Pin className={cn("size-3.5", isPinned && "fill-current")} aria-hidden="true" />
  </button>
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
          className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#f5f5f5] opacity-0 transition-[opacity,background-color] duration-150 hover:bg-[#eeeeee] focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f56565]/25 group-hover:opacity-100 data-[state=open]:bg-[#eeeeee] data-[state=open]:opacity-100 theme-dark:bg-zinc-800 theme-dark:hover:bg-zinc-700 theme-dark:data-[state=open]:bg-zinc-700"
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
        className="z-[100] w-60 rounded-lg border-slate-200 bg-white p-3 text-slate-950 shadow-[0_12px_32px_rgba(15,23,42,0.14)] theme-dark:border-zinc-700 theme-dark:bg-zinc-900 theme-dark:text-zinc-100 theme-dark:shadow-[0_12px_32px_rgba(0,0,0,0.4)]"
      >
        <p id={titleId} className="text-sm font-semibold">
          删除此对话？
        </p>
        <p id={descriptionId} className="mt-1 text-xs leading-5 text-slate-500 theme-dark:text-zinc-400">
          删除后将无法恢复。
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="h-8 rounded-md px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 theme-dark:text-zinc-300 theme-dark:hover:bg-zinc-800 theme-dark:hover:text-white theme-dark:focus-visible:ring-white/15"
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
  activeSessionId,
  onSelect,
  onTogglePinned,
  onDelete,
  pinnedSessionIds,
  sessionIndicatorStates,
}: {
  items: NavItem[]
  activeHref: string
  activeSessionId?: string
  onSelect: (item: NavItem) => void
  onTogglePinned: (item: NavItem) => void
  onDelete: (item: NavItem) => void
  pinnedSessionIds: readonly string[]
  sessionIndicatorStates: ReadonlyMap<string, SessionIndicatorState>
}) => (
  <div className="px-4 text-slate-600 theme-dark:text-zinc-400 md:px-8">
    <ul>
      {items.map((item) => {
        const indicatorState = item.sessionId ? sessionIndicatorStates.get(item.sessionId) : undefined
        const isRunning = indicatorState === "running"
        const isUnread = indicatorState === "paused" && item.sessionId !== activeSessionId
        const isPinned = item.sessionId ? pinnedSessionIds.includes(item.sessionId) : false

        return (
          <li
            key={item.href}
            className="group flex items-center"
            data-session-id={item.sessionId}
            data-record-id={item.recordId === undefined ? undefined : String(item.recordId)}
          >
            <NavLink
              href={item.href}
              active={activeHref === item.href}
              activeClassName={cn(
                "text-[#0f1828] theme-dark:text-zinc-50",
                isPinned ? "border-[#ec4899]" : "border-[#4f39f7] theme-dark:border-violet-400",
              )}
              className={cn(
                "flex min-w-0 flex-1 items-center border-l border-slate-200 px-4 py-2.5 text-sm font-medium transition duration-150 hover:border-[#4f39f7] hover:text-[#0f1828] theme-dark:border-zinc-700 theme-dark:hover:border-violet-400 theme-dark:hover:text-zinc-50",
                isPinned && "border-[#ec4899] hover:border-[#ec4899] theme-dark:border-[#ec4899] theme-dark:hover:border-[#ec4899]",
              )}
              onSelect={() => onSelect(item)}
              title={item.name}
            >
              <span className="flex min-w-0 flex-1 items-center">
                {isRunning ? (
                  <ShiningText text={item.name} />
                ) : (
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{item.name}</span>
                )}
                {isUnread ? (
                  <span
                    data-slot="session-unread-indicator"
                    role="status"
                    aria-label={`${item.name} has an unread response`}
                    className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                  />
                ) : null}
              </span>
              {isRunning ? (
                <span
                  data-slot="session-loading-indicator"
                  role="status"
                  aria-label={`${item.name} is generating`}
                  className="sr-only"
                />
              ) : null}
            </NavLink>
            {item.sessionId ? (
              <PinConversationButton
                name={item.name}
                isPinned={isPinned}
                onToggle={() => onTogglePinned(item)}
              />
            ) : null}
            <DeleteConversationButton name={item.name} onConfirm={() => onDelete(item)} />
          </li>
        )
      })}
    </ul>
  </div>
)

const Sider = forwardRef<HTMLElement, SiderProps>(
  (
    {
      activeSessionId,
      activeRecordId = null,
      isCollapsed = false,
      isMobileOpen = false,
      focusSessionKey = 0,
      onMobileClose,
      onNewSession,
      onSelectSession,
      onDeleteSession,
      selectedProvider,
      onProviderChange,
      providerSwitchDisabled = false,
      sessionIndicatorStates,
      refreshKey = 0,
    },
    ref,
  ) => {
    const [sections, setSections] = useState<Section[]>(defaultSections)
    const [activeHref, setActiveHref] = useState(defaultItem.href)
    const [query, setQuery] = useState("")
    const [user, setUser] = useState<SiderUser>(() => buildFallbackUser())
    const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>([])
    const pinnedSessionIdsRef = useRef<string[]>([])
    const sessionListRef = useRef<HTMLDivElement>(null)
    const handledFocusSessionKeyRef = useRef(focusSessionKey)
    const deletedSessionIdsRef = useRef(new Set<string>())

    async function handleDeleteItem(item: NavItem) {
      const sessionId = item.sessionId
      if (!sessionId) {
        removeSessionItem(item.href)
        return
      }

      deletedSessionIdsRef.current.add(sessionId)
      try {
        await onDeleteSession({
          sessionId,
          ...(item.recordId !== undefined ? { recordId: item.recordId } : {}),
        })
        updatePinnedSessionIds((currentIds) => currentIds.filter((currentId) => currentId !== sessionId))
        removeSessionItem(item.href)
      } catch (error) {
        deletedSessionIdsRef.current.delete(sessionId)
        console.error("Failed to delete chat session:", error)
      }
    }

    function removeSessionItem(href: string) {
      setSections((currentSections) => {
        const nextSections = currentSections
          .map((section) => ({
            ...section,
            items: section.items.filter((item) => item.href !== href),
          }))
          .filter((section) => section.items.length > 0)
        return nextSections.length > 0 ? nextSections : defaultSections
      })
      setActiveHref((current) => (current === href ? defaultItem.href : current))
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

    function handleTogglePinnedItem(item: NavItem) {
      const sessionId = item.sessionId
      if (!sessionId) {
        return
      }

      updatePinnedSessionIds((currentIds) =>
        currentIds.includes(sessionId)
          ? currentIds.filter((currentId) => currentId !== sessionId)
          : [sessionId, ...currentIds],
      )
    }

    function updatePinnedSessionIds(update: (currentIds: string[]) => string[]) {
      const nextIds = update(pinnedSessionIdsRef.current)
      pinnedSessionIdsRef.current = nextIds
      setPinnedSessionIds(nextIds)

      try {
        window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify(nextIds))
      } catch (error) {
        console.error("Failed to persist pinned chat sessions:", error)
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
      const abortController = new AbortController()
      setUser(readStoredUser())
      const storedPinnedSessionIds = readPinnedSessionIds()
      pinnedSessionIdsRef.current = storedPinnedSessionIds
      setPinnedSessionIds(storedPinnedSessionIds)

      async function syncCurrentUser() {
        try {
          const response = await fetch("/api/auth/me", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: abortController.signal,
          })
          if (!response.ok) {
            return
          }

          const payload = (await response.json()) as CurrentUserResponse
          const resolvedUser = normalizeUser(payload.user)
          if (resolvedUser) {
            setUser(resolvedUser)
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            console.error("Failed to sync current user:", error)
          }
        }
      }

      void syncCurrentUser()
      return () => abortController.abort()
    }, [])

    useEffect(() => {
      if (activeSessionId && !deletedSessionIdsRef.current.has(activeSessionId)) {
        setActiveHref(buildSessionHref(activeSessionId, activeRecordId))
        setSections((currentSections) =>
          reconcileActiveSession(currentSections, activeSessionId, activeRecordId),
        )
      }
    }, [activeRecordId, activeSessionId])

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
            return
          }

          const payload = (await response.json()) as SessionsResponse
          const nextItems = resolveSessionItems(payload.sessions, deletedSessionIdsRef.current)

          setSections(buildConversationSections(nextItems))
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return
          }
          console.error("Failed to load chat sessions:", error)
        }
      }

      void loadSessions()

      return () => abortController.abort()
    }, [refreshKey])

    const filteredSections = useMemo(() => {
      const normalizedQuery = normalizeSearchText(query)

      const queryTerms = normalizedQuery.split(" ").filter(Boolean)
      return sections
        .map((section) => ({
          ...section,
          items: sortSessionItemsByPinnedOrder(
            normalizedQuery
              ? section.items.filter((item) => matchesSessionQuery(item, queryTerms))
              : section.items,
            pinnedSessionIds,
          ),
        }))
        .filter((section) => section.items.length > 0)
    }, [pinnedSessionIds, query, sections])

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
        aria-label="Conversations"
        aria-hidden={isCollapsed && !isMobileOpen}
        className={cn(
          "fixed left-0 top-0 z-40 flex h-dvh w-[min(20rem,calc(100vw-3rem))] flex-col overflow-hidden border-r border-slate-200 bg-white/95 shadow-[16px_0_60px_rgba(15,23,42,0.12)] backdrop-blur-xl transition-[transform,visibility] duration-300 ease-out theme-dark:border-zinc-800 theme-dark:bg-zinc-950/95 theme-dark:shadow-[16px_0_60px_rgba(0,0,0,0.32)] sm:visible sm:h-full sm:w-80 sm:translate-x-0 sm:pointer-events-auto sm:transition-none",
          isMobileOpen ? "visible translate-x-0 pointer-events-auto" : "invisible -translate-x-full pointer-events-none",
        )}
      >
        <button
          type="button"
          onClick={onMobileClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-stone-600 transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 theme-dark:bg-zinc-800 theme-dark:text-zinc-300 theme-dark:hover:bg-zinc-700 theme-dark:focus-visible:ring-white/15 sm:hidden"
          aria-label="Close conversations"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <div
          data-slot="sider-actions"
          className="grid shrink-0 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-2 bg-white/95 px-4 pb-4 pt-14 backdrop-blur-xl theme-dark:bg-zinc-950/95 sm:pt-6 md:px-8"
        >
          <div className="min-w-0">
            <SearchBox
              value={query}
              hasValue={query.trim().length > 0}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery("")}
              placeholder="Search"
              aria-label="Search conversations"
            />
          </div>
          <button
            data-slot="new-chat-button"
            type="button"
            onClick={onNewSession}
            className="flex h-10 min-w-0 items-center justify-center gap-2 rounded-lg border-0 bg-[#f4f4f5] px-2 text-sm font-medium text-slate-700 transition-colors hover:bg-[#e4e4e7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 theme-dark:bg-zinc-800 theme-dark:text-zinc-200 theme-dark:hover:bg-zinc-700 theme-dark:focus-visible:ring-white/15"
          >
            <SquarePen className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">New</span>
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={sessionListRef}
            className="min-h-0 h-full space-y-7 overflow-y-auto pb-20 pt-4 scroll-pb-20 scroll-pt-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {filteredSections.length > 0 ? (
              filteredSections.map((section) => (
                <div key={section.title}>
                  {/* <Title>{section.title}</Title> */}
                  <SectionsList
                    items={section.items}
                    activeHref={activeHref}
                    activeSessionId={activeSessionId}
                    onSelect={handleSelectItem}
                    onTogglePinned={handleTogglePinnedItem}
                    onDelete={handleDeleteItem}
                    pinnedSessionIds={pinnedSessionIds}
                    sessionIndicatorStates={sessionIndicatorStates}
                  />
                </div>
              ))
            ) : (
              <p className="px-8 text-sm text-slate-400 theme-dark:text-zinc-500">
                {query.trim() ? `No conversations matching "${query.trim()}"` : "No conversations"}
              </p>
            )}
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-white/95 backdrop-blur-[2px] theme-dark:bg-zinc-950/95"
            style={{
              WebkitMaskImage:
                "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
              maskImage:
                "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
            }}
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-white/95 backdrop-blur-[2px] theme-dark:bg-zinc-950/95"
            style={{
              WebkitMaskImage:
                "linear-gradient(to top, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
              maskImage:
                "linear-gradient(to top, #000 0%, rgba(0,0,0,0.995) 10%, rgba(0,0,0,0.975) 20%, rgba(0,0,0,0.92) 30%, rgba(0,0,0,0.82) 42%, rgba(0,0,0,0.66) 54%, rgba(0,0,0,0.46) 66%, rgba(0,0,0,0.27) 77%, rgba(0,0,0,0.12) 87%, rgba(0,0,0,0.03) 95%, transparent 100%)",
            }}
            aria-hidden="true"
          />
        </div>
        <div className="shrink-0 border-t border-slate-100 bg-white/95 theme-dark:border-zinc-800 theme-dark:bg-zinc-950/95">
          <UserInfo
            user={user}
            onLogout={handleLogout}
            selectedProvider={selectedProvider}
            onProviderChange={onProviderChange}
            providerSwitchDisabled={providerSwitchDisabled}
          />
        </div>
      </nav>
    )
  },
)

Sider.displayName = "Sider"

export default Sider

function isThemeMode(value: string | undefined): value is ThemeMode {
  return THEME_MODES.some((mode) => mode.value === value)
}

function readPinnedSessionIds(): string[] {
  try {
    const storedValue = JSON.parse(window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY) || "[]")
    if (!Array.isArray(storedValue)) {
      return []
    }

    const normalizedIds = storedValue.flatMap((value) =>
      typeof value === "string" && value.trim() ? [value.trim()] : [],
    )
    return Array.from(new Set(normalizedIds))
  } catch {
    return []
  }
}
function resolveSessionItems(
  value: unknown,
  deletedSessionIds: ReadonlySet<string> = new Set(),
): NavItem[] {
  const items: NavItem[] = resolveStableSessionOrder(
    Array.isArray(value)
      ? value
          .filter(isAgentSession)
          .filter((session) => !deletedSessionIds.has(session.sessionId))
          .map((session) => ({
            name: resolveSessionTitle(session.summary),
            href: buildSessionHref(session.sessionId, session.recordId),
            sessionId: session.sessionId,
            ...(session.recordId !== undefined ? { recordId: session.recordId } : {}),
            searchText: buildSessionSearchText(session),
            createdAt: session.createdAt,
          }))
      : [],
  )
  return items.length > 0 ? items : [defaultItem]
}

function reconcileActiveSession(
  sections: Section[],
  activeSessionId: string,
  activeRecordId?: string | number | null,
): Section[] {
  const activeIdentity = { sessionId: activeSessionId, recordId: activeRecordId }
  const currentItems = sections.flatMap((section) => section.items).filter((item) => item.sessionId)
  if (currentItems.some((item) => matchesSessionIdentity(item, activeIdentity))) {
    return sections
  }

  const sessionIndex = currentItems.findIndex((item) => item.sessionId === activeSessionId)
  if (sessionIndex < 0) {
    return buildConversationSections([buildSessionItem(activeSessionId, activeRecordId), ...currentItems])
  }

  const nextItems = currentItems.map((item, index) =>
    index === sessionIndex
      ? {
          ...item,
          href: buildSessionHref(activeSessionId, activeRecordId),
          ...(activeRecordId !== null && activeRecordId !== undefined ? { recordId: activeRecordId } : {}),
        }
      : item,
  )
  return buildConversationSections(nextItems)
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
    typeof session.createdAt === "string" &&
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
    return normalizeUser(JSON.parse(value) as unknown)
  } catch {
    return null
  }
}

function normalizeUser(value: unknown): SiderUser | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const user = value as Partial<AuthUser>
  if (typeof user.email !== "string" || !user.email.trim()) {
    return null
  }

  const email = user.email.trim()
  return {
    email,
    name: resolveUserDisplayName(email),
  }
}

function buildFallbackUser(): SiderUser {
  return {
    name: "OA",
    email: "正在同步账号信息",
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
