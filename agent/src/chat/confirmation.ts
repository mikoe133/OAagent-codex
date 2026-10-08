import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const confirmationRequestSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(2000),
  actions: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  confirmationReply: z.string().trim().min(1).max(500).optional(),
}).strict();
export const confirmationSchema = confirmationRequestSchema.extend({
  id: z.string().uuid(),
  expiresAt: z.string().datetime(),
}).strict();
export const confirmationResponseSchema = z.object({
  id: z.string().uuid(), decision: z.enum(['approve', 'decline']),
}).strict();
export type ChatConfirmation = z.infer<typeof confirmationSchema>;
export type ConfirmationResponse = z.infer<typeof confirmationResponseSchema>;
export type ConfirmationDecision = { confirmation: ChatConfirmation; decision: ConfirmationResponse['decision'] };
export const pendingConfirmationSchema = z.object({ userId: z.string().min(1), confirmation: confirmationSchema }).strict();

const signingKey = randomBytes(32);
export function confirmationToolToken(secret: string, sessionId: string) {
  return createHmac('sha256', signingKey).update(secret).update(`\0chat-confirmation:${sessionId}`).digest('hex');
}
export function createChatConfirmation(input: unknown): ChatConfirmation {
  return { ...confirmationRequestSchema.parse(input), id: randomUUID(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
}
