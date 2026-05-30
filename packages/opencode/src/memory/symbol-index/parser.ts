import ts from "typescript"

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "variable"

export interface ParsedSymbol {
  name: string
  kind: SymbolKind
  signature: string | null
  line: number // 1-indexed
  column: number // 1-indexed
  end_line: number
  exported: boolean
  is_async: boolean
  parent_name: string | null
  doc: string | null
}

export interface ParsedReference {
  from_line: number
  from_symbol_name: string | null // enclosing function/method name, if any
  to_name: string
}

export interface ParseResult {
  symbols: ParsedSymbol[]
  references: ParsedReference[]
}

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
}

export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase()
  if (!ext) return null
  if (ext in SCRIPT_KIND) return ext === "tsx" || ext === "jsx" ? ext : ext.startsWith("t") ? "typescript" : "javascript"
  return null
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return SCRIPT_KIND[ext] ?? ts.ScriptKind.TS
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node as ts.HasModifiers) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function hasAsyncModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node as ts.HasModifiers) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false
}

function leadingDoc(node: ts.Node, source: ts.SourceFile): string | null {
  const text = source.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart())
  if (!ranges?.length) return null
  // pick the closest JSDoc-style block comment
  const jsdoc = [...ranges].reverse().find((r) => text.substring(r.pos, r.pos + 3) === "/**")
  if (!jsdoc) return null
  return text
    .substring(jsdoc.pos, jsdoc.end)
    .split("\n")
    .map((l) => l.replace(/^\s*\/?\*+\/?\s?/, ""))
    .join("\n")
    .trim()
}

function signatureOf(node: ts.SignatureDeclaration, source: ts.SourceFile): string {
  const params = node.parameters.map((p) => p.getText(source)).join(", ")
  const ret = node.type ? `: ${node.type.getText(source)}` : ""
  return `(${params})${ret}`
}

function positionOf(node: ts.Node, source: ts.SourceFile) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source))
  const end = source.getLineAndCharacterOfPosition(node.getEnd())
  return {
    line: start.line + 1,
    column: start.character + 1,
    end_line: end.line + 1,
  }
}

export function parseSource(filePath: string, content: string): ParseResult {
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  )

  const symbols: ParsedSymbol[] = []
  const references: ParsedReference[] = []

  // Track the enclosing named declaration for reference attribution
  const enclosingStack: string[] = []

  function visit(node: ts.Node, parentClass: string | null) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const pos = positionOf(node, source)
      symbols.push({
        name: node.name.text,
        kind: "function",
        signature: signatureOf(node, source),
        ...pos,
        exported: hasExportModifier(node),
        is_async: hasAsyncModifier(node),
        parent_name: null,
        doc: leadingDoc(node, source),
      })
      enclosingStack.push(node.name.text)
      ts.forEachChild(node, (c) => visit(c, null))
      enclosingStack.pop()
      return
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const pos = positionOf(node, source)
      symbols.push({
        name: node.name.text,
        kind: "class",
        signature: null,
        ...pos,
        exported: hasExportModifier(node),
        is_async: false,
        parent_name: null,
        doc: leadingDoc(node, source),
      })
      const className = node.name.text
      enclosingStack.push(className)
      ts.forEachChild(node, (c) => visit(c, className))
      enclosingStack.pop()
      return
    }

    if (ts.isInterfaceDeclaration(node)) {
      const pos = positionOf(node, source)
      symbols.push({
        name: node.name.text,
        kind: "interface",
        signature: null,
        ...pos,
        exported: hasExportModifier(node),
        is_async: false,
        parent_name: null,
        doc: leadingDoc(node, source),
      })
      return
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const pos = positionOf(node, source)
      symbols.push({
        name: node.name.text,
        kind: "type",
        signature: node.type.getText(source).slice(0, 200),
        ...pos,
        exported: hasExportModifier(node),
        is_async: false,
        parent_name: null,
        doc: leadingDoc(node, source),
      })
      return
    }

    if (ts.isEnumDeclaration(node)) {
      const pos = positionOf(node, source)
      symbols.push({
        name: node.name.text,
        kind: "enum",
        signature: null,
        ...pos,
        exported: hasExportModifier(node),
        is_async: false,
        parent_name: null,
        doc: leadingDoc(node, source),
      })
      return
    }

    if (ts.isMethodDeclaration(node) && parentClass && ts.isIdentifier(node.name)) {
      const pos = positionOf(node, source)
      symbols.push({
        name: node.name.text,
        kind: "method",
        signature: signatureOf(node, source),
        ...pos,
        exported: false,
        is_async: hasAsyncModifier(node),
        parent_name: parentClass,
        doc: leadingDoc(node, source),
      })
      enclosingStack.push(`${parentClass}.${node.name.text}`)
      ts.forEachChild(node, (c) => visit(c, parentClass))
      enclosingStack.pop()
      return
    }

    // top-level `const foo = () => ...` style functions
    if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node)
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const init = decl.initializer
        const isFnLike = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        const pos = positionOf(decl, source)
        symbols.push({
          name: decl.name.text,
          kind: isFnLike ? "function" : "variable",
          signature: isFnLike ? signatureOf(init, source) : null,
          ...pos,
          exported,
          is_async: isFnLike ? hasAsyncModifier(init) : false,
          parent_name: null,
          doc: leadingDoc(node, source),
        })
        if (isFnLike) {
          enclosingStack.push(decl.name.text)
          ts.forEachChild(init, (c) => visit(c, null))
          enclosingStack.pop()
        }
      }
      return
    }

    // Reference extraction: any call expression with a resolvable head name
    if (ts.isCallExpression(node)) {
      const name = callTargetName(node.expression)
      if (name) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        references.push({
          from_line: line + 1,
          from_symbol_name: enclosingStack.at(-1) ?? null,
          to_name: name,
        })
      }
    }

    ts.forEachChild(node, (c) => visit(c, parentClass))
  }

  ts.forEachChild(source, (c) => visit(c, null))

  return { symbols, references }
}

function callTargetName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  return null
}
