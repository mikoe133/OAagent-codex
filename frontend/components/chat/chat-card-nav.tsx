"use client"

import CardNav, { type CardNavItem } from "./card-nav"

const items: CardNavItem[] = [
  {
    label: "About",
    bgColor: "#1B1722",
    textColor: "#fff",
    links: [
      { label: "Company", href: "#company", ariaLabel: "About Company" },
      { label: "Careers", href: "#careers", ariaLabel: "About Careers" },
    ],
  },
  {
    label: "Projects",
    bgColor: "#2F293A",
    textColor: "#fff",
    links: [
      { label: "Featured", href: "#featured", ariaLabel: "Featured Projects" },
      { label: "Case Studies", href: "#case-studies", ariaLabel: "Project Case Studies" },
    ],
  },
  {
    label: "Contact",
    bgColor: "#2F293A",
    textColor: "#fff",
    links: [
      { label: "Email", href: "mailto:hello@example.com", ariaLabel: "Email us" },
      { label: "Twitter", href: "#twitter", ariaLabel: "Twitter" },
      { label: "LinkedIn", href: "#linkedin", ariaLabel: "LinkedIn" },
    ],
  },
]

export function ChatCardNav() {
  return (
    <CardNav
      logo="/logo/logo.png"
      logoAlt="Company Logo"
      items={items}
      baseColor="#fff"
      menuColor="#000"
      buttonBgColor="#111"
      buttonTextColor="#fff"
      ease="power3.out"
      theme="light"
    />
  )
}
