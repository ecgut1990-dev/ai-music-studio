// Translation check (see docs/TRANSLATING.md). Collects every text the app shows through tr()/trf(): literal
// arguments (also inside ?: and ||), toolbarBtn labels, label: / hint: / desc: values and the effect label maps,
// then lists per language which of them have no translation in src/renderer/src/i18n/ui/<lang>.json.
//   node scripts/i18n-check.cjs            counts per language
//   node scripts/i18n-check.cjs de         the missing texts of one language, as JSON (add them to de.json)
const ts = require(require.resolve('typescript', { paths: [process.cwd()] }))
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '../src/renderer/src')
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'i18n' ? [] : walk(path.join(d, e.name))) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(d, e.name)] : [])
const files = walk(root), out = new Set()
const lits = (n) => {
  if (!n) return
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.add(n.text)
  else if (ts.isConditionalExpression(n)) { lits(n.whenTrue); lits(n.whenFalse) }
  else if (ts.isBinaryExpression(n)) { lits(n.left); lits(n.right) }
  else if (ts.isParenthesizedExpression(n)) lits(n.expression)
}
for (const f of files) {
  const src = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(src)
      if (name === 'tr' || name === 'trf') lits(n.arguments[0])
      if (name === 'toolbarBtn') { lits(n.arguments[0]); lits(n.arguments[1]) }
    }
    if (ts.isPropertyAssignment(n) && ['label', 'hint', 'desc'].includes(n.name.getText(src)) && (ts.isStringLiteral(n.initializer))) out.add(n.initializer.text)
    if (ts.isVariableDeclaration(n) && /^(SLOT_LABEL|INSERT_LABEL)$/.test(n.name.getText(src)) && n.initializer && ts.isObjectLiteralExpression(n.initializer))
      for (const p of n.initializer.properties) if (ts.isPropertyAssignment(p)) lits(p.initializer)
    ts.forEachChild(n, visit)
  }
  visit(src)
}
const fold = (s) => s.replace(/\s+/g, ' ')
const keys = [...new Set([...out].map(fold))].filter((k) => /[A-Za-z]/.test(k)).sort()
const ui = path.join(root, 'i18n/ui')
const table = (lang) => Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ui, lang + '.json'), 'utf8'))).map(([k, v]) => [fold(k), v]))
const want = process.argv[2]
if (want) {
  const t = table(want)
  console.log(JSON.stringify(keys.filter((k) => !(k in t)), null, 1))
} else {
  console.log(keys.length, 'texts in the code')
  for (const f of fs.readdirSync(ui).filter((n) => n.endsWith('.json'))) {
    const t = table(f.slice(0, -5))
    console.log(f.slice(0, -5), keys.filter((k) => k in t).length, 'translated,', keys.filter((k) => !(k in t)).length, 'missing (names and units stay English on purpose)')
  }
}
