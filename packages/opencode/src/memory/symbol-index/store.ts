import { Database } from "@/storage/db"
import { and, eq, inArray, like, sql } from "drizzle-orm"
import { IndexedFileTable, SymbolTable, SymbolReferenceTable } from "./schema.sql"
import type { ParseResult, ParsedSymbol, SymbolKind } from "./parser"

export type SymbolRow = typeof SymbolTable.$inferSelect
export type IndexedFileRow = typeof IndexedFileTable.$inferSelect
export type SymbolReferenceRow = typeof SymbolReferenceTable.$inferSelect

function symbolId(filePath: string, name: string, line: number): string {
  return `${filePath}::${name}::${line}`
}

function referenceId(fromFile: string, fromLine: number, toName: string, idx: number): string {
  return `${fromFile}::${fromLine}::${toName}::${idx}`
}

export function upsertFile(args: {
  path: string
  worktree: string
  language: string
  contentHash: string
  parsed: ParseResult
}): void {
  Database.transaction((tx) => {
    // Wipe existing rows for this file (cascade removes symbols + references).
    tx.delete(IndexedFileTable).where(eq(IndexedFileTable.path, args.path)).run()

    tx.insert(IndexedFileTable)
      .values({
        path: args.path,
        worktree: args.worktree,
        language: args.language,
        content_hash: args.contentHash,
        symbol_count: args.parsed.symbols.length,
      })
      .run()

    if (args.parsed.symbols.length) {
      // Build a name → id lookup so methods can point at their parent class.
      const ids = new Map<string, string>()
      for (const s of args.parsed.symbols) {
        ids.set(`${s.name}@${s.line}`, symbolId(args.path, s.name, s.line))
      }

      const rows = args.parsed.symbols.map((s) => ({
        id: symbolId(args.path, s.name, s.line),
        file_path: args.path,
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        line: s.line,
        column: s.column,
        end_line: s.end_line,
        exported: s.exported,
        is_async: s.is_async,
        parent_id: s.parent_name
          ? (args.parsed.symbols.find((p) => p.name === s.parent_name)
              ? symbolId(
                  args.path,
                  s.parent_name,
                  args.parsed.symbols.find((p) => p.name === s.parent_name)!.line,
                )
              : null)
          : null,
        doc: s.doc,
      }))
      // SQLite has a 999-variable limit per statement; chunk to be safe.
      for (const batch of chunk(rows, 100)) {
        tx.insert(SymbolTable).values(batch).run()
      }
    }

    if (args.parsed.references.length) {
      const refRows = args.parsed.references.map((r, i) => ({
        id: referenceId(args.path, r.from_line, r.to_name, i),
        from_file: args.path,
        from_line: r.from_line,
        from_symbol_id: null,
        to_name: r.to_name,
      }))
      for (const batch of chunk(refRows, 100)) {
        tx.insert(SymbolReferenceTable).values(batch).run()
      }
    }
  })
}

export function removeFile(filePath: string): void {
  Database.use((tx) => tx.delete(IndexedFileTable).where(eq(IndexedFileTable.path, filePath)).run())
}

export function getFile(filePath: string): IndexedFileRow | undefined {
  return Database.use((tx) =>
    tx.select().from(IndexedFileTable).where(eq(IndexedFileTable.path, filePath)).get(),
  )
}

export function findByName(args: { worktree: string; name: string; kind?: SymbolKind; limit?: number }): SymbolRow[] {
  return Database.use((tx) =>
    tx
      .select({ s: SymbolTable })
      .from(SymbolTable)
      .innerJoin(IndexedFileTable, eq(IndexedFileTable.path, SymbolTable.file_path))
      .where(
        and(
          eq(IndexedFileTable.worktree, args.worktree),
          eq(SymbolTable.name, args.name),
          args.kind ? eq(SymbolTable.kind, args.kind) : undefined,
        ),
      )
      .limit(args.limit ?? 25)
      .all()
      .map((r) => r.s),
  )
}

export function searchByPrefix(args: { worktree: string; prefix: string; limit?: number }): SymbolRow[] {
  return Database.use((tx) =>
    tx
      .select({ s: SymbolTable })
      .from(SymbolTable)
      .innerJoin(IndexedFileTable, eq(IndexedFileTable.path, SymbolTable.file_path))
      .where(and(eq(IndexedFileTable.worktree, args.worktree), like(SymbolTable.name, `${args.prefix}%`)))
      .limit(args.limit ?? 25)
      .all()
      .map((r) => r.s),
  )
}

export function listFileSymbols(filePath: string): SymbolRow[] {
  return Database.use((tx) =>
    tx.select().from(SymbolTable).where(eq(SymbolTable.file_path, filePath)).orderBy(SymbolTable.line).all(),
  )
}

export function findCallers(args: { worktree: string; name: string; limit?: number }): SymbolReferenceRow[] {
  return Database.use((tx) =>
    tx
      .select({ r: SymbolReferenceTable })
      .from(SymbolReferenceTable)
      .innerJoin(IndexedFileTable, eq(IndexedFileTable.path, SymbolReferenceTable.from_file))
      .where(and(eq(IndexedFileTable.worktree, args.worktree), eq(SymbolReferenceTable.to_name, args.name)))
      .limit(args.limit ?? 100)
      .all()
      .map((r) => r.r),
  )
}

export function listWorktreeFiles(worktree: string): IndexedFileRow[] {
  return Database.use((tx) =>
    tx.select().from(IndexedFileTable).where(eq(IndexedFileTable.worktree, worktree)).all(),
  )
}

export function clearWorktree(worktree: string): void {
  Database.use((tx) => tx.delete(IndexedFileTable).where(eq(IndexedFileTable.worktree, worktree)).run())
}

export type WorktreeMap = {
  worktree: string
  files: Array<{ path: string; language: string; symbol_count: number; loc: number }>
  edges: Array<{ from: string; to: string; weight: number }>
}

/**
 * Aggregated graph view of the index: per-file size (symbol_count, max line
 * seen) and per-(from_file, to_file) call counts. Used by the UI map view.
 *
 * Edges are resolved by joining SymbolReference.to_name against Symbol.name
 * within the same worktree. Ambiguous names (same symbol name in 2 files) get
 * counted against every match — acceptable for a map overview; precise
 * resolution would require LSP. Self-edges are dropped.
 */
export function worktreeMap(worktree: string): WorktreeMap {
  return Database.use((tx) => {
    const files = tx
      .select({
        path: IndexedFileTable.path,
        language: IndexedFileTable.language,
        symbol_count: IndexedFileTable.symbol_count,
        loc: sql<number>`coalesce(max(${SymbolTable.end_line}), 0)`.mapWith(Number),
      })
      .from(IndexedFileTable)
      .leftJoin(SymbolTable, eq(SymbolTable.file_path, IndexedFileTable.path))
      .where(eq(IndexedFileTable.worktree, worktree))
      .groupBy(IndexedFileTable.path)
      .all()

    const edgeRows = tx
      .select({
        from: SymbolReferenceTable.from_file,
        to: SymbolTable.file_path,
        weight: sql<number>`count(*)`.mapWith(Number),
      })
      .from(SymbolReferenceTable)
      .innerJoin(IndexedFileTable, eq(IndexedFileTable.path, SymbolReferenceTable.from_file))
      .innerJoin(SymbolTable, eq(SymbolTable.name, SymbolReferenceTable.to_name))
      .innerJoin(
        sql`${IndexedFileTable} as target_file`,
        sql`target_file.path = ${SymbolTable.file_path} and target_file.worktree = ${worktree}`,
      )
      .where(eq(IndexedFileTable.worktree, worktree))
      .groupBy(SymbolReferenceTable.from_file, SymbolTable.file_path)
      .all()

    const edges = edgeRows.filter((e) => e.from !== e.to)

    return { worktree, files, edges }
  })
}

export function worktreeStats(worktree: string): { files: number; symbols: number } {
  return Database.use((tx) => {
    const files = tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(IndexedFileTable)
      .where(eq(IndexedFileTable.worktree, worktree))
      .get()
    const symbols = tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(SymbolTable)
      .innerJoin(IndexedFileTable, eq(IndexedFileTable.path, SymbolTable.file_path))
      .where(eq(IndexedFileTable.worktree, worktree))
      .get()
    return { files: files?.count ?? 0, symbols: symbols?.count ?? 0 }
  })
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Help downstream users that want to avoid re-parsing unchanged files.
export function isFresh(filePath: string, contentHash: string): boolean {
  const row = getFile(filePath)
  return row?.content_hash === contentHash
}

// Compile-time discipline: also expose unused helpers indirectly to satisfy
// the linter without changing their public availability.
// (kept) — `ParsedSymbol`/`ParseResult` are referenced in `upsertFile` arg type.
export type { ParsedSymbol }

export * as SymbolStore from "./store"
