// What the window sends the sidecar and reads back is typed from the
// sidecar's schema (lib/api.gen.ts, `npm run gen:api`), so a field
// renamed in Python fails the type-check. A type written by hand for
// a request or an answer would not: this check fails on one.
//
// It reads the modules that talk to the sidecar and fails on any type
// in them that is not built from the generated ones: a declared type,
// a cast, a `satisfies`, a call's type argument. Built from means made
// of `Schema<...>`, `Answer<...>`, `BodyOf<...>` (or the generated
// `components`/`paths`), types of the module that are themselves
// checked, and type helpers over those (`Pick`, `Omit`, ...), with
// string literals only as keys. A primitive (`string`, `number`), an
// index signature or a literal value type is a shape written by hand.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..')

/** The modules that read the sidecar's answers or send it bodies. */
const WIRE_MODULES = [
  'renderer/src/lib/api.ts',
  'renderer/src/lib/eventStream.ts',
  'electron/renderLoop.ts'
]

/** Modules that call `fetch` or the sidecar and read no answer of it. */
const READS_NO_ANSWER: Record<string, string> = {
  'electron/sidecar.ts':
    'sidecarFetch itself; it reads `/health` as unknown on purpose: the port may be held by another program or an older sidecar',
  'electron/main.ts':
    'its fetch is the F-list image CDN; its sidecarFetch (sign-out at quit) reads nothing back',
  'electron/appPage.ts': "net.fetch of the app's own files"
}

/** Types that read the generated ones: what an operation answers or
 *  takes. They are the means, not a wire type. */
const READERS: Record<string, string> = {
  Schema: 'a model of the schema, by name',
  Method: 'the HTTP methods a path may serve',
  MethodOf: 'the methods a path serves',
  Operation: 'one operation of a path',
  JsonOf: "a response's or body's JSON",
  Answer: 'what an operation answers when ok',
  BodyOf: 'the JSON body an operation takes',
  Route: 'the paths that serve a method',
  AnswerAt: '`Answer` for a method the caller has already checked',
  BodyAt: '`BodyOf` for a method the caller has already checked',
  ParamsAt: "an operation's path and query parameters",
  Fill: "what a call fills in of its route, from the route's operation",
  EventTable: "a handler per event of a stream, from its events model's names and data"
}

/** Types in the wire modules that are no request or answer. */
const NOT_WIRE: Record<string, string> = {
  ApiOptions: 'how a call is made (its abort signal)',
  SendInit: 'how a call is sent (method, headers)',
  WindowCreds: "the preload bridge's keychain, not the sidecar"
}

/** Shapes the schema passes through as a free-form object, because
 *  they are F-list's (or the app's) and not the sidecar's. */
const PASS_THROUGH: Record<string, string> = {
  ForeignProfilePayload:
    "F-list's character-data payload; the schema types a Foreign profile's `profile` as `dict[str, Any]`",
  InlinesManifest:
    "F-list's inline images by id, the BBCode converter's type; the schema passes `inlines` through as `dict[str, Any]`",
  RenderTheme:
    "the preview's three themes; the sidecar passes on whatever theme name an MCP tool was given"
}

const GENERATED = new Set(['Schema', 'Answer', 'BodyOf', 'components', 'paths'])
const HELPERS = new Set([
  'Pick',
  'Omit',
  'Partial',
  'Required',
  'NonNullable',
  'Extract',
  'Exclude',
  'Parameters',
  'Readonly',
  'ReadonlyArray',
  'Array',
  'Promise'
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'test' ? [] : sources(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join('/')
}

function parse(module: string): ts.SourceFile {
  const text = readFileSync(join(ROOT, module), 'utf-8')
  return ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** What a module may name in a wire type besides the generated types:
 *  its own checked types, classes, type parameters, the allowlisted
 *  types, and types imported from the generated module or api.ts. */
function knownNames(file: ts.SourceFile): Set<string> {
  const names = new Set([
    ...Object.keys(NOT_WIRE),
    ...Object.keys(PASS_THROUGH),
    ...Object.keys(READERS)
  ])
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text)
    }
    if (ts.isTypeParameterDeclaration(node)) names.add(node.name.text)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text
      const bindings = node.importClause?.namedBindings
      if (/(^|\/)(api|api\.gen|schema)$/.test(from) && bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) names.add(el.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

/** Why `type` is not built from the generated types, or null. */
function handWritten(type: ts.TypeNode, known: Set<string>, asKey = false): string | null {
  const check = (t: ts.TypeNode, key = false) => handWritten(t, known, key)
  const first = (types: readonly ts.TypeNode[], key = false) => {
    for (const t of types) {
      const why = check(t, key)
      if (why) return why
    }
    return null
  }
  if (ts.isParenthesizedTypeNode(type)) return check(type.type, asKey)
  if (ts.isLiteralTypeNode(type)) return asKey ? null : `literal ${type.getText()}`
  if (ts.isTypeReferenceNode(type)) {
    const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.getText()
    if (name === 'const') return null
    if (!GENERATED.has(name) && !HELPERS.has(name) && !known.has(name)) return `type ${name}`
    // Type arguments name keys (`Pick<X, 'a'>`, `Schema<'Name'>`).
    return first(type.typeArguments ?? [], true)
  }
  if (ts.isIndexedAccessTypeNode(type)) return check(type.objectType) ?? check(type.indexType, true)
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return first(type.types, asKey)
  if (ts.isArrayTypeNode(type)) return check(type.elementType)
  if (ts.isTypeOperatorNode(type)) return check(type.type)
  if (ts.isFunctionTypeNode(type)) {
    for (const p of type.parameters) {
      const why = p.type ? check(p.type) : null
      if (why) return why
    }
    return type.type.kind === ts.SyntaxKind.VoidKeyword ? null : check(type.type)
  }
  if (ts.isTypeLiteralNode(type)) {
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.type) return `member ${member.getText()}`
      const why = check(member.type)
      if (why) return why
    }
    return null
  }
  return type.getText()
}

/** Every type in `module` written by hand for the wire, as
 *  `<module>: <where>: <why>`. */
function handWrittenTypes(module: string): string[] {
  const file = parse(module)
  const known = knownNames(file)
  const found: string[] = []
  const report = (where: string, type: ts.TypeNode | undefined) => {
    const why = type ? handWritten(type, known) : 'no type'
    if (why) found.push(`${module}: ${where}: ${why}`)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text
      if (!(name in READERS) && !(name in NOT_WIRE) && !(name in PASS_THROUGH))
        report(`type ${name}`, node.type)
      return
    }
    if (ts.isInterfaceDeclaration(node)) {
      found.push(`${module}: interface ${node.name.text}: write a type of the generated ones`)
      return
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      report(`${node.getText().slice(0, 60)}`, node.type)
    }
    if (ts.isCallExpression(node)) {
      for (const arg of node.typeArguments ?? []) report(`${node.expression.getText()}<...>`, arg)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Every `JSON.stringify(...)` in api.ts whose body is not typed by
 *  its route's request model: a `satisfies BodyOf<...>`, or a
 *  parameter declared as one. */
function untypedBodies(): string[] {
  const file = parse('renderer/src/lib/api.ts')
  const found: string[] = []
  const isBodyOf = (type: ts.TypeNode | undefined) =>
    !!type && ts.isTypeReferenceNode(type) && ['BodyOf', 'BodyAt'].includes(type.typeName.getText())
  const paramType = (node: ts.Node, name: string): ts.TypeNode | undefined => {
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      if (ts.isArrowFunction(at) || ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at)) {
        const param = at.parameters.find((p) => p.name.getText() === name)
        if (param) return param.type
      }
    }
    return undefined
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'JSON.stringify') {
      const arg = node.arguments[0]
      const typed =
        (ts.isSatisfiesExpression(arg) && isBodyOf(arg.type)) ||
        (ts.isIdentifier(arg) && isBodyOf(paramType(node, arg.text)))
      if (!typed)
        found.push(
          `line ${file.getLineAndCharacterOfPosition(node.pos).line + 1}: ${node.getText()}`
        )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

it('checks every module that talks to the sidecar', () => {
  const calling = [join(ROOT, 'renderer', 'src'), join(ROOT, 'electron')]
    .flatMap(sources)
    .filter((path) =>
      /\b(fetch|sidecarFetch)\(|new EventSource\(/.test(readFileSync(path, 'utf-8'))
    )
    .map(rel)
    .sort()

  // eventStream.ts reads the change hints through api.ts: checked,
  // though it calls nothing itself.
  expect(calling).toEqual(
    [...WIRE_MODULES, ...Object.keys(READS_NO_ANSWER)]
      .filter((module) => module !== 'renderer/src/lib/eventStream.ts')
      .sort()
  )
})

it('types every request and answer from the sidecar schema', () => {
  expect(WIRE_MODULES.flatMap(handWrittenTypes)).toEqual([])
})

it('types every JSON body the window sends by its route', () => {
  expect(untypedBodies()).toEqual([])
})

it('catches a wire type written by hand', () => {
  const file = ts.createSourceFile(
    'probe.ts',
    "type Pulled = { name: string }\ntype Kept = Pick<Schema<'Backup'>, 'filename'>",
    ts.ScriptTarget.Latest,
    true
  )
  const [pulled, kept] = file.statements as unknown as ts.TypeAliasDeclaration[]
  const known = knownNames(file)

  expect(handWritten(pulled.type, known)).toBe('string')
  expect(handWritten(kept.type, known)).toBeNull()
})
