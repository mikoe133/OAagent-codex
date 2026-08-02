"use client"

import * as React from "react"
import { ArrowRight, ExternalLink, HelpCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface WelcomeModalProps extends React.ComponentPropsWithoutRef<typeof Dialog> {
  title: React.ReactNode
  description: string
  mainActionText: string
  onMainActionClick: () => void
  mainActionIcon?: React.ReactNode
  mainActionDisabled?: boolean
  showDontShowAgain?: boolean
  showHelp?: boolean
  helpLink?: string
  helpTitle?: string
  helpDescription?: string
  helpActionText?: string
}

function WelcomeModal({
  title,
  description,
  mainActionText,
  onMainActionClick,
  mainActionIcon = <ExternalLink className="ml-2 h-4 w-4" />,
  mainActionDisabled = false,
  showDontShowAgain = true,
  showHelp = true,
  helpLink = "#",
  helpTitle = "Need help accessing your account?",
  helpDescription =
    "If you're experiencing any login issues, reach out directly for immediate assistance.",
  helpActionText = "Get login assistance",
  children,
  ...props
}: WelcomeModalProps) {
  return (
    <Dialog {...props}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-full gap-0 overflow-y-auto rounded-2xl border-none bg-background p-0 shadow-2xl sm:max-w-xl">
        <div className="p-6 pb-0 sm:p-8 sm:pb-0">
          <DialogHeader>
            <DialogTitle className="flex items-center text-xl font-bold text-foreground sm:text-2xl">
              {title}
            </DialogTitle>
            <DialogDescription className="pt-1 text-base text-muted-foreground">
              {description}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-6 text-foreground">{children}</div>
        </div>

        <div className="space-y-6 px-6 pb-6 sm:px-8 sm:pb-8">
          {showHelp ? (
            <div className="flex items-start space-x-3 rounded-lg bg-muted/50 p-4">
              <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-semibold">{helpTitle}</p>
                <p className="text-sm text-muted-foreground">{helpDescription}</p>
                <Button asChild variant="link" className="mt-2 h-auto p-0 text-sm font-semibold">
                  <a href={helpLink}>
                    {helpActionText}
                    <ArrowRight className="ml-1 h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex w-full flex-col-reverse gap-4 sm:flex-row sm:items-center sm:gap-2">
            {showDontShowAgain ? (
              <div className="flex items-center space-x-2">
                <Checkbox id="dont-show-again" className="rounded-[4px]" />
                <label
                  htmlFor="dont-show-again"
                  className="text-sm font-medium leading-none text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Don&apos;t show again
                </label>
              </div>
            ) : null}
            <div className="sm:flex-grow" />
            <Button
              type="button"
              size="lg"
              onClick={onMainActionClick}
              disabled={mainActionDisabled}
              className="w-full font-semibold sm:w-auto"
            >
              {mainActionText}
              {mainActionIcon}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

WelcomeModal.displayName = "WelcomeModal"

export { WelcomeModal }
