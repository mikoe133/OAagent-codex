export type ChatAttachment = { id: string; recordId: string; name: string; mime: string; size: number; createdAt: string }
export const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.txt,.md,.csv,.json,.log,.zip'
export function modelSupportsImages(provider: string, model: string) {
  return provider === 'openrouter' && ['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902'].includes(model)
}
export function attachmentUrl(file: ChatAttachment) {
  return `/api/chat/attachments?recordId=${encodeURIComponent(file.recordId)}&id=${encodeURIComponent(file.id)}`
}
export function validAttachments(value: unknown): ChatAttachment[] {
  return Array.isArray(value) ? value.filter((file): file is ChatAttachment => file &&
    typeof file.id === 'string' && /^[a-f0-9-]{36}$/.test(file.id) &&
    typeof file.recordId === 'string' && /^[1-9]\d*$/.test(file.recordId) &&
    typeof file.name === 'string' && typeof file.mime === 'string' && typeof file.size === 'number').slice(0, 5) : []
}
export function validateAttachmentFiles(files: File[]): string | null {
  if (files.length > 5) return '每条消息最多选择 5 个附件'
  for (const file of files) {
    const extension = `.${file.name.split('.').pop()?.toLowerCase()}`
    if (!ATTACHMENT_ACCEPT.split(',').includes(extension)) return `不支持 ${file.name} 的文件类型`
    const image = /\.(png|jpe?g|gif|webp)$/i.test(file.name)
    if (!file.size || file.size > (image ? 10 : 50) * 1024 * 1024) return `${file.name}：图片限 10 MB，文件限 50 MB，不能选择空文件`
  }
  return null
}
type AttachmentMode = 'auto' | 'analyze' | 'upload'
import { isModelProvider, isModelForProvider, type AIModel, type ModelProvider } from './model-catalog'
export type AttachmentSendOptions = { mode: AttachmentMode; target?: string; modelOverride?: { provider: ModelProvider; model: AIModel } }
export function validAttachmentOptions(value: unknown): AttachmentSendOptions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, any>
  if (!['auto', 'analyze', 'upload'].includes(item.mode)) return undefined
  const selection = item.modelOverride
  return { mode: item.mode,
    ...(typeof item.target === 'string' && item.target.length <= 300 ? { target: item.target } : {}),
    ...(selection && isModelProvider(selection.provider) && isModelForProvider(selection.provider, selection.model) ? { modelOverride: selection } : {}) }
}
