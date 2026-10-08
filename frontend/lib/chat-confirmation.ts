import { z } from 'zod'

const confirmationSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(2000),
  actions: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  expiresAt: z.string().datetime(), confirmationReply: z.string().max(500).optional(),
})
const responseSchema = z.object({ id: z.string().uuid(), decision: z.enum(['approve', 'decline']) }).strict()
export type ChatConfirmation = z.infer<typeof confirmationSchema>
export type ConfirmationResponse = z.infer<typeof responseSchema>
export function validConfirmation(value: unknown): ChatConfirmation | undefined {
  const result = confirmationSchema.safeParse(value)
  return result.success ? result.data : undefined
}
export function validConfirmationResponse(value: unknown): ConfirmationResponse | undefined {
  const result = responseSchema.safeParse(value)
  return result.success ? result.data : undefined
}
export function pendingChatConfirmation(messages: Array<{ role: string; confirmation?: ChatConfirmation }>): ChatConfirmation | undefined {
  const last = messages.at(-1)
  return last?.role === 'assistant' ? last.confirmation : undefined
}
