import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { Identifier } from "@/utils/id"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { persisted, Persist } from "@/utils/persist"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { showToast } from "@opencode-ai/ui/toast"
import { StatusPopover } from "@/components/status-popover"
import { TeamIcon, statusColor as pipelineStatusColor, type PipelineInstance, type Team } from "@/components/pipeline-row"
import { OrchestratorFlow } from "@/components/orchestrator-flow"
import { decode64 } from "@/utils/base64"

type SortMode = "recent"

type DashboardPrefs = {
  sortBy: SortMode
  showArchived: boolean
}

type Attention = {
  permission: boolean
  question: boolean
  retry: boolean
  error: boolean
}

function statusLabel(type: string) {
  if (type === "busy") return "running"
  if (type === "retry") return "retrying"
  return type
}

function statusColor(type: string, hasAttention: boolean) {
  if (hasAttention) return "var(--color-status-warning, #E9C46A)"
  if (type === "busy") return "var(--color-status-success, #2A9D8F)"
  if (type === "retry") return "var(--color-status-warning, #E9C46A)"
  if (type === "error") return "var(--color-status-error, #E76F51)"
  return "var(--color-text-weak)"
}

function formatRelative(ts?: number) {
  if (!ts) return ""
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ── Open-in-app constants (mirrored from session-header) ────────────────────
type OpenApp = "vscode" | "cursor" | "zed" | "textmate" | "antigravity" | "finder" | "terminal" | "iterm2" | "ghostty" | "warp" | "xcode" | "android-studio" | "powershell" | "sublime-text"

const MAC_APPS: readonly { id: OpenApp; label: string; icon: string; openWith: string }[] = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "Visual Studio Code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  { id: "antigravity", label: "session.header.open.app.antigravity", icon: "antigravity", openWith: "Antigravity" },
  { id: "terminal", label: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  { id: "android-studio", label: "session.header.open.app.androidStudio", icon: "android-studio", openWith: "Android Studio" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", icon: "sublime-text", openWith: "Sublime Text" },
]
const WINDOWS_APPS: readonly { id: OpenApp; label: string; icon: string; openWith: string }[] = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  { id: "powershell", label: "session.header.open.app.powershell", icon: "powershell", openWith: "powershell" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", icon: "sublime-text", openWith: "Sublime Text" },
]
const LINUX_APPS: readonly { id: OpenApp; label: string; icon: string; openWith: string }[] = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", icon: "sublime-text", openWith: "Sublime Text" },
]

const detectOS = (platform: ReturnType<typeof usePlatform>) => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown" as const
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos" as const
  if (/Win/i.test(value)) return "windows" as const
  if (/Linux/i.test(value)) return "linux" as const
  return "unknown" as const
}

/** Renders open-in-app, status, terminal, review and file-tree buttons into `opencode-titlebar-right`. */
function DashboardTitlebarButtons() {
  const platform = usePlatform()
  const language = useLanguage()
  const server = useServer()
  const layout = useLayout()
  const command = useCommand()
  const params = useParams()

  const dashView = layout.view("__dashboard__")

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const os = createMemo(() => detectOS(platform))
  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({ finder: true })

  const apps = createMemo(() => {
    if (os() === "macos") return MAC_APPS
    if (os() === "windows") return WINDOWS_APPS
    return LINUX_APPS
  })

  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
    if (os() === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
    return { label: "session.header.open.fileManager", icon: "finder" as const }
  })

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return
    const list = apps()
    setExists(Object.fromEntries(list.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)
    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((v) => Boolean(v))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>))
  })

  const options = createMemo(() => [
    { id: "finder" as OpenApp, label: language.t(fileManager().label), icon: fileManager().icon },
    ...apps()
      .filter((app) => exists[app.id])
      .map((app) => ({ ...app, label: language.t(app.label) })),
  ])

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [menu, setMenu] = createStore({ open: false })
  const [openRequest, setOpenRequest] = createStore({ app: undefined as OpenApp | undefined })

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const current = createMemo(
    () =>
      options().find((o) => o.id === prefs.app) ??
      options()[0] ??
      ({ id: "finder" as OpenApp, label: fileManager().label, icon: fileManager().icon }),
  )
  const opening = createMemo(() => openRequest.app !== undefined)

  const selectApp = (app: OpenApp) => {
    if (!options().some((item) => item.id === app)) return
    setPrefs("app", app)
  }

  const openDir = (app: OpenApp) => {
    if (opening() || !canOpen() || !platform.openPath) return
    const directory = projectDirectory()
    if (!directory) return
    const item = options().find((o) => o.id === app)
    const openWith = item && "openWith" in item ? (item as { openWith: string }).openWith : undefined
    setOpenRequest("app", app)
    platform
      .openPath(directory, openWith)
      .catch((err: unknown) =>
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setOpenRequest("app", undefined))
  }

  const copyPath = () => {
    const directory = projectDirectory()
    if (!directory) return
    navigator.clipboard
      .writeText(directory)
      .then(() => showToast({ variant: "success", icon: "circle-check", title: language.t("session.share.copy.copied"), description: directory }))
      .catch((err: unknown) =>
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) }),
      )
  }

  const [rightMount, setRightMount] = createSignal<HTMLElement | null>(null)
  onMount(() => setRightMount(document.getElementById("opencode-titlebar-right")))

  return (
    <Show when={rightMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div class="flex items-center gap-2">
            <Show when={projectDirectory()}>
              <div class="hidden xl:flex items-center">
                <Show
                  when={canOpen()}
                  fallback={
                    <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                      <Button
                        variant="ghost"
                        class="rounded-none h-full py-0 pr-3 pl-0.5 gap-1.5 border-none shadow-none"
                        onClick={copyPath}
                        aria-label={language.t("session.header.open.copyPath")}
                      >
                        <Icon name="copy" size="small" class="text-icon-base" />
                        <span class="text-12-regular text-text-strong">{language.t("session.header.open.copyPath")}</span>
                      </Button>
                    </div>
                  }
                >
                  <div class="flex items-center">
                    <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                      <Button
                        variant="ghost"
                        class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
                        classList={{ "bg-surface-raised-base-active": opening() }}
                        onClick={() => openDir(current().id)}
                        disabled={opening()}
                        aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
                      >
                        <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                          <Show when={opening()} fallback={<AppIcon id={current().icon as any} />}>
                            <Spinner class="size-3.5" />
                          </Show>
                        </div>
                      </Button>
                      <DropdownMenu gutter={4} placement="bottom-end" open={menu.open} onOpenChange={(open) => setMenu("open", open)}>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="chevron-down"
                          variant="ghost"
                          disabled={opening()}
                          class="rounded-none h-full w-[20px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active disabled:!cursor-default"
                          classList={{ "bg-surface-raised-base-active": opening() }}
                          aria-label={language.t("session.header.open.menu")}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
                            <DropdownMenu.Group>
                              <DropdownMenu.GroupLabel class="!px-1 !py-1">{language.t("session.header.openIn")}</DropdownMenu.GroupLabel>
                              <DropdownMenu.RadioGroup
                                class="mt-1"
                                value={current().id}
                                onChange={(value: unknown) => {
                                  if (typeof value !== "string" || !(["vscode","cursor","zed","textmate","antigravity","finder","terminal","iterm2","ghostty","warp","xcode","android-studio","powershell","sublime-text"] as string[]).includes(value)) return
                                  selectApp(value as OpenApp)
                                }}
                              >
                                <For each={options()}>
                                  {(o) => (
                                    <DropdownMenu.RadioItem
                                      value={o.id}
                                      disabled={opening()}
                                      onSelect={() => { setMenu("open", false); openDir(o.id) }}
                                    >
                                      <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                                        <AppIcon id={o.icon as any} />
                                      </div>
                                      <DropdownMenu.ItemLabel>{o.label}</DropdownMenu.ItemLabel>
                                      <DropdownMenu.ItemIndicator>
                                        <Icon name="check-small" size="small" class="text-icon-weak" />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                  )}
                                </For>
                              </DropdownMenu.RadioGroup>
                            </DropdownMenu.Group>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item onSelect={() => { setMenu("open", false); copyPath() }}>
                              <div class="flex size-5 shrink-0 items-center justify-center">
                                <Icon name="copy" size="small" class="text-icon-weak" />
                              </div>
                              <DropdownMenu.ItemLabel>{language.t("session.header.open.copyPath")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
            <div class="flex items-center gap-1">
              <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                <StatusPopover />
              </Tooltip>
              <TooltipKeybind
                title={language.t("command.terminal.toggle")}
                keybind={command.keybind("terminal.toggle")}
              >
                <Button
                  variant="ghost"
                  class="group/terminal-toggle titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                  onClick={() => dashView.terminal.toggle()}
                  aria-label={language.t("command.terminal.toggle")}
                  aria-expanded={dashView.terminal.opened()}
                >
                  <Icon size="small" name={dashView.terminal.opened() ? "terminal-active" : "terminal"} />
                </Button>
              </TooltipKeybind>

              <div class="hidden md:flex items-center gap-1 shrink-0">
                <TooltipKeybind
                  title={language.t("command.review.toggle")}
                  keybind={command.keybind("review.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/review-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={() => dashView.reviewPanel.toggle()}
                    aria-label={language.t("command.review.toggle")}
                    aria-expanded={dashView.reviewPanel.opened()}
                  >
                    <Icon size="small" name={dashView.reviewPanel.opened() ? "review-active" : "review"} />
                  </Button>
                </TooltipKeybind>

                <TooltipKeybind
                  title={language.t("command.fileTree.toggle")}
                  keybind={command.keybind("fileTree.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={() => layout.fileTree.toggle()}
                    aria-label={language.t("command.fileTree.toggle")}
                    aria-expanded={layout.fileTree.opened()}
                  >
                    <div class="relative flex items-center justify-center size-4">
                      <Icon
                        size="small"
                        name={layout.fileTree.opened() ? "file-tree-active" : "file-tree"}
                        classList={{
                          "text-icon-strong": layout.fileTree.opened(),
                          "text-icon-weak": !layout.fileTree.opened(),
                        }}
                      />
                    </div>
                  </Button>
                </TooltipKeybind>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}

// Mission Control dashboard — Phase 2:
// status pill, notification badge, attention-required composite,
// attention-first sort with persisted "recent only" toggle, archived filter.
export default function DashboardPage() {
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const navigate = useNavigate()
  const params = useParams()
  const notification = useNotification()
  const permission = usePermission()

  const [prefs, setPrefs] = persisted(
    "dashboard.v1",
    createStore<DashboardPrefs>({ sortBy: "recent", showArchived: false }),
  )

  // ---------- Orchestrator pipelines ----------
  const [pipelineStore, setPipelineStore] = createStore<{ list: PipelineInstance[]; teams: Team[] }>({ list: [], teams: [] })
  const [prompt, setPrompt] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [startError, setStartError] = createSignal<string | null>(null)

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const http = server.current?.http
    if (http?.password) headers["Authorization"] = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
    return headers
  }
  const base = () => server.current?.http?.url || ""

  async function fetchPipelines() {
    const b = base()
    const dir = sync.data.path.directory
    if (!b || !dir) return
    try {
      const res = await fetch(`${b}/api/pipeline/instances?dir=${encodeURIComponent(dir)}`, { headers: authHeaders() })
      if (!res.ok) return
      const data = await res.json() as PipelineInstance[]
      setPipelineStore("list", reconcile(data, { key: "id" }))
    } catch {}
  }
  async function fetchConfig() {
    const b = base()
    const dir = sync.data.path.directory
    if (!b || !dir) return
    try {
      const res = await fetch(`${b}/api/pipeline/config?dir=${encodeURIComponent(dir)}`, { headers: authHeaders() })
      if (!res.ok) return
      const data = await res.json()
      const cfg = data.found ? data.config : data.default
      setPipelineStore("teams", cfg?.teams || [])
    } catch {}
  }

  let pollTimer: ReturnType<typeof setInterval>
  onMount(() => {
    fetchConfig()
    fetchPipelines()
    pollTimer = setInterval(fetchPipelines, 3000)
  })
  onCleanup(() => clearInterval(pollTimer))

  async function startOrchestrator() {
    const v = prompt().trim()
    setStartError(null)
    if (!v) { setStartError("Type a prompt first."); return }
    if (submitting()) return
    const dir = sync.data.path.directory
    if (!dir) { setStartError("Working directory not loaded yet — wait a moment and retry."); return }
    setSubmitting(true)
    try {
      const created = await sdk.client.session
        .create({ agent: "orchestrator" })
        .then((x) => x.data ?? undefined)
      if (!created) {
        setStartError("Failed to create session.")
        return
      }
      await sdk.client.session.promptAsync({
        sessionID: created.id,
        agent: "orchestrator",
        messageID: Identifier.ascending("message"),
        parts: [{ type: "text", text: v }],
      })
      setPrompt("")
      fetchPipelines()
    } catch (err) {
      setStartError(`Failed to start: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  async function stopPipeline(id: string) {
    const b = base()
    const dir = sync.data.path.directory
    if (!b || !dir) return
    await fetch(`${b}/api/pipeline/stop/${id}?dir=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    fetchPipelines()
  }

  const [stagePanel, setStagePanel] = createSignal<{ pipeline: PipelineInstance; stageIdx: number } | null>(null)
  const [sessionPanel, setSessionPanel] = createSignal<string | null>(null)

  // ---------- Viewed / attention tracking ----------
  // idledAt: when each session last transitioned from busy/retry → idle.
  // Only sessions that have actually been busy then went idle get an entry.
  const [idledAt, setIdledAt] = createSignal(new Map<string, number>())

  // flowViewedAt: when the user last opened ANY agent in a given flow,
  // keyed by the flow's root session ID. Opening any agent in a flow
  // dismisses the "completed" highlight for the entire flow.
  const [flowViewedAt, setFlowViewedAt] = createSignal(new Map<string, number>())

  // Walk up parentID chain to find the root session ID for a given session.
  function findRootID(sessionID: string): string {
    const sessions = sync.data.session ?? []
    const byID = new Map(sessions.map((s) => [s.id, s]))
    let cur = sessionID
    while (true) {
      const s = byID.get(cur)
      if (!s?.parentID) return cur
      cur = s.parentID
    }
  }

  function openSession(sessionID: string) {
    setSessionPanel(sessionID)
    const rootID = findRootID(sessionID)
    setFlowViewedAt((prev) => {
      const next = new Map(prev)
      next.set(rootID, Date.now())
      return next
    })
  }

  // Track busy→idle transitions: record the timestamp when each session goes idle.
  const prevStatuses = new Map<string, string>()
  createEffect(
    on(
      () => sync.data.session_status,
      (statuses) => {
        const newIdled: [string, number][] = []
        for (const [id, st] of Object.entries(statuses)) {
          const cur = st?.type ?? "idle"
          const prev = prevStatuses.get(id) ?? "idle"
          if ((prev === "busy" || prev === "retry") && cur === "idle") {
            newIdled.push([id, Date.now()])
          }
          prevStatuses.set(id, cur)
        }
        if (newIdled.length > 0) {
          setIdledAt((prev) => {
            const next = new Map(prev)
            for (const [id, ts] of newIdled) next.set(id, ts)
            return next
          })
        }
      },
    ),
  )
  // ---------- /Viewed / attention tracking ----------

  function openStage(pipeline: PipelineInstance, stageIdx: number) {
    setStagePanel({ pipeline, stageIdx })
  }

  // Collect rootID + every descendant session id (depth-first) for the given orchestrator root.
  function collectFlowIds(rootID: string): string[] {
    const sessions = sync.data.session ?? []
    const byParent = new Map<string, string[]>()
    for (const s of sessions) {
      if (!s.parentID) continue
      const arr = byParent.get(s.parentID)
      if (arr) arr.push(s.id)
      else byParent.set(s.parentID, [s.id])
    }
    const out: string[] = []
    const stack = [rootID]
    const seen = new Set<string>()
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      const kids = byParent.get(id)
      if (kids) stack.push(...kids)
    }
    return out
  }

  // Stop the entire orchestrator flow: aborts root + all descendant sessions in parallel.
  async function stopFlow(rootID: string) {
    const ids = collectFlowIds(rootID)
    await Promise.all(ids.map((id) => sdk.client.session.abort({ sessionID: id }).catch(() => {})))
  }

  // Delete the entire orchestrator flow: aborts everything first, then deletes the root
  // (server cascades the delete to all descendants — see Session.remove in session.ts).
  async function deleteFlow(rootID: string) {
    if (sessionPanel() && collectFlowIds(rootID).includes(sessionPanel()!)) {
      setSessionPanel(null)
    }
    await stopFlow(rootID)
    await sdk.client.session.delete({ sessionID: rootID }).catch(() => {})
  }

  // Re-resolve the panel's pipeline against the live store so streaming updates
  // (status changes, new sessionId once the orchestrator delegates) reflect in the panel.
  const livePanel = createMemo(() => {
    const sel = stagePanel()
    if (!sel) return null
    const live = pipelineStore.list.find((p) => p.id === sel.pipeline.id) || sel.pipeline
    return { pipeline: live, stageIdx: Math.min(sel.stageIdx, live.stages.length - 1) }
  })

  // ---------- /Orchestrator pipelines ----------

  const orchestratorRoots = createMemo(() =>
    (sync.data.session ?? [])
      .filter((s) => !s.parentID && (prefs.showArchived || !s.time?.archived))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
  )

  const directory = () => sync.data.path.directory

  const attentionFor = (sessionID: string): Attention => {
    const perm = sessionPermissionRequest(
      sync.data.session,
      sync.data.permission,
      sessionID,
      (item) => !permission.autoResponds(item, directory()),
    )
    const question = sessionQuestionRequest(sync.data.session, sync.data.question, sessionID)
    const status = sync.data.session_status[sessionID]?.type
    return {
      permission: !!perm,
      question: !!question,
      retry: status === "retry",
      error: notification.session.unseenHasError(sessionID),
    }
  }

  // Counts across ALL root sessions for the KPI bar.
  const counts = createMemo(() => {
    const sessions = orchestratorRoots()
    let active = 0
    let waiting = 0
    let errors = 0
    for (const s of sessions) {
      const st = sync.data.session_status[s.id]?.type ?? "idle"
      if (st === "busy" || st === "retry") active++
      const att = attentionFor(s.id)
      if (att.permission || att.question || att.retry || att.error) waiting++
      if (att.error) errors++
    }
    return { active, waiting, errors, total: sessions.length }
  })

  return (
    <div class="size-full overflow-auto bg-background-base">
      <DashboardTitlebarButtons />
      <div class="max-w-[1400px] mx-auto px-6 py-6 flex flex-col gap-6">
        <header class="flex items-center justify-between">
          <div class="flex flex-col gap-1">
            <h1 class="text-18-medium text-text-strong">Mission Control</h1>
            <span class="text-12-regular text-text-weak">
              {counts().total} session{counts().total === 1 ? "" : "s"}
            </span>
          </div>
        </header>

        {/* KPI bar — placeholder for cost; real values for counts derived locally. */}
        <div class="grid grid-cols-4 gap-3">
          <KpiTile label="Active" value={counts().active} />
          <KpiTile label="Waiting on you" value={counts().waiting} accent={counts().waiting > 0} />
          <KpiTile label="Cost today" value="—" />
          <KpiTile label="Errors" value={counts().errors} danger={counts().errors > 0} />
        </div>

        {/* Start with Orchestrator */}
        <div class="rounded-xl border border-border-base bg-background-strong p-5 flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#8B5CF620", color: "#8B5CF6" }}>
              <TeamIcon icon="compass" size={16} />
            </div>
            <div class="flex flex-col">
              <span class="text-13-medium text-text-strong">Start with Orchestrator</span>
              <span class="text-11-regular text-text-weak">Describe what you want — the orchestrator will plan and delegate to subagents.</span>
            </div>
          </div>
          <textarea
            rows={3}
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startOrchestrator() } }}
            placeholder="e.g. Add OAuth login to the marketing site and write tests"
            class="px-3 py-2 rounded-lg border border-border-base bg-background-base text-text-strong text-13-regular resize-none focus:outline-none focus:border-brand-base"
          />
          <div class="flex items-center justify-between">
            <span class="text-11-regular text-text-weak">⌘+Enter to start</span>
            <Button size="small" onClick={startOrchestrator} disabled={!prompt().trim() || submitting()}>
              {submitting() ? "Starting…" : "Start with Orchestrator"}
            </Button>
          </div>
          <Show when={startError()}>
            <div class="text-11-regular text-status-error border border-status-error/40 rounded px-3 py-2 bg-status-error/5">
              {startError()}
            </div>
          </Show>
        </div>

        {/* Session flow trees — all sessions use the same flow visualization */}
        <Show
          when={orchestratorRoots().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center py-20 gap-3">
              <h2 class="text-16-medium text-text-strong">No sessions yet</h2>
              <span class="text-12-regular text-text-weak">
                Start a session from the sidebar or use the orchestrator above.
              </span>
            </div>
          }
        >
          <div class="flex flex-col gap-3">
            <For each={orchestratorRoots()}>
              {(root) => (
                <OrchestratorFlow
                  root={root}
                  onOpen={openSession}
                  onStop={stopFlow}
                  onDelete={deleteFlow}
                  idledAt={idledAt()}
                  flowViewedAt={flowViewedAt()}
                />
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Stage chat side panel */}
      <Show when={livePanel()}>
        {(sel) => (
          <StageSessionPanel
            pipeline={sel().pipeline}
            stageIdx={sel().stageIdx}
            team={pipelineStore.teams.find((t) => t.id === sel().pipeline.stages[sel().stageIdx]?.teamId)}
            encodedDir={params.dir || ""}
            onClose={() => setStagePanel(null)}
          />
        )}
      </Show>
      <Show when={livePanel()}>
        <div class="fixed inset-0 z-30 bg-black/20" onClick={() => setStagePanel(null)} />
      </Show>

      {/* Slide-in session panel (clicking any dashboard session card) */}
      <Show when={sessionPanel()}>
        {(id) => (
          <SessionSlidePanel
            sessionID={id()}
            encodedDir={params.dir || ""}
            onClose={() => setSessionPanel(null)}
          />
        )}
      </Show>
      <Show when={sessionPanel()}>
        <div class="fixed inset-0 z-30 bg-black/20" onClick={() => setSessionPanel(null)} />
      </Show>

      <style>{`
        @keyframes dashSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .dash-slide-in { animation: dashSlideIn 0.3s cubic-bezier(0.16,1,0.3,1) forwards; }
      `}</style>
    </div>
  )
}

function StageSessionPanel(props: {
  pipeline: PipelineInstance
  stageIdx: number
  team: Team | undefined
  encodedDir: string
  onClose: () => void
}) {
  const stage = () => props.pipeline.stages[props.stageIdx]
  const sessionUrl = () => {
    const sid = stage()?.sessionId
    if (!sid) return null
    return `/${props.encodedDir}/session/${sid}?embedded=1`
  }
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose()
  }
  onMount(() => window.addEventListener("keydown", handleKeyDown))
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown))

  return (
    <div class="fixed top-0 right-0 h-full w-[640px] z-40 bg-background-strong border-l border-border-base shadow-2xl flex flex-col dash-slide-in">
      <div class="shrink-0 px-5 py-4 border-b border-border-base flex items-center justify-between">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 shrink-0 rounded-full flex items-center justify-center" style={{ background: `${pipelineStatusColor(stage()?.status || "pending")}20`, color: pipelineStatusColor(stage()?.status || "pending") }}>
            <TeamIcon icon={props.team?.icon || "code"} size={16} />
          </div>
          <div class="flex flex-col min-w-0">
            <span class="text-13-medium text-text-strong truncate">{stage()?.label || props.team?.name || stage()?.teamId}</span>
            <span class="text-11-regular text-text-weak truncate">{props.pipeline.storyTitle}</span>
          </div>
        </div>
        <button type="button" onClick={props.onClose} class="text-text-weak hover:text-text-strong transition-colors shrink-0" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4L4 12M4 4l8 8" /></svg>
        </button>
      </div>
      <div class="flex-1 min-h-0 bg-background-base">
        <Show
          when={sessionUrl()}
          fallback={
            <div class="flex flex-col items-center justify-center h-full px-6 text-center gap-2">
              <div class="text-13-medium text-text-strong">
                {stage()?.status === "pending" ? "Stage hasn't started yet" : "No session attached"}
              </div>
              <div class="text-12-regular text-text-weak">
                {stage()?.status === "pending"
                  ? "It will appear here once the orchestrator delegates."
                  : `Stage status: ${stage()?.status}`}
              </div>
              <Show when={stage()?.output}>
                <pre class="mt-3 max-w-full max-h-64 overflow-auto rounded-md bg-background-strong p-3 text-12-regular text-text-strong whitespace-pre-wrap font-mono text-left">
                  {typeof stage()!.output === "string" ? stage()!.output : JSON.stringify(stage()!.output, null, 2)}
                </pre>
              </Show>
            </div>
          }
        >
          {(url) => (
            <iframe
              src={url()}
              class="w-full h-full border-0 block"
              title={`${stage()?.label || props.team?.name || stage()?.teamId} session`}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            />
          )}
        </Show>
      </div>
    </div>
  )
}

function KpiTile(props: { label: string; value: number | string; accent?: boolean; danger?: boolean }) {
  return (
    <div
      class="rounded-lg border bg-background-strong p-4 flex flex-col gap-1 transition-colors"
      classList={{
        "border-border-base": !props.accent && !props.danger,
        "border-status-warning": props.accent,
        "border-status-error": props.danger,
      }}
    >
      <span class="text-11-regular text-text-weak uppercase tracking-wider">{props.label}</span>
      <span
        class="text-18-medium"
        classList={{
          "text-text-strong": !props.danger,
          "text-status-error": props.danger,
        }}
      >
        {props.value}
      </span>
    </div>
  )
}

function SessionSlidePanel(props: { sessionID: string; encodedDir: string; onClose: () => void }) {
  const sync = useSync()
  const session = () => (sync.data.session ?? []).find((s) => s.id === props.sessionID)
  const status = () => sync.data.session_status[props.sessionID]?.type ?? "idle"
  const url = () => `/${props.encodedDir}/session/${props.sessionID}?embedded=1`

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose()
  }
  onMount(() => window.addEventListener("keydown", handleKeyDown))
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown))

  return (
    <div class="fixed top-0 right-0 h-full w-[640px] z-40 bg-background-strong border-l border-border-base shadow-2xl flex flex-col dash-slide-in">
      <div class="shrink-0 px-5 py-4 border-b border-border-base flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <span
            class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-11-medium shrink-0"
            style={{ background: `${statusColor(status(), false)}20`, color: statusColor(status(), false) }}
          >
            <span class="size-1.5 rounded-full" style={{ background: statusColor(status(), false) }} />
            {statusLabel(status())}
          </span>
          <div class="flex flex-col min-w-0">
            <span class="text-13-medium text-text-strong truncate">
              {session()?.title || "Session"}
            </span>
            <Show when={session()?.agent}>
              <span class="text-11-regular text-text-weak truncate">@{session()?.agent}</span>
            </Show>
          </div>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          class="text-text-weak hover:text-text-strong transition-colors shrink-0"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 4L4 12M4 4l8 8" />
          </svg>
        </button>
      </div>
      <div class="flex-1 min-h-0 bg-background-base">
        <iframe
          src={url()}
          class="w-full h-full border-0 block"
          title={session()?.title || "Session"}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        />
      </div>
    </div>
  )
}
