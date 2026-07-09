"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { ArrowUpRight } from "lucide-react"
import { gsap } from "gsap"

import styles from "./card-nav.module.css"

type CardNavLink = {
  label: string
  href?: string
  ariaLabel: string
}

export type CardNavItem = {
  label: string
  bgColor: string
  textColor: string
  links: CardNavLink[]
}

export interface CardNavProps {
  logo: string
  logoAlt?: string
  items: CardNavItem[]
  className?: string
  ease?: string
  baseColor?: string
  menuColor?: string
  buttonBgColor?: string
  buttonTextColor?: string
  theme?: "light" | "dark"
}

export function CardNav({
  logo,
  logoAlt = "Logo",
  items,
  className = "",
  ease = "power3.out",
  baseColor = "#fff",
  menuColor,
  buttonBgColor,
  buttonTextColor,
  theme = "light",
}: CardNavProps) {
  const [isHamburgerOpen, setIsHamburgerOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const navRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const cardsRef = useRef<HTMLDivElement[]>([])
  const tlRef = useRef<gsap.core.Timeline | null>(null)

  const calculateHeight = () => {
    const navEl = navRef.current
    const contentEl = contentRef.current
    if (!navEl) return 260

    const isMobile = window.matchMedia("(max-width: 768px)").matches
    if (isMobile && contentEl) {
      const previousVisibility = contentEl.style.visibility
      const previousPointerEvents = contentEl.style.pointerEvents
      const previousPosition = contentEl.style.position
      const previousHeight = contentEl.style.height

      contentEl.style.visibility = "visible"
      contentEl.style.pointerEvents = "auto"
      contentEl.style.position = "static"
      contentEl.style.height = "auto"

      contentEl.offsetHeight

      const topBar = 60
      const padding = 16
      const contentHeight = contentEl.scrollHeight

      contentEl.style.visibility = previousVisibility
      contentEl.style.pointerEvents = previousPointerEvents
      contentEl.style.position = previousPosition
      contentEl.style.height = previousHeight

      return topBar + contentHeight + padding
    }

    return 260
  }

  const createTimeline = () => {
    const navEl = navRef.current
    if (!navEl) return null

    gsap.set(navEl, { height: 60, overflow: "hidden" })
    gsap.set(cardsRef.current, { y: 50, opacity: 0 })

    const tl = gsap.timeline({ paused: true })

    tl.to(navEl, {
      height: calculateHeight,
      duration: 0.4,
      ease,
    })

    tl.to(cardsRef.current, { y: 0, opacity: 1, duration: 0.4, ease, stagger: 0.08 }, "-=0.1")

    return tl
  }

  useLayoutEffect(() => {
    const tl = createTimeline()
    tlRef.current = tl

    return () => {
      tl?.kill()
      tlRef.current = null
    }
  }, [ease, items])

  useLayoutEffect(() => {
    const handleResize = () => {
      if (!tlRef.current) return

      if (isExpanded) {
        const newHeight = calculateHeight()
        gsap.set(navRef.current, { height: newHeight })

        tlRef.current.kill()
        const newTl = createTimeline()
        if (newTl) {
          newTl.progress(1)
          tlRef.current = newTl
        }
      } else {
        tlRef.current.kill()
        const newTl = createTimeline()
        if (newTl) {
          tlRef.current = newTl
        }
      }
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [isExpanded])

  const toggleMenu = () => {
    const tl = tlRef.current
    if (!tl) return

    if (!isExpanded) {
      setIsHamburgerOpen(true)
      setIsExpanded(true)
      tl.play(0)
    } else {
      setIsHamburgerOpen(false)
      tl.eventCallback("onReverseComplete", () => setIsExpanded(false))
      tl.reverse()
    }
  }

  const setCardRef = (index: number) => (element: HTMLDivElement | null) => {
    if (element) cardsRef.current[index] = element
  }

  return (
    <div className={`${styles.container} ${className}`} data-theme={theme}>
      <nav
        ref={navRef}
        className={`${styles.nav} ${isExpanded ? styles.open : ""}`}
        style={{ backgroundColor: baseColor }}
      >
        <div className={styles.top}>
          <div
            className={`${styles.hamburger} ${isHamburgerOpen ? styles.hamburgerOpen : ""}`}
            onClick={toggleMenu}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                toggleMenu()
              }
            }}
            role="button"
            aria-label={isExpanded ? "Close menu" : "Open menu"}
            aria-expanded={isExpanded}
            tabIndex={0}
            style={{ color: menuColor || "#000" }}
          >
            <div className={styles.line} />
            <div className={styles.line} />
          </div>

          <div className={styles.logoContainer}>
            <img src={logo} alt={logoAlt} className={styles.logo} />
          </div>

          <button
            type="button"
            className={styles.ctaButton}
            style={{ backgroundColor: buttonBgColor, color: buttonTextColor }}
          >
            Get Started
          </button>
        </div>

        <div ref={contentRef} className={styles.content} aria-hidden={!isExpanded}>
          {(items || []).slice(0, 3).map((item, index) => (
            <div
              key={`${item.label}-${index}`}
              className={styles.card}
              ref={setCardRef(index)}
              style={{ backgroundColor: item.bgColor, color: item.textColor }}
            >
              <div className={styles.cardLabel}>{item.label}</div>
              <div className={styles.links}>
                {item.links?.map((link, linkIndex) => (
                  <a
                    key={`${link.label}-${linkIndex}`}
                    className={styles.link}
                    href={link.href || "#"}
                    aria-label={link.ariaLabel}
                  >
                    <ArrowUpRight className={styles.linkIcon} aria-hidden="true" />
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}

export default CardNav
