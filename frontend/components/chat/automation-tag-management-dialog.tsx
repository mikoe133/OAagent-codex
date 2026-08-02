"use client"

import * as React from "react"
import { Loader2, Plus, Save, Tag, Trash2 } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  AutomationApiError,
  type AutomationTag,
  createAutomationTag,
  deleteAutomationTag,
  updateAutomationTag,
} from "@/lib/automation-api"

interface AutomationTagManagementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tags: AutomationTag[]
  onTagsChanged: (tags: AutomationTag[]) => void
}

type TagDraft = {
  name: string
  color: string
  description: string
  enabled: boolean
}

export function AutomationTagManagementDialog({
  open,
  onOpenChange,
  tags,
  onTagsChanged,
}: AutomationTagManagementDialogProps) {
  const [drafts, setDrafts] = React.useState<Record<number, TagDraft>>({})
  const [newName, setNewName] = React.useState("")
  const [newColor, setNewColor] = React.useState("")
  const [newDescription, setNewDescription] = React.useState("")
  const [pendingKey, setPendingKey] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      return
    }
    setDrafts(Object.fromEntries(tags.map((tag) => [tag.id, toDraft(tag)])))
    setError(null)
  }, [open, tags])

  function updateDraft(tagId: number, patch: Partial<TagDraft>) {
    setDrafts((current) => ({
      ...current,
      [tagId]: { ...current[tagId], ...patch },
    }))
  }

  async function handleCreate() {
    if (!newName.trim()) {
      return
    }
    setPendingKey("create")
    setError(null)
    try {
      const created = await createAutomationTag({
        name: newName.trim(),
        color: newColor.trim() || null,
        description: newDescription.trim(),
      })
      onTagsChanged([...tags, created].sort(compareTags))
      setNewName("")
      setNewColor("")
      setNewDescription("")
    } catch (failure) {
      setError(resolveTagError(failure))
    } finally {
      setPendingKey(null)
    }
  }

  async function handleSave(tag: AutomationTag) {
    const draft = drafts[tag.id]
    if (!draft?.name.trim()) {
      return
    }
    setPendingKey(`save-${tag.id}`)
    setError(null)
    try {
      const updated = await updateAutomationTag(tag.id, {
        name: draft.name.trim(),
        color: draft.color.trim() || null,
        description: draft.description.trim(),
        enabled: draft.enabled,
      })
      onTagsChanged(tags.map((item) => item.id === tag.id ? updated : item).sort(compareTags))
    } catch (failure) {
      setError(resolveTagError(failure))
    } finally {
      setPendingKey(null)
    }
  }

  async function handleDelete(tag: AutomationTag) {
    if ((tag.job_count ?? 0) > 0) {
      return
    }
    setPendingKey(`delete-${tag.id}`)
    setError(null)
    try {
      await deleteAutomationTag(tag.id)
      onTagsChanged(tags.filter((item) => item.id !== tag.id))
    } catch (failure) {
      setError(resolveTagError(failure))
    } finally {
      setPendingKey(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="automation-tag-management-dialog" className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>标签管理</DialogTitle>
          <DialogDescription>
            标签由 OA 保存。停用后不能再分配给任务；被任务引用的标签不能物理删除。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <section className="rounded-xl border p-4">
          <div className="mb-3 flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <h3 className="text-sm font-medium">新建标签</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="标签名称" maxLength={100} />
            <Input value={newColor} onChange={(event) => setNewColor(event.target.value)} placeholder="#24292f" maxLength={32} />
          </div>
          <div className="mt-3 flex gap-3">
            <Input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="标签说明（可选）" maxLength={500} />
            <Button type="button" onClick={handleCreate} disabled={!newName.trim() || pendingKey !== null}>
              {pendingKey === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              创建
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          {tags.map((tag) => {
            const draft = drafts[tag.id] ?? toDraft(tag)
            const isSaving = pendingKey === `save-${tag.id}`
            const isDeleting = pendingKey === `delete-${tag.id}`
            const inUse = (tag.job_count ?? 0) > 0
            return (
              <article key={tag.id} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Tag className="h-4 w-4" style={{ color: draft.color || undefined }} />
                    <span className="text-sm font-medium">标签 #{tag.id}</span>
                    <Badge variant="outline">{tag.job_count ?? 0} 个任务</Badge>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <span>{draft.enabled ? "已启用" : "已停用"}</span>
                    <Switch checked={draft.enabled} onCheckedChange={(enabled) => updateDraft(tag.id, { enabled })} disabled={pendingKey !== null} />
                  </label>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_8rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor={`tag-name-${tag.id}`}>名称</Label>
                    <Input id={`tag-name-${tag.id}`} value={draft.name} onChange={(event) => updateDraft(tag.id, { name: event.target.value })} maxLength={100} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`tag-color-${tag.id}`}>颜色</Label>
                    <Input id={`tag-color-${tag.id}`} value={draft.color} onChange={(event) => updateDraft(tag.id, { color: event.target.value })} maxLength={32} />
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  <Label htmlFor={`tag-description-${tag.id}`}>说明</Label>
                  <Input id={`tag-description-${tag.id}`} value={draft.description} onChange={(event) => updateDraft(tag.id, { description: event.target.value })} maxLength={500} />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        title={inUse ? "标签仍被任务引用，只能停用，不能删除" : "永久删除未引用标签"}
                        disabled={pendingKey !== null || inUse}
                      >
                        {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        删除
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>永久删除标签“{tag.name}”？</AlertDialogTitle>
                        <AlertDialogDescription>该操作会从 OA 中物理删除未被任务引用的标签，无法恢复。</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleDelete(tag)} className="bg-destructive text-white hover:bg-destructive/90">确认删除</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <Button type="button" onClick={() => void handleSave(tag)} disabled={pendingKey !== null || !draft.name.trim()}>
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存
                  </Button>
                </div>
              </article>
            )
          })}
          {tags.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">暂无标签</p> : null}
        </section>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function toDraft(tag: AutomationTag): TagDraft {
  return {
    name: tag.name,
    color: tag.color ?? "",
    description: tag.description,
    enabled: tag.enabled,
  }
}

function compareTags(left: AutomationTag, right: AutomationTag): number {
  return left.name.localeCompare(right.name, "zh-CN")
}

function resolveTagError(error: unknown): string {
  if (error instanceof AutomationApiError && error.status === 403) {
    return "当前 OA 账号缺少 automation:admin 权限，无法管理标签。"
  }
  return error instanceof Error ? error.message : "标签操作失败"
}
