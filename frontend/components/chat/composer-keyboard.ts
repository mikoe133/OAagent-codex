export type ComposerKeyDownInput = {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}

export function shouldSubmitComposerOnKeyDown(input: ComposerKeyDownInput): boolean {
  return (
    input.key === "Enter" &&
    !input.shiftKey &&
    !input.isComposing &&
    input.keyCode !== 229
  )
}
