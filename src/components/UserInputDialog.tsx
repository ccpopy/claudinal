import { useEffect, useMemo, useState } from "react"
import { Check, CircleHelp, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import {
  buildAskUserQuestionResponse,
  parseAskUserQuestionInput,
  type AskUserQuestionAnswers,
  type AskUserQuestionInput
} from "@/lib/askUserQuestion"
import { resolvePermissionRequest, type PermissionRequestPayload } from "@/lib/ipc"
import { cn } from "@/lib/utils"

interface Props {
  request: PermissionRequestPayload | null
  onSettled: (requestId: string) => void
}

interface DraftAnswer {
  selected: string[]
  custom: string
}

type DraftAnswers = Record<number, DraftAnswer>

export function UserInputDialog({ request, onSettled }: Props) {
  const [busy, setBusy] = useState(false)
  const parsed = useMemo(() => {
    if (!request) return { input: null, error: null }
    try {
      return {
        input: parseAskUserQuestionInput(request.request.input),
        error: null
      }
    } catch (error) {
      return {
        input: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }, [request])
  const [draft, setDraft] = useState<DraftAnswers>({})

  useEffect(() => {
    setBusy(false)
    setDraft(parsed.input ? initialDraft(parsed.input) : {})
  }, [request?.request_id, parsed.input])

  const answers = parsed.input ? collectAnswers(parsed.input, draft) : null
  const canSubmit = !!request && !!parsed.input && !!answers && !busy

  const settle = async (response: Record<string, unknown>) => {
    if (!request || busy) return
    setBusy(true)
    try {
      await resolvePermissionRequest({
        sessionId: request.session_id,
        requestId: request.request_id,
        transport: request.transport ?? null,
        response
      })
      onSettled(request.request_id)
    } catch (error) {
      toast.error(`用户输入响应失败: ${String(error)}`)
      setBusy(false)
    }
  }

  const decline = () =>
    settle({
      behavior: "deny",
      message: "用户取消了这次澄清问题，请根据已有上下文继续或重新提问。"
    })

  const submit = () => {
    if (!parsed.input || !answers) return
    settle(buildAskUserQuestionResponse(parsed.input, answers))
  }

  const returnSchemaError = () => {
    settle({
      behavior: "deny",
      message: `AskUserQuestion 请求格式无效: ${parsed.error ?? "未知错误"}`
    })
  }

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open && request && !busy) decline()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="flex items-center gap-2">
            <CircleHelp className="size-5 text-primary" />
            需要确认方向
          </DialogTitle>
          <DialogDescription>
            Claude 在继续计划前请求结构化输入。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1 text-sm scrollbar-thin">
          {request && (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-1">来源</div>
              <div className="space-y-1 font-mono text-xs">
                <div className="break-all">session: {request.session_id}</div>
                {request.cwd && <div className="break-all">cwd: {request.cwd}</div>}
              </div>
            </div>
          )}

          {parsed.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
              {parsed.error}
            </div>
          )}

          {parsed.input?.questions.map((question, questionIndex) => {
            const current = draft[questionIndex] ?? { selected: [], custom: "" }
            return (
              <section
                key={`${question.header}:${question.question}`}
                className="space-y-2 rounded-md border bg-muted/20 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-background px-2 py-0.5 text-xs font-medium">
                    {question.header}
                  </span>
                  {question.multiSelect && (
                    <span className="text-xs text-muted-foreground">可多选</span>
                  )}
                </div>
                <div className="font-medium leading-relaxed">{question.question}</div>
                <div className="grid gap-2">
                  {question.options.map((option, optionIndex) => {
                    const selected = current.selected.includes(option.label)
                    return (
                      <button
                        key={`${option.label}:${optionIndex}`}
                        type="button"
                        aria-pressed={selected}
                        disabled={busy}
                        onClick={() =>
                          setDraft((cur) =>
                            updateSelection(
                              cur,
                              questionIndex,
                              option.label,
                              question.multiSelect
                            )
                          )
                        }
                        className={cn(
                          "rounded-md border bg-background px-3 py-2 text-left transition-colors",
                          "hover:border-primary/60 hover:bg-accent disabled:pointer-events-none disabled:opacity-60",
                          selected && "border-primary bg-primary/10"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded border",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/40"
                            )}
                          >
                            {selected && <Check className="size-3" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block font-medium">{option.label}</span>
                            <span className="block text-xs leading-relaxed text-muted-foreground">
                              {option.description}
                            </span>
                            {option.preview && (
                              <span className="mt-2 block whitespace-pre-wrap rounded border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
                                {option.preview}
                              </span>
                            )}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <Textarea
                  value={current.custom}
                  disabled={busy}
                  placeholder="自定义回答"
                  className="min-h-20 resize-none text-sm"
                  onChange={(event) =>
                    setDraft((cur) =>
                      updateCustomAnswer(cur, questionIndex, event.target.value)
                    )
                  }
                />
              </section>
            )
          })}
        </div>

        <DialogFooter className="shrink-0 flex-wrap sm:justify-between">
          <Button
            type="button"
            variant="destructive"
            onClick={decline}
            disabled={!request || busy}
          >
            <XCircle />
            取消
          </Button>
          {parsed.error ? (
            <Button
              type="button"
              onClick={returnSchemaError}
              disabled={!request || busy}
            >
              返回格式错误
            </Button>
          ) : (
            <Button type="button" onClick={submit} disabled={!canSubmit}>
              <Check />
              提交选择
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function initialDraft(input: AskUserQuestionInput): DraftAnswers {
  return Object.fromEntries(
    input.questions.map((_, index) => [index, { selected: [], custom: "" }])
  )
}

function updateSelection(
  draft: DraftAnswers,
  questionIndex: number,
  label: string,
  multiSelect: boolean
): DraftAnswers {
  const current = draft[questionIndex] ?? { selected: [], custom: "" }
  const selected = multiSelect
    ? current.selected.includes(label)
      ? current.selected.filter((item) => item !== label)
      : [...current.selected, label]
    : [label]
  return {
    ...draft,
    [questionIndex]: { ...current, selected }
  }
}

function updateCustomAnswer(
  draft: DraftAnswers,
  questionIndex: number,
  custom: string
): DraftAnswers {
  const current = draft[questionIndex] ?? { selected: [], custom: "" }
  return {
    ...draft,
    [questionIndex]: { ...current, custom }
  }
}

function collectAnswers(
  input: AskUserQuestionInput,
  draft: DraftAnswers
): AskUserQuestionAnswers | null {
  const answers: AskUserQuestionAnswers = {}
  for (let index = 0; index < input.questions.length; index += 1) {
    const question = input.questions[index]
    const current = draft[index] ?? { selected: [], custom: "" }
    const custom = current.custom.trim()
    if (question.multiSelect) {
      const selected = custom ? [...current.selected, custom] : current.selected
      if (selected.length === 0) return null
      answers[question.question] = selected
      continue
    }
    if (custom) {
      answers[question.question] = custom
      continue
    }
    if (current.selected.length !== 1) return null
    answers[question.question] = current.selected[0]
  }
  return answers
}
