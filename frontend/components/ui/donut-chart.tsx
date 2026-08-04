"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"

export interface DonutChartSegment {
  id?: string
  value: number
  color: string
  label: string
  [key: string]: unknown
}

interface DonutChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: DonutChartSegment[]
  totalValue?: number
  size?: number
  strokeWidth?: number
  animationDuration?: number
  animationDelayPerSegment?: number
  highlightOnHover?: boolean
  centerContent?: React.ReactNode
  activeSegmentId?: string | null
  chartLabel?: string
  onSegmentHover?: (segment: DonutChartSegment | null) => void
}

const DonutChart = React.forwardRef<HTMLDivElement, DonutChartProps>(
  (
    {
      data,
      totalValue: providedTotalValue,
      size = 200,
      strokeWidth = 20,
      animationDuration = 0.8,
      animationDelayPerSegment = 0.05,
      highlightOnHover = true,
      centerContent,
      activeSegmentId,
      chartLabel = "环形数据图",
      onSegmentHover,
      className,
      style,
      ...props
    },
    ref,
  ) => {
    const shouldReduceMotion = useReducedMotion()
    const [internalActiveId, setInternalActiveId] = React.useState<string | null>(null)
    const activeId = activeSegmentId === undefined ? internalActiveId : activeSegmentId
    const normalizedData = React.useMemo(
      () => data.filter((segment) => Number.isFinite(segment.value) && segment.value > 0),
      [data],
    )
    const segmentTotal = React.useMemo(
      () => normalizedData.reduce((sum, segment) => sum + segment.value, 0),
      [normalizedData],
    )
    const totalValue = Math.max(
      segmentTotal,
      Number.isFinite(providedTotalValue) ? providedTotalValue ?? 0 : 0,
    )
    const safeStrokeWidth = Math.min(Math.max(strokeWidth, 1), size / 2)
    const radius = size / 2 - safeStrokeWidth / 2
    const circumference = 2 * Math.PI * radius
    let cumulativePercentage = 0

    const setActiveSegment = React.useCallback((segment: DonutChartSegment | null) => {
      setInternalActiveId(segment ? segment.id ?? segment.label : null)
      onSegmentHover?.(segment)
    }, [onSegmentHover])

    return (
      <div
        ref={ref}
        className={cn("relative flex shrink-0 items-center justify-center", className)}
        style={{ width: size, height: size, ...style }}
        onMouseLeave={() => setActiveSegment(null)}
        {...props}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90 overflow-visible"
          role="img"
          aria-label={chartLabel}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="var(--border)"
            strokeWidth={safeStrokeWidth}
            opacity={0.7}
          />

          {normalizedData.map((segment, index) => {
            const segmentId = segment.id ?? segment.label
            const percentage = totalValue === 0 ? 0 : segment.value / totalValue * 100
            const dashLength = percentage / 100 * circumference
            const strokeDasharray = `${dashLength} ${circumference}`
            const strokeDashoffset = cumulativePercentage / 100 * circumference
            const isActive = activeId === segmentId
            cumulativePercentage += percentage

            return (
              <motion.circle
                key={segmentId}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="transparent"
                stroke={segment.color}
                strokeWidth={isActive && highlightOnHover ? safeStrokeWidth + 3 : safeStrokeWidth}
                strokeDasharray={strokeDasharray}
                strokeDashoffset={-strokeDashoffset}
                strokeLinecap="round"
                initial={shouldReduceMotion ? false : { opacity: 0, strokeDashoffset: circumference }}
                animate={{ opacity: 1, strokeDashoffset: -strokeDashoffset }}
                transition={
                  shouldReduceMotion
                    ? { duration: 0 }
                    : {
                        opacity: { duration: 0.2, delay: index * animationDelayPerSegment },
                        strokeDashoffset: {
                          duration: animationDuration,
                          delay: index * animationDelayPerSegment,
                          ease: "easeOut",
                        },
                        strokeWidth: { duration: 0.16 },
                      }
                }
                className={cn(
                  "origin-center outline-none",
                  highlightOnHover && "cursor-pointer",
                )}
                style={{
                  filter: isActive && highlightOnHover
                    ? `drop-shadow(0 0 4px ${segment.color}) brightness(1.05)`
                    : "none",
                  transition: "filter 160ms ease-out",
                }}
                aria-label={`${segment.label}：${segment.value}`}
                onMouseEnter={() => setActiveSegment(segment)}
              />
            )
          })}
        </svg>

        {centerContent ? (
          <div
            className="pointer-events-none absolute flex flex-col items-center justify-center"
            style={{
              width: Math.max(0, size - safeStrokeWidth * 2.5),
              height: Math.max(0, size - safeStrokeWidth * 2.5),
            }}
          >
            {centerContent}
          </div>
        ) : null}
      </div>
    )
  },
)

DonutChart.displayName = "DonutChart"

export { DonutChart }
