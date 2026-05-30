import { Effect } from "effect"
import path from "path"
import { createHash } from "crypto"
import * as Log from "@opencode-ai/core/util/log"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { detectLanguage, parseSource } from "./parser"
import { SymbolStore } from "./store"

const log = Log.create({ service: "symbol-index.indexer" })

const DEFAULT_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}"

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.opencode/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.d.ts",
]

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export interface IndexReport {
  files_scanned: number
  files_parsed: number
  files_skipped_fresh: number
  files_failed: number
  symbols_total: number
}

/**
 * Walk a worktree, parse each source file, and upsert its symbols + references
 * into the global database. Files whose content hash matches the stored hash
 * are skipped (fast incremental re-index).
 */
export const indexWorktree = Effect.fn("SymbolIndex.indexWorktree")(function* (worktree: string) {
  const fs = yield* AppFileSystem.Service

  const files = yield* fs.glob(DEFAULT_GLOB, {
    cwd: worktree,
    absolute: true,
    include: "file",
  })

  const filtered = files.filter((f) => !DEFAULT_IGNORE.some((p) => match(f, p)))

  log.info("starting index", { worktree, files: filtered.length })

  const report: IndexReport = {
    files_scanned: filtered.length,
    files_parsed: 0,
    files_skipped_fresh: 0,
    files_failed: 0,
    symbols_total: 0,
  }

  yield* Effect.forEach(
    filtered,
    Effect.fnUntraced(function* (file) {
      const lang = detectLanguage(file)
      if (!lang) return

      const content = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(null)))
      if (content === null) {
        report.files_failed += 1
        return
      }

      const hash = hashContent(content)
      if (SymbolStore.isFresh(file, hash)) {
        report.files_skipped_fresh += 1
        return
      }

      const parsed = yield* Effect.sync(() => parseSource(file, content)).pipe(
        Effect.catch((err) => {
          log.warn("parse failed", { file, err })
          return Effect.succeed(null)
        }),
      )
      if (!parsed) {
        report.files_failed += 1
        return
      }

      yield* Effect.sync(() =>
        SymbolStore.upsertFile({
          path: file,
          worktree,
          language: lang,
          contentHash: hash,
          parsed,
        }),
      )
      report.files_parsed += 1
      report.symbols_total += parsed.symbols.length
    }),
    { concurrency: 8 },
  )

  // Drop rows for files that no longer exist on disk.
  const present = new Set(filtered)
  const stored = yield* Effect.sync(() => SymbolStore.listWorktreeFiles(worktree))
  for (const row of stored) {
    if (!present.has(row.path)) {
      yield* Effect.sync(() => SymbolStore.removeFile(row.path))
    }
  }

  log.info("index complete", { worktree, ...report })
  return report
})

// Trivial glob matcher for the small set of ignore patterns above. We use it
// rather than running the full glob engine again per file.
function match(filePath: string, pattern: string): boolean {
  const norm = filePath.split(path.sep).join("/")
  const re = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) =>
          seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
        )
        .join("/") +
      "$",
  )
  return re.test(norm)
}

export * as SymbolIndexer from "./indexer"

/**
 * Index a single file. Used by the bus subscriber when a file is touched
 * (by the AI's edit tool or an external editor). Returns true if the file
 * was indexed, false if it was skipped (unchanged or unsupported).
 */
export const indexFile = Effect.fn("SymbolIndex.indexFile")(function* (worktree: string, filePath: string) {
  const fs = yield* AppFileSystem.Service
  const lang = detectLanguage(filePath)
  if (!lang) return false
  if (DEFAULT_IGNORE.some((p) => match(filePath, p))) return false

  const exists = yield* fs.existsSafe(filePath)
  if (!exists) {
    yield* Effect.sync(() => SymbolStore.removeFile(filePath))
    return true
  }

  const content = yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed(null)))
  if (content === null) return false

  const hash = hashContent(content)
  if (SymbolStore.isFresh(filePath, hash)) return false

  const parsed = yield* Effect.sync(() => parseSource(filePath, content)).pipe(
    Effect.catch(() => Effect.succeed(null)),
  )
  if (!parsed) return false

  yield* Effect.sync(() =>
    SymbolStore.upsertFile({
      path: filePath,
      worktree,
      language: lang,
      contentHash: hash,
      parsed,
    }),
  )
  return true
})

/**
 * Drop a file from the index (used when we get a delete event from the watcher).
 */
export const removeFile = Effect.fn("SymbolIndex.removeFile")(function* (filePath: string) {
  yield* Effect.sync(() => SymbolStore.removeFile(filePath))
})
