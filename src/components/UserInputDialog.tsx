import { useEffect, useMemo, useState } from "react"
import { Check, ChevronLeft, ChevronRight, CircleHelp, XCircle } from "lucide-react"
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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  buildAskUserQuestionResponse,
  collectAskUserQuestionAnswers,
  initialAskUserQuestionDraft,
  isAskUserQuestionAnswerComplete,
  parseAskUserQuestionInput,
  updateAskUserQuestionCustomAnswer,
  updateAskUserQuestionSelection,
  type AskUserQuestionDraftAnswers
} from "@/lib/askUserQuestion"
import { resolvePermissionRequest, type PermissionRequestPayload } from "@/lib/ipc"
import { cn } from "@/lib/utils"

interface Props {
  request: PermissionRequestPayload | null
  onSettled: (requestId: string) => void
}

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
  const [draft, setDraft] = useState<AskUserQuestionDraftAnswers>({})
  const [page, setPage] = useState(0)
  const [direction, setDirection] = useState<"forward" | "back">("forward")

  useEffect(() => {
    setBusy(false)
    setPage(0)
    setDirection("forward")
    setDraft(parsed.input ? initialAskUserQuestionDraft(parsed.input) : {})
  }, [request?.request_id, parsed.input])

  const questions = parsed.input?.questions ?? []
  const total = questions.length
  const safePage = total > 0 ? Math.min(page, total - 1) : 0
  const currentQuestion = questions[safePage]
  const isLast = total === 0 || safePage >= total - 1
  const canPrev = safePage > 0

  const answers = parsed.input
    ? collectAskUserQuestionAnswers(parsed.input, draft)
    : null
  const canSubmit = !!request && !!parsed.input && !!answers && !busy
  const unanswered = questions.filter(
    (question, index) => !isAskUserQuestionAnswerComplete(question, draft[index])
  ).length

  const goTo = (target: number) => {
    if (busy || total === 0) return
    const next = Math.max(0, Math.min(target, total - 1))
    if (next === safePage) return
    setDirection(next > safePage ? "forward" : "back")
    setPage(next)
  }

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
      <DialogContent
        className="grid max-h-[85vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="flex items-center gap-2">
            <CircleHelp className="size-5 text-primary" />
            需要确认方向
          </DialogTitle>
          <DialogDescription>
            Claude 在继续计划前请求结构化输入。
            {total > 1 && (
              <span className="ml-1">
                共 {total} 个问题，当前第 {safePage + 1} 个
                {unanswered > 0 && `，还有 ${unanswered} 个待回答`}。
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 overflow-hidden">
          <div className="space-y-4 pr-3 text-sm">
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

            {currentQuestion && (
              <section
                key={safePage}
                className={cn(
                  "space-y-2 rounded-md border bg-muted/20 p-3",
                  "animate-in fade-in-0 duration-200",
                  direction === "forward"
                    ? "slide-in-from-right-4"
                    : "slide-in-from-left-4"
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-background px-2 py-0.5 text-xs font-medium">
                    {currentQuestion.header}
                  </span>
                  {currentQuestion.multiSelect && (
                    <span className="text-xs text-muted-foreground">可多选</span>
                  )}
                  {total > 1 && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {safePage + 1} / {total}
                    </span>
                  )}
                </div>
                <div className="font-medium leading-relaxed">
                  {currentQuestion.question}
                </div>
                <div className="grid gap-2">
                  {currentQuestion.options.map((option, optionIndex) => {
                    const current = draft[safePage] ?? { selected: [], custom: "" }
                    const selected = current.selected.includes(option.label)
                    return (
                      <button
                        key={`${option.label}:${optionIndex}`}
                        type="button"
                        aria-pressed={selected}
                        disabled={busy}
                        onClick={() =>
                          setDraft((cur) =>
                            updateAskUserQuestionSelection(
                              cur,
                              safePage,
                              option.label,
                              currentQuestion.multiSelect
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
                            {option.description && (
                              <span className="block text-xs leading-relaxed text-muted-foreground">
                                {option.description}
                              </span>
                            )}
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
                  value={draft[safePage]?.custom ?? ""}
                  disabled={busy}
                  placeholder="自定义回答"
                  className="min-h-20 resize-none text-sm field-sizing-content"
                  onChange={(event) =>
                    setDraft((cur) =>
                      updateAskUserQuestionCustomAnswer(
                        cur,
                        safePage,
                        event.target.value,
                        currentQuestion.multiSelect
                      )
                    )
                  }
                />
              </section>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 flex-wrap items-center gap-2 sm:justify-between">
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
            <div className="flex items-center gap-2">
              {total > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => goTo(safePage - 1)}
                  disabled={busy || !canPrev}
                >
                  <ChevronLeft />
                  上一页
                </Button>
              )}

              {total > 1 && (
                <div className="flex items-center gap-1.5 px-1">
                  {questions.map((question, index) => {
                    const complete = isAskUserQuestionAnswerComplete(
                      question,
                      draft[index]
                    )
                    const active = index === safePage
                    return (
                      <button
                        key={index}
                        type="button"
                        disabled={busy}
                        aria-label={`跳转到第 ${index + 1} 个问题`}
                        aria-current={active}
                        onClick={() => goTo(index)}
                        className={cn(
                          "h-2.5 rounded-full transition-all disabled:pointer-events-none",
                          active ? "w-5" : "w-2.5",
                          active
                            ? "bg-primary"
                            : complete
                              ? "bg-primary/50 hover:bg-primary/70"
                              : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                        )}
                      />
                    )
                  })}
                </div>
              )}

              {isLast ? (
                <Button type="button" onClick={submit} disabled={!canSubmit}>
                  <Check />
                  提交选择
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  onClick={() => goTo(safePage + 1)}
                  disabled={busy}
                >
                  下一页
                  <ChevronRight />
                </Button>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
