import { Effect, Schema } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import { SymbolStore } from "@/memory/symbol-index/store"
import DESCRIPTION from "./symbol_lookup.txt"

const SymbolKind = Schema.Union([
  Schema.Literal("function"),
  Schema.Literal("class"),
  Schema.Literal("method"),
  Schema.Literal("interface"),
  Schema.Literal("type"),
  Schema.Literal("enum"),
  Schema.Literal("variable"),
])

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "Exact symbol name to look up (case-sensitive)",
  }),
  kind: Schema.optional(SymbolKind).annotate({
    description: "Narrow the result to a specific symbol kind",
  }),
  include_callers: Schema.optional(Schema.Boolean).annotate({
    description: "Also list approximate call sites for this symbol (default false)",
  }),
  include_file_symbols: Schema.optional(Schema.Boolean).annotate({
    description: "Also list the other symbols declared in the same file (default false)",
  }),
})

export const SymbolLookupTool = Tool.define(
  "symbol_lookup",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const worktree = instance.worktree

          const matches = yield* Effect.sync(() =>
            SymbolStore.findByName({ worktree, name: params.name, kind: params.kind, limit: 25 }),
          )

          if (matches.length === 0) {
            return {
              title: params.name,
              metadata: { matches: 0, callers: 0 },
              output: [
                `No symbol named "${params.name}" found in the current worktree index.`,
                "",
                "If the index is empty or stale, run `/index` to (re)build it.",
              ].join("\n"),
            }
          }

          const callers = params.include_callers
            ? yield* Effect.sync(() => SymbolStore.findCallers({ worktree, name: params.name, limit: 50 }))
            : ([] as ReturnType<typeof SymbolStore.findCallers>)

          const lines: string[] = [`Found ${matches.length} symbol(s) named "${params.name}":`, ""]

          for (const s of matches) {
            const rel = path.relative(worktree, s.file_path)
            const flags = [s.exported ? "exported" : null, s.is_async ? "async" : null]
              .filter(Boolean)
              .join(", ")
            lines.push(`- ${s.kind}${flags ? ` (${flags})` : ""}  ${rel}:${s.line}`)
            if (s.signature) lines.push(`    signature: ${s.signature}`)
            if (s.parent_id) lines.push(`    member of: ${s.parent_id.split("::")[1] ?? "?"}`)
            if (s.doc) lines.push(`    doc: ${truncate(s.doc, 240)}`)

            if (params.include_file_symbols) {
              const siblings = yield* Effect.sync(() => SymbolStore.listFileSymbols(s.file_path))
              const others = siblings.filter((x) => x.id !== s.id).slice(0, 20)
              if (others.length) {
                lines.push(`    sibling symbols in same file:`)
                for (const o of others) lines.push(`      - ${o.kind} ${o.name} @${o.line}`)
              }
            }
          }

          if (params.include_callers) {
            lines.push("")
            if (callers.length === 0) {
              lines.push("Callers: none found (name-based search).")
            } else {
              lines.push(`Approximate callers (${callers.length}):`)
              for (const c of callers.slice(0, 30)) {
                lines.push(`  - ${path.relative(worktree, c.from_file)}:${c.from_line}`)
              }
              if (callers.length > 30) lines.push(`  ... ${callers.length - 30} more`)
            }
          }

          return {
            title: params.name,
            metadata: { matches: matches.length, callers: callers.length },
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…"
}
