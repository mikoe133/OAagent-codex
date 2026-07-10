"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

import { cn } from "@/lib/utils"

function extractBorderRadius(className?: string): string {
  if (!className) return "12px"

  const arbitraryMatch = className.match(/rounded-\[([^\]]+)\]/)
  if (arbitraryMatch) return arbitraryMatch[1]

  if (className.includes("rounded-none")) return "0px"
  if (className.includes("rounded-sm")) return "0.125rem"
  if (className.includes("rounded-md")) return "0.375rem"
  if (className.includes("rounded-lg")) return "0.5rem"
  if (className.includes("rounded-xl")) return "0.75rem"
  if (className.includes("rounded-2xl")) return "1rem"
  if (className.includes("rounded-3xl")) return "1.5rem"
  if (className.includes("rounded-full")) return "9999px"
  if (className.includes("rounded")) return "0.25rem"

  return "12px"
}

const MINIMUM_PRESS_MS = 300

type RippleVariant = "trigger" | "item"

function useInternalRipple({
  disabled = false,
  variant = "item",
}: {
  disabled?: boolean
  variant?: RippleVariant
} = {}) {
  const [pressed, setPressed] = React.useState(false)
  const surfaceRef = React.useRef<HTMLDivElement | HTMLSpanElement | null>(null)
  const rippleRef = React.useRef<HTMLDivElement | null>(null)
  const growAnimationRef = React.useRef<Animation | null>(null)
  const isMounted = React.useRef(true)

  React.useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const startPressAnimation = (event?: React.PointerEvent | React.KeyboardEvent) => {
    if (disabled || !surfaceRef.current || !rippleRef.current) return

    const rect = surfaceRef.current.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    setPressed(true)
    growAnimationRef.current?.cancel()

    let clickX = rect.width / 2
    let clickY = rect.height / 2

    if (event && "clientX" in event) {
      clickX = event.clientX - rect.left
      clickY = event.clientY - rect.top
    }

    if (variant === "trigger") {
      const maxDistance = Math.max(
        Math.hypot(clickX, clickY),
        Math.hypot(rect.width - clickX, clickY),
        Math.hypot(clickX, rect.height - clickY),
        Math.hypot(rect.width - clickX, rect.height - clickY),
      )

      const finalRadius = maxDistance / 0.65
      const finalSize = finalRadius * 2
      const initialScale = Math.min(10 / finalSize, 0.04)
      const areaDuration = Math.sqrt(rect.width * rect.height) * 3
      const duration = Math.min(Math.max(600, areaDuration), 1000)

      rippleRef.current.style.width = `${finalSize}px`
      rippleRef.current.style.height = `${finalSize}px`

      const left = clickX - finalRadius
      const top = clickY - finalRadius
      const centerLeft = (rect.width - finalSize) / 2
      const centerTop = (rect.height - finalSize) / 2

      growAnimationRef.current = rippleRef.current.animate(
        [
          { transform: `translate(${left}px, ${top}px) scale(${initialScale})` },
          { transform: `translate(${centerLeft}px, ${centerTop}px) scale(1)` },
        ],
        { duration, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
      )
      return
    }

    const maxDim = Math.max(rect.width, rect.height)
    const softEdgeSize = Math.max(0.35 * maxDim, 75)
    const initialSize = Math.max(2, Math.floor(maxDim * 0.2))
    const hypotenuse = Math.sqrt(rect.width ** 2 + rect.height ** 2)
    const maxRadius = hypotenuse + 10
    const duration = Math.min(Math.max(400, hypotenuse * 1.5), 1000)
    const scale = (maxRadius + softEdgeSize) / initialSize

    rippleRef.current.style.width = `${initialSize}px`
    rippleRef.current.style.height = `${initialSize}px`

    const startX = clickX - initialSize / 2
    const startY = clickY - initialSize / 2
    const endX = (rect.width - initialSize) / 2
    const endY = (rect.height - initialSize) / 2

    growAnimationRef.current = rippleRef.current.animate(
      [
        { transform: `translate(${startX}px, ${startY}px) scale(1)` },
        { transform: `translate(${endX}px, ${endY}px) scale(${scale})` },
      ],
      { duration, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
    )
  }

  const endPressAnimation = async () => {
    const animation = growAnimationRef.current
    if (animation && typeof animation.currentTime === "number" && animation.currentTime < MINIMUM_PRESS_MS) {
      await new Promise((resolve) => setTimeout(resolve, MINIMUM_PRESS_MS - (animation.currentTime as number)))
    }
    if (isMounted.current) setPressed(false)
  }

  return {
    surfaceRef,
    rippleRef,
    pressed,
    events: {
      onPointerDown: (event: React.PointerEvent) => {
        if (event.button === 0) startPressAnimation(event)
      },
      onPointerUp: endPressAnimation,
      onPointerLeave: endPressAnimation,
      onPointerCancel: endPressAnimation,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          startPressAnimation(event)
          setTimeout(endPressAnimation, MINIMUM_PRESS_MS)
        }
      },
    },
  }
}

const RippleLayer = ({
  pressed,
  rippleRef,
  variant = "item",
}: {
  pressed: boolean
  rippleRef: React.RefObject<HTMLDivElement | null>
  variant?: RippleVariant
}) => (
  <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]">
    <div className="absolute inset-0 bg-current opacity-0 transition-opacity duration-200 group-hover:opacity-[0.08] group-data-[highlighted]:opacity-[0.08]" />
    <div
      ref={rippleRef}
      className="absolute rounded-full bg-current opacity-0"
      style={{
        background:
          variant === "trigger"
            ? "radial-gradient(closest-side, currentColor 65%, transparent 100%)"
            : "radial-gradient(closest-side, currentColor max(calc(100% - 70px), 65%), transparent 100%)",
        transition: "opacity 375ms linear",
        opacity: pressed ? "0.12" : "0",
        transitionDuration: pressed ? "100ms" : "375ms",
        top: 0,
        left: 0,
      }}
    />
  </div>
)

const M3Styles = () => (
  <style
    id="m3-dropdown-styles"
    dangerouslySetInnerHTML={{
      __html: `
        @media (prefers-reduced-motion: no-preference) {
          @keyframes m3-sweep-down { 0% { clip-path: inset(0 0 100% 0 round var(--m3-menu-radius, 12px)); } 100% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); } }
          @keyframes m3-sweep-up { 0% { clip-path: inset(100% 0 0 0 round var(--m3-menu-radius, 12px)); } 100% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); } }
          @keyframes m3-sweep-right { 0% { clip-path: inset(0 100% 0 0 round var(--m3-menu-radius, 12px)); } 100% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); } }
          @keyframes m3-sweep-left { 0% { clip-path: inset(0 0 0 100% round var(--m3-menu-radius, 12px)); } 100% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); } }
          @keyframes m3-sweep-out-up { 0% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); opacity: 1; } 100% { clip-path: inset(0 0 100% 0 round var(--m3-menu-radius, 12px)); opacity: 0; } }
          @keyframes m3-sweep-out-down { 0% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); opacity: 1; } 100% { clip-path: inset(100% 0 0 0 round var(--m3-menu-radius, 12px)); opacity: 0; } }
          @keyframes m3-sweep-out-left { 0% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); opacity: 1; } 100% { clip-path: inset(0 100% 0 0 round var(--m3-menu-radius, 12px)); opacity: 0; } }
          @keyframes m3-sweep-out-right { 0% { clip-path: inset(0 0 0 0 round var(--m3-menu-radius, 12px)); opacity: 1; } 100% { clip-path: inset(0 0 0 100% round var(--m3-menu-radius, 12px)); opacity: 0; } }
          @keyframes m3-item-cinematic { 0% { opacity: 0; transform: translateY(8px) scale(0.98); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
          @keyframes m3-item-exit { 0% { opacity: 1; transform: translateY(0) scale(1); } 100% { opacity: 0; transform: translateY(4px) scale(0.95); } }
          .m3-content[data-state="open"] { opacity: 1; }
          .m3-content[data-state="closed"] { opacity: 0; transition: opacity 200ms linear; }
          .m3-content[data-state="open"][data-side="bottom"] { animation: m3-sweep-down 400ms cubic-bezier(0.1, 0.8, 0.2, 1) forwards; }
          .m3-content[data-state="open"][data-side="top"] { animation: m3-sweep-up 400ms cubic-bezier(0.1, 0.8, 0.2, 1) forwards; }
          .m3-content[data-state="open"][data-side="right"] { animation: m3-sweep-right 400ms cubic-bezier(0.1, 0.8, 0.2, 1) forwards; }
          .m3-content[data-state="open"][data-side="left"] { animation: m3-sweep-left 400ms cubic-bezier(0.1, 0.8, 0.2, 1) forwards; }
          .m3-content[data-state="closed"][data-side="bottom"] { animation: m3-sweep-out-up 300ms cubic-bezier(0.4, 0, 1, 1) forwards; }
          .m3-content[data-state="closed"][data-side="top"] { animation: m3-sweep-out-down 300ms cubic-bezier(0.4, 0, 1, 1) forwards; }
          .m3-content[data-state="closed"][data-side="right"] { animation: m3-sweep-out-left 300ms cubic-bezier(0.4, 0, 1, 1) forwards; }
          .m3-content[data-state="closed"][data-side="left"] { animation: m3-sweep-out-right 300ms cubic-bezier(0.4, 0, 1, 1) forwards; }
          .m3-content[data-state="open"] .m3-item-enter { opacity: 0; animation: m3-item-cinematic 350ms cubic-bezier(0.1, 0.8, 0.2, 1) forwards; animation-delay: calc(var(--m3-stagger, 0) * 30ms + 40ms); }
          .m3-content[data-state="closed"] .m3-item-enter { animation: m3-item-exit 200ms cubic-bezier(0.4, 0, 1, 1) forwards; }
        }
      `,
    }}
  />
)

const DropdownMenu = DropdownMenuPrimitive.Root

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ children, className, asChild = false, ...props }, ref) => {
  const { surfaceRef, rippleRef, pressed, events } = useInternalRipple({ variant: "trigger" })

  if (asChild && React.isValidElement(children)) {
    return (
      <DropdownMenuPrimitive.Trigger
        ref={ref}
        asChild
        className={cn("group relative overflow-hidden outline-none", className)}
        {...events}
        {...props}
      >
        {React.cloneElement(children as React.ReactElement<{ children?: React.ReactNode }>, {
          children: (
            <>
              <RippleLayer rippleRef={rippleRef} pressed={pressed} variant="trigger" />
              <span ref={surfaceRef as React.RefObject<HTMLSpanElement | null>} className="absolute inset-0 z-0" />
              <div className="pointer-events-none relative z-10 flex h-full w-full items-center justify-center gap-[inherit]">
                {(children.props as { children?: React.ReactNode }).children}
              </div>
            </>
          ),
        })}
      </DropdownMenuPrimitive.Trigger>
    )
  }

  return (
    <DropdownMenuPrimitive.Trigger ref={ref} asChild {...props}>
      <button
        className={cn("group relative flex items-center justify-center overflow-hidden rounded-xl outline-none transition-all", className)}
        {...events}
      >
        <RippleLayer rippleRef={rippleRef} pressed={pressed} variant="trigger" />
        <span ref={surfaceRef as React.RefObject<HTMLSpanElement | null>} className="absolute inset-0 z-0" />
        <div className="pointer-events-none relative z-10 flex h-full w-full items-center justify-center gap-[inherit]">
          {children}
        </div>
      </button>
    </DropdownMenuPrimitive.Trigger>
  )
})
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 8, children, ...props }, ref) => {
  const staggeredChildren = React.Children.map(children, (child, index) => {
    if (!React.isValidElement<{ style?: React.CSSProperties }>(child)) return child
    return React.cloneElement(child, {
      style: {
        ...child.props.style,
        "--m3-stagger": index,
      } as React.CSSProperties,
    })
  })

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        style={
          {
            "--m3-menu-radius": extractBorderRadius(className),
            ...props.style,
          } as React.CSSProperties
        }
        className={cn(
          "m3-content relative z-50 overflow-hidden rounded-xl border border-border/20 bg-popover/95 py-0 text-popover-foreground shadow-[0px_8px_32px_rgba(0,0,0,0.12)] outline-none backdrop-blur-xl",
          "origin-[var(--radix-dropdown-menu-content-transform-origin)]",
          className,
        )}
        {...props}
      >
        <M3Styles />
        {staggeredChildren}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
})
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
    delayDuration?: number
    enterAnimation?: boolean
  }
>(({ className, inset, children, delayDuration = 250, enterAnimation = true, ...props }, ref) => {
  const { surfaceRef, rippleRef, pressed, events } = useInternalRipple({
    disabled: props.disabled,
    variant: "item",
  })

  const handleSelect = (event: Event) => {
    const isKeyboard = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent?.type === "keydown"
    if (delayDuration > 0 && !isKeyboard) {
      event.preventDefault()
      setTimeout(() => props.onSelect?.(event), delayDuration)
      return
    }
    props.onSelect?.(event)
  }

  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "group relative flex min-h-12 cursor-pointer select-none items-stretch overflow-hidden rounded-none px-0 text-sm font-medium tracking-[0.01em] outline-none transition-colors",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        enterAnimation && "m3-item-enter",
        className,
      )}
      {...events}
      {...props}
      onSelect={handleSelect}
    >
      <div
        ref={(node) => {
          surfaceRef.current = node
        }}
        className={cn("relative flex flex-1 items-center px-4", inset && "pl-12")}
      >
        <RippleLayer rippleRef={rippleRef} pressed={pressed} variant="item" />
        <span className="pointer-events-none relative z-10 flex w-full items-center gap-3">{children}</span>
      </div>
    </DropdownMenuPrimitive.Item>
  )
})
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem }
