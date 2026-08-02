export type AutomationScheduleFrequency =
  | "daily"
  | "weekdays"
  | "weekly-1"
  | "weekly-2"
  | "weekly-3"
  | "weekly-4"
  | "weekly-5"
  | "weekly-6"
  | "weekly-0"
  | "preserve-existing"

export const AUTOMATION_SCHEDULE_FREQUENCY_OPTIONS: Array<{
  value: Exclude<AutomationScheduleFrequency, "preserve-existing">
  label: string
}> = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "每个工作日" },
  { value: "weekly-1", label: "每周一" },
  { value: "weekly-2", label: "每周二" },
  { value: "weekly-3", label: "每周三" },
  { value: "weekly-4", label: "每周四" },
  { value: "weekly-5", label: "每周五" },
  { value: "weekly-6", label: "每周六" },
  { value: "weekly-0", label: "每周日" },
]

export type ReadableAutomationSchedule = {
  frequency: AutomationScheduleFrequency
  executionTime: string
}

const DEFAULT_CRON_EXPRESSION = "0 20 * * 1-5"
const DEFAULT_EXECUTION_TIME = "20:00"

export function parseAutomationSchedule(cronExpression: string): ReadableAutomationSchedule {
  const fields = cronExpression.trim().split(/\s+/)
  if (fields.length !== 5) {
    return { frequency: "preserve-existing", executionTime: DEFAULT_EXECUTION_TIME }
  }

  const [minuteText, hourText, dayOfMonth, month, dayOfWeek] = fields
  const minute = Number(minuteText)
  const hour = Number(hourText)
  const validTime = Number.isInteger(minute) && minute >= 0 && minute <= 59 &&
    Number.isInteger(hour) && hour >= 0 && hour <= 23
  const executionTime = validTime
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : DEFAULT_EXECUTION_TIME

  if (!validTime || dayOfMonth !== "*" || month !== "*") {
    return { frequency: "preserve-existing", executionTime }
  }
  if (dayOfWeek === "*") {
    return { frequency: "daily", executionTime }
  }
  if (dayOfWeek === "1-5") {
    return { frequency: "weekdays", executionTime }
  }
  if (/^[0-6]$/.test(dayOfWeek)) {
    return {
      frequency: `weekly-${dayOfWeek}` as AutomationScheduleFrequency,
      executionTime,
    }
  }
  return { frequency: "preserve-existing", executionTime }
}

export function buildAutomationCronExpression(
  frequency: AutomationScheduleFrequency,
  executionTime: string,
  existingCronExpression = DEFAULT_CRON_EXPRESSION,
): string {
  if (frequency === "preserve-existing") {
    return existingCronExpression.trim() || DEFAULT_CRON_EXPRESSION
  }

  const timeMatch = executionTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!timeMatch) {
    throw new Error("请选择有效的执行时间。")
  }
  const [, hour, minute] = timeMatch
  const dayOfWeek = frequency === "daily"
    ? "*"
    : frequency === "weekdays"
      ? "1-5"
      : frequency.slice("weekly-".length)
  return `${Number(minute)} ${Number(hour)} * * ${dayOfWeek}`
}

export function describeAutomationSchedule(
  cronExpression: string,
  scheduleDescription?: string | null,
): string {
  const providedDescription = scheduleDescription?.trim()
  if (providedDescription) {
    return providedDescription
  }
  const schedule = parseAutomationSchedule(cronExpression)
  if (schedule.frequency === "preserve-existing") {
    return "保持当前执行安排"
  }
  const label = AUTOMATION_SCHEDULE_FREQUENCY_OPTIONS.find(
    (option) => option.value === schedule.frequency,
  )?.label
  return `${label ?? "定期"} ${schedule.executionTime}`
}
