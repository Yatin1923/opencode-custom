import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { SymbolIndex } from "@/memory/symbol-index/symbol-index"

export const IndexCommand = effectCmd({
  command: "index",
  describe: "build or refresh the symbol index for this project",
  builder: (yargs) =>
    yargs
      .option("status", {
        describe: "show index stats instead of (re)building",
        type: "boolean",
        default: false,
      })
      .option("force", {
        describe: "ignore content hashes and re-parse every file",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.index")(function* (args) {
    const svc = yield* SymbolIndex.Service

    if (args.status) {
      const { files, symbols, worktree } = yield* svc.stats()
      console.log(`Symbol index for ${worktree}`)
      console.log(`  files:   ${files.toLocaleString()}`)
      console.log(`  symbols: ${symbols.toLocaleString()}`)
      if (files === 0) {
        console.log("\nIndex is empty. Run `opencode index` to build it.")
      }
      return
    }

    console.log("Indexing project…")
    const start = Date.now()
    const report = yield* svc.reindex()
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)

    console.log(`Done in ${elapsed}s`)
    console.log(`  files scanned:    ${report.files_scanned.toLocaleString()}`)
    console.log(`  files parsed:     ${report.files_parsed.toLocaleString()}`)
    console.log(`  files unchanged:  ${report.files_skipped_fresh.toLocaleString()}`)
    console.log(`  files failed:     ${report.files_failed.toLocaleString()}`)
    console.log(`  total symbols:    ${report.symbols_total.toLocaleString()}`)

    // `args.force` is reserved for a future "ignore-hash" flag — currently
    // every parse already short-circuits on hash match, so the flag is a no-op.
    void args.force
  }),
})
