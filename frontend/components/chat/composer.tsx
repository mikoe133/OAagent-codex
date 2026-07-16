"use client"

import type React from "react"

import { useState, useRef, useCallback, type KeyboardEvent, useEffect } from "react"
import { Mic, MicOff, Paperclip, X, CornerDownLeft, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu"
import Image from "next/image"
import { AudioWaveform } from "./audio-waveform"
import TextType from "@/components/text/TextType"

export const AI_MODELS = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", icon: "/images/gpt.png" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", icon: "/images/gpt.png" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", icon: "/images/gpt.png" },
  { id: "gpt-5.5", name: "GPT-5.5", icon: "/images/gpt.png" },
  { id: "gpt-5.4", name: "GPT-5.4", icon: "/images/gpt.png" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", icon: "/images/gpt.png" },
] as const

export type AIModel = (typeof AI_MODELS)[number]["id"]
export const DEFAULT_AI_MODEL: AIModel = AI_MODELS[0].id

export function isAIModel(value: unknown): value is AIModel {
  return typeof value === "string" && AI_MODELS.some((model) => model.id === value)
}

// Keep the existing implementations available while these composer controls are temporarily disabled.
const SHOW_VOICE_INPUT = false
const SHOW_FILE_UPLOAD = false

interface ComposerProps {
  onSend: (content: string, imageData?: string) => void
  onStop: () => void
  isStreaming: boolean
  disabled?: boolean
  layoutRef?: React.Ref<HTMLDivElement>
  selectedModel: AIModel
  onModelChange: (model: AIModel) => void
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  0?: {
    transcript?: string
  }
}

type SpeechRecognitionEventLike = {
  resultIndex: number
  results: {
    length: number
    [index: number]: SpeechRecognitionResultLike
  }
}

type SpeechRecognitionErrorLike = {
  error?: string
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function appendTranscript(base: string, addition: string): string {
  const normalizedAddition = addition.trim()
  if (!normalizedAddition) {
    return base
  }
  if (!base) {
    return normalizedAddition
  }

  return `${base}${/\s$/.test(base) ? "" : " "}${normalizedAddition}`
}

function getSpeechErrorMessage(error?: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied."
    case "no-speech":
      return "No speech was detected."
    case "audio-capture":
      return "No microphone was found."
    case "network":
      return "Speech recognition network error."
    default:
      return "Voice input failed. Please try again."
  }
}

export function Composer({
  onSend,
  onStop,
  isStreaming,
  disabled,
  layoutRef,
  selectedModel,
  onModelChange,
}: ComposerProps) {
  const [value, setValue] = useState("")
  const [isRecording, setIsRecording] = useState(false)
  const [isSpeechSupported, setIsSpeechSupported] = useState(true)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [uploadedImage, setUploadedImage] = useState<string | null>(null)
  const [showImageBounce, setShowImageBounce] = useState(false)
  const [hasAnimated, setHasAnimated] = useState(false)
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const isRecordingRef = useRef(false)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const baseTextRef = useRef("")
  const finalTranscriptsRef = useRef("")

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [])

  const stopMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
    setMediaStream(null)
  }, [])

  const finishRecording = useCallback(() => {
    isRecordingRef.current = false
    setIsRecording(false)
    stopMediaStream()
  }, [stopMediaStream])

  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (!SpeechRecognition) {
        setIsSpeechSupported(false)
        return
      }

      const recognition = new SpeechRecognition() as SpeechRecognitionLike
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = window.navigator.language || "zh-CN"

      recognition.onresult = (event) => {
        let newFinalText = ""
        let interimText = ""

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const transcript = result?.[0]?.transcript || ""
          if (!transcript) {
            continue
          }

          if (result.isFinal) {
            newFinalText = appendTranscript(newFinalText, transcript)
          } else {
            interimText = appendTranscript(interimText, transcript)
          }
        }

        if (newFinalText) {
          finalTranscriptsRef.current = appendTranscript(finalTranscriptsRef.current, newFinalText)
        }

        const transcript = appendTranscript(finalTranscriptsRef.current, interimText)
        if (transcript) {
          setValue(appendTranscript(baseTextRef.current, transcript))
          window.requestAnimationFrame(handleInput)
        }
      }

      recognition.onerror = (event) => {
        const message = getSpeechErrorMessage(event.error)
        setSpeechError(message)
        console.error("[voice-input] Speech recognition error:", event.error)
        finishRecording()
      }

      recognition.onend = () => {
        finishRecording()
      }

      recognitionRef.current = recognition
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null
        recognitionRef.current.onerror = null
        recognitionRef.current.onend = null
        try {
          recognitionRef.current.abort()
        } catch {
          // Ignore browser-specific abort errors during unmount.
        }
        recognitionRef.current = null
      }
      finishRecording()
    }
  }, [finishRecording, handleInput])

  useEffect(() => {
    // Trigger intro animation after mount
    setHasAnimated(true)
  }, [])

  const playClickSound = useCallback(() => {
    const audio = new Audio("https://hebbkx1anhila5yf.public.blob.vercel-storage.com/click-FM4Xaa1FJj237591TiZw4yL1fIxdOw.mp3")
    audio.volume = 0.5
    audio.play().catch(() => {})
  }, [])

  const playRecordSound = useCallback(() => {
    const audio = new Audio("https://hebbkx1anhila5yf.public.blob.vercel-storage.com/record-CNHOyjcpri6lx5C2sGXncDtFVDwspO.mp3")
    audio.volume = 0.5
    audio.play().catch(() => {})
  }, [])

  const startRecording = useCallback(async () => {
    if (isStreaming || disabled) return

    const recognition = recognitionRef.current
    if (!recognition) {
      setIsSpeechSupported(false)
      setSpeechError("Speech recognition is not supported in this browser.")
      return
    }

    setSpeechError(null)
    baseTextRef.current = value
    finalTranscriptsRef.current = ""

    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        mediaStreamRef.current = stream
        setMediaStream(stream)
      }

      recognition.start()
      isRecordingRef.current = true
      setIsRecording(true)
      playRecordSound()
    } catch (error) {
      finishRecording()
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access was denied."
          : "Unable to start voice input."
      setSpeechError(message)
      console.error("[voice-input] Failed to start recording:", error)
    }
  }, [disabled, finishRecording, isStreaming, playRecordSound, value])

  const stopRecording = useCallback(() => {
    const recognition = recognitionRef.current
    if (recognition && isRecordingRef.current) {
      try {
        recognition.stop()
      } catch (error) {
        console.error("[voice-input] Failed to stop recording:", error)
      }
    }

    finishRecording()
  }, [finishRecording])

  const toggleRecording = useCallback(() => {
    playClickSound()

    if (isRecording) {
      stopRecording()
    } else {
      void startRecording()
    }
  }, [isRecording, playClickSound, startRecording, stopRecording])

  const handleSend = useCallback(() => {
    if ((!value.trim() && !uploadedImage) || isStreaming || disabled) return
    playClickSound()

    if (isRecording) {
      stopRecording()
    }
    onSend(value || "Describe this image", uploadedImage || undefined)
    setValue("")
    setUploadedImage(null)
    setSpeechError(null)
    baseTextRef.current = ""
    finalTranscriptsRef.current = ""
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [value, uploadedImage, isStreaming, disabled, onSend, isRecording, playClickSound, stopRecording])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      playClickSound()

      const file = e.target.files?.[0]
      if (file && file.type.startsWith("image/")) {
        const reader = new FileReader()
        reader.onload = (event) => {
          setUploadedImage(event.target?.result as string)
          setShowImageBounce(true)
          setTimeout(() => setShowImageBounce(false), 400)
        }
        reader.readAsDataURL(file)
      }
      e.target.value = ""
    },
    [playClickSound],
  )

  const removeImage = useCallback(() => {
    setUploadedImage(null)
  }, [])

  const currentModel = AI_MODELS.find((m) => m.id === selectedModel) || AI_MODELS[0]
  const placeholderText = isRecording ? "Listening..." : "Type a message... (Shift+Enter for new line)"
  const hasText = Boolean(value.trim())
  const canSend = Boolean(value.trim() || uploadedImage) && !disabled

  return (
    <div
      ref={layoutRef}
      className={cn("fixed bottom-4 left-0 right-0 px-4 pointer-events-none z-10 sm:left-80", hasAnimated && "composer-intro")}
    >
      <div className="relative max-w-2xl mx-auto pointer-events-auto">
        <div
          className={cn(
            "flex flex-col gap-3 p-4 bg-white border-stone-200 transition-all duration-200 border-none border-0 overflow-hidden relative rounded-3xl",
            "focus-within:border-stone-300 focus-within:ring-2 focus-within:ring-stone-200",
          )}
          style={{
            boxShadow:
              "rgba(14, 63, 126, 0.06) 0px 0px 0px 1px, rgba(42, 51, 69, 0.06) 0px 1px 1px -0.5px, rgba(42, 51, 70, 0.06) 0px 3px 3px -1.5px, rgba(42, 51, 70, 0.06) 0px 6px 6px -3px, rgba(14, 63, 126, 0.06) 0px 12px 12px -6px, rgba(14, 63, 126, 0.06) 0px 24px 24px -12px",
          }}
        >
          <div className="flex gap-2 items-center">
            {uploadedImage && (
              <div className={cn("relative shrink-0", showImageBounce && "image-bounce")}>
                <div className="w-12 h-12 rounded-lg overflow-hidden border border-stone-200">
                  <Image
                    src={uploadedImage || "/placeholder.svg"}
                    alt="Uploaded image"
                    width={48}
                    height={48}
                    className="w-full h-full object-cover"
                  />
                </div>
                <button
                  onClick={removeImage}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-stone-800 hover:bg-stone-900 text-white rounded-full flex items-center justify-center transition-colors"
                  aria-label="Remove image"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            <div className="relative flex-1">
              {!value && (
                <TextType
                  key={placeholderText}
                  as="div"
                  text={placeholderText}
                  pauseDuration={3500}
                  deletingSpeed={40}
                  typingSpeed={45}
                  initialDelay={200}
                  loop={true}
                  showCursor
                  cursorCharacter="|"
                  cursorBlinkDuration={0.6}
                  className={cn(
                    "pointer-events-none absolute left-2 top-1.5 max-w-[calc(100%-1rem)] overflow-hidden text-sm leading-5 text-stone-400",
                    (isStreaming || disabled) && "opacity-50",
                  )}
                  style={{ whiteSpace: "nowrap" }}
                  aria-hidden="true"
                />
              )}
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  handleInput()
                }}
                onKeyDown={handleKeyDown}
                placeholder=""
                disabled={isStreaming || disabled}
                rows={1}
                className={cn(
                  "relative z-10 block w-full resize-none bg-transparent px-2 py-1.5 text-sm text-stone-800",
                  "focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                  "max-h-[56px] overflow-y-auto",
                )}
                aria-label={placeholderText}
              />
            </div>

            {isRecording && (
              <div className="shrink-0 w-24">
                <AudioWaveform isRecording={isRecording} stream={mediaStream} />
              </div>
            )}

            {isStreaming ? (
              <button
                type="button"
                onClick={() => {
                  playClickSound()
                  onStop()
                }}
                className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-300"
                aria-label="Stop generating"
              >
                <span
                  className="flex h-5 w-5 animate-spin items-center justify-center"
                  style={{ animationDuration: "1.1s" }}
                  aria-hidden="true"
                >
                  <span className="h-4 w-4 rotate-45 rounded-[4px] bg-black shadow-sm" />
                </span>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={cn(
                  "relative h-9 w-9 shrink-0 rounded-full flex items-center justify-center bg-[#fafafa] text-[#d3d8dd]",
                  "transition-[color,transform] duration-200",
                  canSend ? "cursor-pointer hover:scale-105" : "cursor-not-allowed",
                  hasText && "text-[#7b8794]",
                )}
                aria-label="Send message"
              >
                <CornerDownLeft className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {SHOW_VOICE_INPUT && (
              <div className="relative">
                <Button
                  onClick={toggleRecording}
                  disabled={isStreaming || disabled || !isSpeechSupported}
                  size="icon"
                  className={cn(
                    "h-9 w-9 shrink-0 transition-all rounded-full relative z-10",
                    isRecording
                      ? "bg-red-500 hover:bg-red-600 text-white animate-bounce-subtle"
                      : "bg-zinc-100 hover:bg-zinc-200 text-stone-700",
                  )}
                  aria-label={
                    isRecording
                      ? "Stop recording"
                      : isSpeechSupported
                        ? "Start voice input"
                        : "Voice input is not supported"
                  }
                >
                  {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </Button>
              </div>
            )}

            {SHOW_FILE_UPLOAD && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                  aria-label="Upload image"
                />
                <Button
                  onClick={() => {
                    playClickSound()
                    fileInputRef.current?.click()
                  }}
                  disabled={isStreaming || disabled}
                  size="icon"
                  className="h-9 w-9 shrink-0 bg-zinc-100 hover:bg-zinc-200 text-stone-700 rounded-full"
                  aria-label="Attach image"
                >
                  <Paperclip className="w-4 h-4" />
                </Button>
              </>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isStreaming || disabled}
                  className="h-9 max-w-full shrink-0 rounded-full bg-zinc-100 px-3 text-xs font-normal text-stone-600 hover:bg-zinc-200 hover:text-stone-800"
                  aria-label="Select AI model"
                  onClick={playClickSound}
                >
                  <span className="truncate">{currentModel.name}</span>
                  <ChevronDown className="h-4 w-4 text-stone-400" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  align="start"
                  side="top"
                  sideOffset={8}
                  className="w-40 px-2 py-2 rounded-2xl z-[9999]"
                >
                  {AI_MODELS.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      onClick={() => {
                        playClickSound()
                        onModelChange(model.id)
                      }}
                      className={cn(
                        "flex items-center cursor-pointer gap-3 rounded-lg",
                        selectedModel === model.id && "bg-stone-100",
                      )}
                    >
                      <Image
                        src={model.icon || "/placeholder.svg"}
                        alt={model.name}
                        width={20}
                        height={20}
                        className="rounded-sm object-contain w-4 h-4"
                      />
                      <span className="text-sm">{model.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>

            {speechError && <span className="min-w-0 truncate text-xs text-red-500">{speechError}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
