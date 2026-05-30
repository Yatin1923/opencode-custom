import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../../storage/schema.sql"

/**
 * One row per source file we've indexed.
 * `content_hash` lets the indexer skip files whose contents haven't changed
 * since the last index pass.
 */
export const IndexedFileTable = sqliteTable(
  "indexed_file",
  {
    path: text().primaryKey(), // absolute path
    worktree: text().notNull(), // project root the file belongs to
    language: text().notNull(), // "typescript" | "javascript" | "tsx" | "jsx"
    content_hash: text().notNull(),
    symbol_count: integer().notNull(),
    do_not_edit: integer({ mode: "boolean" }).notNull().$default(() => false),
    ...Timestamps,
  },
  (table) => [index("indexed_file_worktree_idx").on(table.worktree)],
)

/**
 * One row per top-level (or class-member) declaration discovered in a file.
 * Stable `id` = `${path}::${name}::${line}` so re-indexes produce identical
 * ids for unchanged symbols.
 */
export const SymbolTable = sqliteTable(
  "symbol",
  {
    id: text().primaryKey(),
    file_path: text()
      .notNull()
      .references(() => IndexedFileTable.path, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().notNull(), // function | class | method | interface | type | enum | variable
    signature: text(), // e.g. "(opts: SessionOpts) => Promise<Session>"
    line: integer().notNull(),
    column: integer().notNull(),
    end_line: integer().notNull(),
    exported: integer({ mode: "boolean" }).notNull(),
    is_async: integer({ mode: "boolean" }).notNull(),
    parent_id: text(), // for methods, points at the parent class symbol id
    doc: text(), // leading jsdoc comment, if any
    ...Timestamps,
  },
  (table) => [
    index("symbol_name_idx").on(table.name),
    index("symbol_file_path_idx").on(table.file_path),
    index("symbol_kind_idx").on(table.kind),
  ],
)

/**
 * Approximate call/reference edges. We don't do full semantic resolution —
 * we record the called name and resolve it at query time. Good enough for
 * "who calls foo()" queries with very high recall.
 */
export const SymbolReferenceTable = sqliteTable(
  "symbol_reference",
  {
    id: text().primaryKey(),
    from_file: text()
      .notNull()
      .references(() => IndexedFileTable.path, { onDelete: "cascade" }),
    from_line: integer().notNull(),
    from_symbol_id: text(), // enclosing symbol, if known
    to_name: text().notNull(), // the textual name referenced
  },
  (table) => [
    index("symbol_reference_to_name_idx").on(table.to_name),
    index("symbol_reference_from_file_idx").on(table.from_file),
  ],
)
