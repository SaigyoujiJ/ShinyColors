/**
 * 双语翻译浮层 import/export 绑定回归测试
 *
 * 背景：transCoverHtml.js 的默认导出是 transCover，hideTransCover 是具名导出。
 * 曾出现 story.js 误用默认导入，导致 load 钩子里实际调用 transCover(undefined)。
 * 常规 A/B 验证会剥离 import 并注入同名 mock，覆盖不到这类绑定错误，
 * 因此本测试从真实源码解析 export 语句建立绑定，再按真实 import 语句解析绑定名，
 * 最后调用「实际绑定到的那个函数」验证行为。
 *
 * 运行：node script/verify-transcover-bindings.js
 */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const htmlSrc = read('src/utils/transCoverHtml.js')
const storySrc = read('src/modules/story.js')
const trackSrc = read('src/modules/story/trackStory.js')
const distSrc = read('dist/ShinyColors.user.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* ---------- 从真实源码建立 export 绑定 ---------- */
function buildHtmlModule() {
  const defaultName = /export default\s+([\w$]+)/.exec(htmlSrc)?.[1]
  const named = []
  for (const m of htmlSrc.matchAll(/export\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach((s) => { const t = s.trim(); if (t) named.push(t) })
  }

  // 只去掉 import/export 语法，函数体原样执行
  let code = htmlSrc.replace(/^import .*$/gm, '')
    .replace(/^export\s*\{[^}]+\}\s*$/gm, '')
    .replace(/^export default .*$/gm, '')
  code += `\nglobalThis.__exports = { default: ${defaultName}, named: { ${named.map((n) => `${n}: ${n}`).join(', ')} } };\n`

  class HTMLElement {}
  const classes = new Set(['hide'])
  const box = new HTMLElement()
  box.textContent = ''
  box.style = {}
  box.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c)
  }
  Object.defineProperty(box, 'className', { get: () => [...classes].join(' ') })

  const st = { boxExists: false, shows: [], errors: [], clears: 0 }
  let nextTimer = 1
  const clearInterval = () => { st.clears++ }
  const typewriterEffect = (text, b) => {
    st.shows.push(typeof text === 'string' ? text : `<${typeof text}>`)
    if (typeof text !== 'string') {
      st.errors.push('Typewriter Error: text must be a string.')
      const p = Promise.reject(new Error('text must be a string.'))
      p.catch(() => {})
      return p
    }
    if (!(b instanceof HTMLElement)) {
      st.errors.push('Typewriter Error: box must be an HTMLElement.')
      const p = Promise.reject(new Error('box must be an HTMLElement.'))
      p.catch(() => {})
      return p
    }
    if (b._typewriterTimerId) clearInterval(b._typewriterTimerId)
    b.textContent = ''
    if (!text.length) { delete b._typewriterTimerId; return Promise.resolve() }
    b.textContent = text
    b._typewriterTimerId = nextTimer++
    return Promise.resolve()
  }

  const sandbox = {
    console,
    HTMLElement,
    document: {
      body: { insertAdjacentHTML: () => { st.boxExists = true } },
      getElementById: () => (st.boxExists ? box : null)
    },
    window: { addEventListener() {}, innerHeight: 900, innerWidth: 1600 },
    debounce: (fn) => fn,
    clearInterval,
    typewriterEffect
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return { exports: sandbox.__exports, st, box, defaultName, named }
}

/* ---------- 解析真实 import 语句 ---------- */
function parseImport(src, spec) {
  const line = src.split('\n').find((l) => /^\s*import /.test(l) && l.includes(`from '${spec}'`))
  if (!line) return null
  const clause = /^\s*import\s+(.+?)\s+from/.exec(line)[1].trim()
  const namedMatch = /\{([^}]+)\}/.exec(clause)
  const defaultName = clause.startsWith('{') ? null : /^([\w$]+)\s*(?:,|$)/.exec(clause)?.[1] || null
  return {
    line: line.trim(),
    defaultName,
    named: namedMatch ? namedMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  }
}

const storyImport = parseImport(storySrc, '../utils/transCoverHtml')
const trackImport = parseImport(trackSrc, '../../utils/transCoverHtml')
const mod = buildHtmlModule()

console.log('=== V8 import/export 绑定回归测试（真实源码，不剥离绑定语义）===\n')

check('transCoverHtml.js 默认导出为 transCover', mod.defaultName === 'transCover', `实际: ${mod.defaultName}`)
check('transCoverHtml.js 具名导出包含 hideTransCover', mod.named.includes('hideTransCover'), `具名: ${mod.named.join(', ')}`)
check('默认导出与具名导出不是同一个函数', mod.exports.default !== mod.exports.named.hideTransCover)
check('story.js 使用具名导入 { hideTransCover }', !!storyImport && !storyImport.defaultName && storyImport.named.includes('hideTransCover'), storyImport && storyImport.line)
check('trackStory.js 的 hideTransCover 来自具名导入', !!trackImport && trackImport.named.includes('hideTransCover'), trackImport && trackImport.line)

/* ---------- 按真实绑定调用 load 钩子里的 hideTransCover ---------- */
const resolveBinding = (parsed, exports) => parsed.defaultName
  ? { kind: 'default', fn: exports.default }
  : { kind: 'named', fn: exports.named[parsed.named[0]] }

function runLoadCleanup(parsed) {
  // 绑定函数必须与运行它的 DOM context 来自同一次模块构建，
  // 否则 hideTransCover 会去另一个 context 里找浮层节点而直接返回。
  const m = buildHtmlModule()
  const binding = resolveBinding(parsed, m.exports)
  m.exports.default('你好')                 // 模拟已显示一句译文（打字机 timer 在跑）
  const before = {
    text: m.box.textContent,
    cls: m.box.className,
    clears: m.st.clears,
    shows: m.st.shows.join('|')
  }
  binding.fn()                              // story.js load 钩子里实际绑定到的函数
  return {
    kind: binding.kind,
    before,
    after: {
      text: m.box.textContent,
      cls: m.box.className,
      clears: m.st.clears,
      shows: m.st.shows.join('|'),
      errors: m.st.errors.slice()
    }
  }
}

const run = runLoadCleanup(storyImport)
console.log(`\n   实际绑定 kind=${run.kind}; load 清理前: ${JSON.stringify(run.before)}`)
console.log(`   load 清理后: ${JSON.stringify(run.after)}\n`)
check('load 清理后浮层文本被清空', run.after.text === '')
check('load 清理后浮层被真正隐藏（.hide）', run.after.cls.includes('hide'))
check('load 清理取消了打字机 timer', run.after.clears > run.before.clears)
check('load 清理未产生 typewriter 类型错误', run.after.errors.length === 0, run.after.errors.join('; '))

/* ---------- 自证：错误绑定必须被本测试判失败 ---------- */
const bad = runLoadCleanup({ defaultName: 'wrongImport', named: [] })
const caught = bad.after.text !== '' || !bad.after.cls.includes('hide') || bad.after.errors.length > 0
check('注入「默认导入」错误绑定时测试能判失败（自证有效性）', caught,
  `错误绑定结果: ${JSON.stringify(bad.after)}`)

/* ---------- 产物核对：清理函数确实被调用，且没有 transCover(undefined) ---------- */
const hideFnName = /(\w+)=\(\)=>\{const \w+=document\.getElementById\("sczh-trans-cover"\);\w+&&\(\w+\(""\).*?classList\.add\("hide"\)\)\}/.exec(distSrc)?.[1]
check('dist 中存在 hideTransCover 压缩函数', !!hideFnName, `函数名: ${hideFnName}`)
if (hideFnName) {
  const calls = distSrc.split(`${hideFnName}(`).length - 1
  check('dist 中清理函数在 track 与 load 两处被调用', calls >= 2, `出现次数: ${calls}`)
  const showFnName = /\w+&&\((\w+)\(""\)/.exec(distSrc)?.[1]
  check('dist 中显示函数未被无参调用（无 transCover(undefined)）',
    !!showFnName && !new RegExp(`\\b${showFnName}\\(\\)`).test(distSrc), `显示函数: ${showFnName}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== V8 合计 ${results.length} 项，失败 ${failed.length} 项 ===`)
process.exit(failed.length ? 1 : 0)
