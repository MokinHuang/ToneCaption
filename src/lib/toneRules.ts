/** 「可能在征求确认」文本规则：末尾小句切分 + 确认类模式 + 引用/转述抑制。
 *  纯函数、零依赖、仅可擦除 TS 语法，node:test 可直跑。
 *  自动标点（问号）绝不单独触发任何判断。 */

export interface TextToneMatch {
  hit: boolean
  /** 命中模式名（人类可读，进详情） */
  pattern: string | null
  /** 转写原词摘录，保证是 text 的子串 */
  excerpt: string | null
  suppressedBy: 'quoted' | 'reported-speech' | null
}

const TRAILING_PUNCT = /[”」』’"？?。.!！…~\s]+$/
const CLAUSE_DELIM = /[，,、；;：:。？?！!]/

const IMPERATIVE_BA =
  /(走|来|去|说|讲|看|听|写|读|唱|吃|喝|睡|坐|站|停|开始|结束|休息|下课|上课|做|干|办|试|等|散)吧$/
const ACHIEVEMENT_LE_BA = /(到|交|完|懂|够|会|明白|清楚|知道)了吧$/
const BARE_AGREEMENT_BA = /^(好|行|成)吧$/

const A_NOT_A =
  /(好不好|行不行|对不对|是不是|能不能|可不可以|可以不可以|有没有|会不会|要不要|用不用|来得及来不及|清楚不清楚|明白不明白|懂不懂|成不成|中不中)/
const A_NOT_A_GENERIC = /([是好行对能可会有要用懂记知清听看算够])不\1/
const A_NOT_A_TAIL = /(行不|好不|对不)$/
const LE_MEIYOU = /了没有$/

/** 转述框架：第三人称主语 +（间隔 ≤4 字）+ 问/说类动词。第一人称不抑制。 */
const REPORTED_SPEECH =
  /(他们|她们|他|她|老师|同学们|同学|有人|某人|[\u4e00-\u9fa5]{1,2}同学|[\u4e00-\u9fa5]{1,2}老师)[^，。]{0,4}?(问|说|问道|想知道|提到)/

const QUOTE_PAIRS: [string, string][] = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['‘', '’'],
  ['"', '"'],
]

/** 广义疑问线索（比确认模式宽，含特指问与问号），仅用于上下文"前句提过问"。 */
const QUESTION_CUE = /(吗|吧|呢|哪|什么|几|谁|怎么|多少|好不好|行不行|对不对|是不是|能不能|有没有|会不会|要不要|[？?])/

export function lastClause(text: string): { clause: string; start: number } {
  const stripped = text.replace(TRAILING_PUNCT, '')
  let cut = -1
  for (let i = stripped.length - 1; i >= 0; i--) {
    if (CLAUSE_DELIM.test(stripped[i])) {
      cut = i
      break
    }
  }
  return { clause: stripped.slice(cut + 1), start: cut + 1 }
}

function quotedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0
    for (;;) {
      const a = text.indexOf(open, from)
      if (a < 0) break
      const b = text.indexOf(close, a + open.length)
      if (b < 0) break
      ranges.push([a, b + close.length])
      from = b + close.length
    }
  }
  return ranges
}

interface PatternHit {
  name: string
  index: number
}

function matchClause(clause: string): PatternHit | null {
  if (/吗$/.test(clause)) {
    return { name: '句尾疑问词「吗」', index: clause.length - 1 }
  }
  if (/吧$/.test(clause)) {
    if (IMPERATIVE_BA.test(clause) || BARE_AGREEMENT_BA.test(clause)) return null
    if (/了吧$/.test(clause) && !ACHIEVEMENT_LE_BA.test(clause)) return null
    return { name: '句尾求证词「吧」', index: clause.length - 1 }
  }
  const le = LE_MEIYOU.exec(clause)
  if (le) return { name: '完成体正反问「了没有」', index: le.index }
  const en = A_NOT_A.exec(clause)
  if (en) return { name: `正反问「${en[0]}」`, index: en.index }
  const ge = A_NOT_A_GENERIC.exec(clause)
  if (ge) return { name: `正反问「${ge[0]}」`, index: ge.index }
  const ta = A_NOT_A_TAIL.exec(clause)
  if (ta) return { name: `句尾正反问「${ta[0]}」`, index: ta.index }
  return null
}

function makeExcerpt(text: string, clauseStart: number, clauseEnd: number, matchAbs: number): string {
  let start = Math.max(clauseStart, matchAbs - 6)
  if (clauseEnd - start > 14) start = clauseEnd - 14
  return text.slice(start, clauseEnd)
}

export function matchTextTone(text: string): TextToneMatch {
  const none: TextToneMatch = { hit: false, pattern: null, excerpt: null, suppressedBy: null }
  if (!text.trim()) return none
  const { clause, start } = lastClause(text)
  if (!clause) return none
  const hit = matchClause(clause)
  if (!hit) return none

  const abs = start + hit.index
  const clauseEnd = start + clause.length
  const inQuote = quotedRanges(text).some(([a, b]) => abs >= a && abs < b)
  if (inQuote) {
    return { hit: false, pattern: hit.name, excerpt: null, suppressedBy: 'quoted' }
  }
  if (REPORTED_SPEECH.test(clause.slice(0, hit.index))) {
    return { hit: false, pattern: hit.name, excerpt: null, suppressedBy: 'reported-speech' }
  }
  return {
    hit: true,
    pattern: hit.name,
    excerpt: makeExcerpt(text, start, clauseEnd, abs),
    suppressedBy: null,
  }
}

export function hasQuestionCue(text: string): boolean {
  return QUESTION_CUE.test(text)
}

/** 前句（最近优先）里找广义疑问，返回 ≤14 字的原词摘录。
 *  疑问线索看前句的末尾小句：转述句中段出现的「吗」不算前句提问。 */
export function findPrevQuestion(prevTexts: string[]): string | null {
  for (let i = prevTexts.length - 1; i >= 0; i--) {
    const t = prevTexts[i]
    if (!t) continue
    const { clause, start } = lastClause(t)
    if (clause && hasQuestionCue(clause)) {
      const end = start + clause.length
      return t.slice(Math.max(start, end - 14), end)
    }
  }
  return null
}

/** 当前句是否是简短附和/候选小句（上下文承接路径用）：≤10 字且无陈述尾标记。 */
export function isShortEchoClause(text: string): boolean {
  const { clause } = lastClause(text)
  return clause.length > 0 && clause.length <= 10 && !/[了的]$/.test(clause)
}