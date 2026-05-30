import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { SymbolMapScene, type SymbolMapClean } from "@/components/symbol-map-scene"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"

/**
 * Spatial 3D "city" view of the project's symbol index. Each file is a block
 * sized by symbol count and height by LOC, grouped into districts by top-level
 * directory. Call edges are drawn as arcs. The most recently edited file
 * pulses live via the FileWatcher event stream.
 */
export default function MapPage() {
  useParams<{ dir: string }>()
  const sdk = useSDK()

  // The SymbolIndex builds in the background after session bootstrap, so the
  // first /symbol-map call right after opening a fresh project can return an
  // empty result. We refetch every few seconds until at least one file shows
  // up, then drop the polling cadence.
  const [tick, setTick] = createSignal(0)
  const [data, { refetch }] = createResource(tick, async () => {
    const res = await sdk.client.symbolMap.get({})
    const raw = res.data
    if (!raw) return raw
    // OpenAPI generation widens Schema.Number to `number | "NaN" | "Infinity" | "-Infinity"`.
    // Coerce at the boundary so the rest of the UI works in plain numbers.
    const num = (x: number | "NaN" | "Infinity" | "-Infinity"): number => (typeof x === "number" ? x : Number(x))
    return {
      worktree: raw.worktree,
      files: raw.files.map((f) => ({
        path: f.path,
        language: f.language,
        symbol_count: num(f.symbol_count),
        loc: num(f.loc),
      })),
      edges: raw.edges.map((e) => ({ from: e.from, to: e.to, weight: num(e.weight) })),
    }
  })

  let pollTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    pollTimer = setInterval(() => {
      const d = data()
      if (!d || d.files.length === 0) setTick((n) => n + 1)
      else if (pollTimer) clearInterval(pollTimer)
    }, 4000)
  })
  onCleanup(() => pollTimer && clearInterval(pollTimer))

  // Pulse the most recently touched file. We listen to the live event bus
  // (file.watcher.updated covers both AI edits and external editor changes
  // because the edit/write/apply_patch tools publish this event too).
  const [pulseFile, setPulseFile] = createSignal<string | undefined>(undefined)
  let pulseTimer: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    const stop = sdk.event.on("file.watcher.updated", (evt) => {
      const file = (evt as { properties?: { file?: string } }).properties?.file
      if (!file) return
      setPulseFile(file)
      if (pulseTimer) clearTimeout(pulseTimer)
      pulseTimer = setTimeout(() => setPulseFile(undefined), 8000)
      // A write means the index will refresh — pull a fresh map shortly after.
      setTimeout(() => void refetch(), 1500)
    })
    onCleanup(stop)
  })
  onCleanup(() => pulseTimer && clearTimeout(pulseTimer))

  const [focused, setFocused] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")

  const filtered = createMemo<SymbolMapClean["files"]>(() => {
    const q = query().toLowerCase().trim()
    const d = data()
    if (!d) return []
    if (!q) return [...d.files].sort((a, b) => b.symbol_count - a.symbol_count).slice(0, 80)
    return d.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 80)
  })

  const stats = createMemo(() => {
    const d = data()
    if (!d) return null
    const totalSymbols = d.files.reduce((acc, f) => acc + f.symbol_count, 0)
    const totalLoc = d.files.reduce((acc, f) => acc + f.loc, 0)
    return { files: d.files.length, symbols: totalSymbols, loc: totalLoc, edges: d.edges.length }
  })

  return (
    <div class="w-full h-full flex bg-background-base text-text-strong">
      <div class="flex-1 relative">
        <Show
          when={data() && data()!.files.length > 0}
          fallback={
            <div class="absolute inset-0 flex items-center justify-center flex-col gap-3 text-text-weak">
              <Spinner />
              <div class="text-13-medium">
                {data() ? "Indexing project — this can take a few seconds on first open." : "Loading symbol map…"}
              </div>
              <Button size="small" onClick={() => setTick((n) => n + 1)}>
                Refresh
              </Button>
            </div>
          }
        >
          <SymbolMapScene
            data={data()!}
            pulseFile={pulseFile()}
            focused={focused()}
            onFocus={(path) => setFocused(path)}
          />
        </Show>

        <div class="absolute top-4 left-4 px-3 py-2 rounded-lg bg-background-strong/80 border border-border backdrop-blur-sm">
          <div class="text-10-medium uppercase tracking-wider text-text-weak">Project Map</div>
          <Show when={stats()}>
            {(s) => (
              <div class="text-12-regular text-text-strong">
                {s().files.toLocaleString()} files · {s().symbols.toLocaleString()} symbols ·{" "}
                {s().edges.toLocaleString()} edges
              </div>
            )}
          </Show>
          <Show when={data()?.worktree}>
            {(w) => <div class="text-10-regular text-text-weak truncate max-w-[420px]">{w()}</div>}
          </Show>
        </div>

        <div class="absolute bottom-4 left-4 right-4 flex justify-center pointer-events-none">
          <div class="px-3 py-2 rounded-lg bg-background-strong/80 border border-border backdrop-blur-sm text-10-regular text-text-weak">
            drag to orbit · scroll to zoom · click a block to focus
          </div>
        </div>
      </div>

      <aside class="w-80 shrink-0 border-l border-border bg-background-strong flex flex-col">
        <div class="p-3 border-b border-border">
          <input
            type="text"
            placeholder="Filter files…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            class="w-full px-2 py-1.5 rounded-md bg-background-base border border-border text-12-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:border-border-strong"
          />
        </div>
        <div class="flex-1 overflow-y-auto">
          <For each={filtered()}>
            {(f) => (
              <button
                type="button"
                class="w-full px-3 py-2 text-left hover:bg-background-base transition-colors border-b border-border/40 block"
                classList={{ "bg-background-base": focused() === f.path }}
                onClick={() => setFocused(f.path)}
              >
                <div class="text-12-medium text-text-strong truncate" title={f.path}>
                  {f.path.split("/").pop()}
                </div>
                <div class="text-10-regular text-text-weak truncate">{f.path}</div>
                <div class="text-10-regular text-text-weak mt-0.5">
                  {f.symbol_count} symbols · {f.loc} loc · {f.language}
                </div>
              </button>
            )}
          </For>
          <Show when={data() && filtered().length === 0}>
            <div class="p-4 text-12-regular text-text-weak text-center">No files match.</div>
          </Show>
        </div>
      </aside>
    </div>
  )
}
