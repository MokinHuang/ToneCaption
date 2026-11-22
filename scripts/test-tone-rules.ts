import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchTextTone,
  lastClause,
  hasQuestionCue,
  findPrevQuestion,
  isShortEchoClause,
} from '../src/lib/toneRules.ts'

const hit = (text: string) => {
  const m = matchTextTone(text)
  assert.equal(m.hit, true, `应命中: ${text}`)
  assert.ok(m.pattern, '应有模式名')
  assert.ok(m.excerpt && text.includes(m.excerpt), `摘录必须是原词子串: ${m.excerpt}`)
  assert.equal(m.suppressedBy, null)
  return m
}
const none = (text: string) => {
  const m = matchTextTone(text)
  assert.equal(m.hit, false, `不应命中: ${text}（${m.pattern}）`)
  return m
}
const suppressed = (text: string, by: 'quoted' | 'reported-speech') => {
  const m = matchTextTone(text)
  assert.equal(m.hit, false, `应被抑制: ${text}`)
  assert.equal(m.suppressedBy, by)
  return m
}

test('验收案例2：平静疑问句凭原词命中（不依赖问号）', () => {
  const m = hit('改到下周一交，大家能接受吗？')
  assert.equal(m.excerpt, '大家能接受吗')
  hit('改到下周一交，大家能接受吗。')
})

test('验收案例1：平静陈述只出字幕', () => {
  none('实验报告改到下周一交。')
  none('今天讲二叉树。')
})

test('验收案例3：转述引用不触发', () => {
  none('他刚才问的是‘可以吗’，我们接着往下讲。')
  suppressed('他刚才问的是“可以吗”', 'quoted')
  suppressed('他刚才问的是可以吗', 'reported-speech')
})

test('句尾「吗」命中', () => {
  hit('这个公式懂了吗')
  hit('这样可以吗')
})

test('句尾「吧」求证命中，祈使/评论/附和排除', () => {
  hit('这样安排大家没问题吧')
  hit('你是三班的吧')
  hit('大家都到了吧')
  hit('时间够了吧')
  hit('对吧')
  none('我们走吧')
  none('开始吧')
  none('休息吧')
  none('太晚了吧')
  none('好吧')
  none('行吧')
})

test('正反问命中（枚举/通用/完成体/句尾短式）', () => {
  hit('能不能提前交？')
  hit('是不是周五交')
  hit('可不可以用计算器')
  hit('大家听懂了没有')
  hit('这样算不算迟到')
  hit('这样行不')
  hit('我说这样行不行')
})

test('正反问误报防护', () => {
  none('我不是说不可以')
  none('对不起，我来晚了')
  none('这个办法行不通')
  none('他好不容易才做完')
})

test('模式必须在末尾小句', () => {
  none('你知道吗，这题很难')
  none('他问能不能提前，我们接着往下讲')
  none('好不好先放一边，我们看下一题')
})

test('自动问号绝不单独触发', () => {
  none('这周五交？')
  none('这周五交?')
  none('明天开会？')
})

test('第三人称转述抑制，第一人称不抑制', () => {
  suppressed('他问能不能提前', 'reported-speech')
  suppressed('有人问这样行不行', 'reported-speech')
  suppressed('他说明天要不要补课', 'reported-speech')
  suppressed('老师说“能不能提前交”', 'quoted')
  none('老师说“能不能提前交”，我们接着往下讲')
  hit('我说这样行不行')
  hit('大家说说这样好不好')
})

test('引号内模式抑制', () => {
  suppressed('他念了一句「大家能接受吗」', 'quoted')
  suppressed('黑板上写着“可以吗”', 'quoted')
})

test('空文本与无关句', () => {
  none('')
  none('   ')
  none('好，我们看下一题')
  none('大家觉得哪天合适？')
})

test('lastClause 切分', () => {
  assert.deepEqual(lastClause('改到下周一交，大家能接受吗？'), {
    clause: '大家能接受吗',
    start: 7,
  })
  assert.equal(lastClause('这周五交').clause, '这周五交')
})

test('上下文疑问线索与短句判定', () => {
  assert.equal(hasQuestionCue('大家觉得哪天合适？'), true)
  assert.equal(hasQuestionCue('大家能接受吗'), true)
  assert.equal(hasQuestionCue('实验报告改到下周一交。'), false)
  assert.equal(findPrevQuestion(['今天讲二叉树。', '大家觉得哪天合适？']), '大家觉得哪天合适')
  assert.equal(findPrevQuestion(['今天讲二叉树。']), null)
  assert.equal(findPrevQuestion(['他刚才问的是可以吗，我们接着往下讲']), null)
  assert.equal(findPrevQuestion(['你知道吗，这题很难']), null)
  assert.equal(isShortEchoClause('这周五交'), true)
  assert.equal(isShortEchoClause('这周五交了'), false)
  assert.equal(isShortEchoClause('这个实验报告改到下周一再交'), false)
})

test('所有命中用例摘录均为原词子串（批量）', () => {
  const texts = [
    '这样安排大家没问题吧',
    '这个公式懂了吗',
    '能不能提前交？',
    '大家听懂了没有',
    '是不是周五交',
    '你是三班的吧',
    '大家都到了吧',
    '我说这样行不行',
    '可不可以用计算器',
    '改到下周一交，大家能接受吗？',
    '这样算不算迟到',
    '这样行不',
  ]
  for (const t of texts) hit(t)
})