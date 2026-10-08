"use client"
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ChatConfirmation, ConfirmationResponse } from '@/lib/chat-confirmation'

export function ConfirmationCard({ confirmation, disabled, onRespond }: {
  confirmation: ChatConfirmation
  disabled?: boolean
  onRespond: (response: ConfirmationResponse) => Promise<void | boolean>
}) {
  const [sending, setSending] = useState<ConfirmationResponse['decision'] | null>(null)
  const [expired, setExpired] = useState(() => Date.parse(confirmation.expiresAt) <= Date.now())
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    const remaining = Date.parse(confirmation.expiresAt) - Date.now()
    setExpired(remaining <= 0)
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [confirmation.id, confirmation.expiresAt])
  async function respond(decision: ConfirmationResponse['decision']) {
    if (lock.current || disabled || expired) return
    lock.current = true
    setSending(decision)
    setError(null)
    try {
      if (await onRespond({ id: confirmation.id, decision }) === false) setError('暂时无法提交确认，请稍后重试。')
    } catch {
      setError('提交确认失败，请重试。')
    }
    finally { lock.current = false; setSending(null) }
  }
  return <section role="region" aria-label="操作确认" data-slot="chat-confirmation"
    className="mb-3 flex max-h-[35dvh] flex-col rounded-2xl border border-sky-100 bg-white p-4 shadow-sm theme-dark:border-sky-900/60 theme-dark:bg-zinc-900">
    <div className="flex min-h-0 items-start gap-3 overflow-y-auto">
      <div className="rounded-xl bg-sky-50 p-2 text-sky-600 theme-dark:bg-sky-950 theme-dark:text-sky-300"><ShieldCheck className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-sky-600 theme-dark:text-sky-300">{expired ? '确认已过期' : '等待你的确认'}</p>
        <h3 className="mt-1 break-words text-base font-semibold text-stone-800 theme-dark:text-zinc-100">{confirmation.title}</h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-stone-600 theme-dark:text-zinc-300">{confirmation.description}</p>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-stone-600 theme-dark:text-zinc-300">
          {confirmation.actions.map((action, index) => <li key={index} className="break-words pl-1">{action}</li>)}
        </ol>
      </div>
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-red-600 theme-dark:text-red-400">{error}</p>}
    <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2">
      {expired && <p role="status" className="mr-auto text-xs text-stone-500">请重新提出操作请求。</p>}
      <Button type="button" variant="ghost" disabled={disabled || !!sending || expired} onClick={() => void respond('decline')}>取消</Button>
      <Button type="button" disabled={disabled || !!sending || expired} className="gap-2 rounded-xl bg-sky-600 text-white hover:bg-sky-700" onClick={() => void respond('approve')}>
        {sending === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}确认执行
      </Button>
    </div>
  </section>
}
