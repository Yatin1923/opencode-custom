import { Effect, Layer, Context, Scope, Stream } from "effect"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { indexWorktree, indexFile, removeFile, type IndexReport } from "./indexer"
import { SymbolStore } from "./store"

const log = Log.create({ service: "symbol-index" })

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly reindex: () => Effect.Effect<IndexReport>
  readonly stats: () => Effect.Effect<{ files: number; symbols: number; worktree: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SymbolIndex") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const fs = yield* AppFileSystem.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make(
      Effect.fn("SymbolIndex.state")(function* (ctx) {
        log.info("starting symbol index", { worktree: ctx.worktree })

        // Initial background sweep. Don't block init — large repos can take
        // seconds and we want the session to be responsive immediately.
        yield* indexWorktree(ctx.worktree).pipe(
          Effect.tap((report) => Effect.sync(() => log.info("initial sweep complete", report))),
          Effect.catchCause((cause) => Effect.sync(() => log.warn("initial sweep failed", { cause }))),
          Effect.provideService(AppFileSystem.Service, fs),
          Effect.forkIn(scope),
        )

        // Subscribe to all file-touch events. The watcher publishes for
        // external edits; edit/write/apply_patch tools also publish here
        // after a successful write — so one subscription covers both
        // AI-driven changes and changes made by the user in another editor
        // while opencode is running.
        //
        // No debouncer: `indexFile` short-circuits in ~ms via a content-hash
        // check when nothing has changed, so duplicate "create + change"
        // events for the same file result in at most one real parse.
        yield* bus
          .subscribe(FileWatcher.Event.Updated)
          .pipe(
            Stream.filter((evt) => {
              const rel = path.relative(ctx.worktree, evt.properties.file)
              return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
            }),
            Stream.runForEach((evt) => {
              const file = evt.properties.file
              const task = evt.properties.event === "unlink" ? removeFile(file) : indexFile(ctx.worktree, file)
              return task.pipe(
                Effect.catchCause(() => Effect.void),
                Effect.provideService(AppFileSystem.Service, fs),
              )
            }),
            Effect.forkScoped,
          )

        return {}
      }),
    )

    return Service.of({
      init: Effect.fn("SymbolIndex.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      reindex: Effect.fn("SymbolIndex.reindex")(function* () {
        const ctx = yield* InstanceState.context
        return yield* indexWorktree(ctx.worktree).pipe(Effect.provideService(AppFileSystem.Service, fs), Effect.orDie)
      }),
      stats: Effect.fn("SymbolIndex.stats")(function* () {
        const ctx = yield* InstanceState.context
        const s = yield* Effect.sync(() => SymbolStore.worktreeStats(ctx.worktree))
        return { ...s, worktree: ctx.worktree }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(FileWatcher.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as SymbolIndex from "./symbol-index"
