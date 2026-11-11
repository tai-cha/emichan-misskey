import * as mfm from 'mfm-js'
import { tokenizeSync } from "@enjoyjs/node-mecab"
import Config from '@/utils/config.js'

// load env
Config

// 次トークンを決めるときに参照する直前トークン数の最大値
const MAX_MATCH_LENGTH = 4
const MIN_TOKEN_LENGTH = 3
// 生成が終わらない場合の打ち切り長
const MAX_TOKEN_LENGTH = 80
const emojiRegex = /:[0-9A-z_\-]+:/

const match_length = (): number => {
  const n = 5
  const m = 8.0
  const min = 1
  //なんかいい感じの重み付きランダムみたいなあれを作る
  //sample: https://www.geogebra.org/graphing/kne365xj
  return Math.floor((MAX_MATCH_LENGTH - min) * Math.round(n * 2 * (Math.atan(m * Math.random())) / Math.PI) / n) + min
}

// 除去した要素の位置を示す。ここをまたぐトークンの繋がりは学習しない
export type GapNode = { type: 'gap' }
export type SanitizedNode = mfm.MfmText | mfm.MfmUnicodeEmoji | mfm.MfmEmojiCode | GapNode

const GAP: GapNode = { type: 'gap' }
const LINE_BREAK: mfm.MfmText = { type: 'text', props: { text: '\n' } }

// $[ruby 漢字 かんじ] の親文字(漢字)を取り出す
function rubyBase(node: mfm.MfmFn): Array<SanitizedNode> {
  const [child] = node.children
  if (node.children.length !== 1 || child.type !== 'text') return [GAP]
  const base = child.props.text.split(' ')[0]
  return base ? [{ type: 'text', props: { text: base } }] : [GAP]
}

function sanitizeNode(node: mfm.MfmNode): Array<SanitizedNode> {
  switch (node.type) {
    case 'text':
    case 'unicodeEmoji':
    case 'emojiCode':
      return [node]
    // 文中から取り除くもの
    case 'url':
    case 'mention':
    case 'hashtag':
    case 'inlineCode':
    case 'mathInline':
    // MFM記法がそのまま含まれうるため除去する
    case 'plain':
      return [GAP]
    // 取り除くブロック。パーサーが前後の改行を吸収するため、改行として扱う
    case 'blockCode':
    case 'mathBlock':
    case 'search':
      return [LINE_BREAK]
    case 'quote':
    case 'center':
      return [LINE_BREAK, ...node.children.flatMap(sanitizeNode), LINE_BREAK]
    case 'fn':
      if (node.props.name === 'ruby') return rubyBase(node)
      return node.children.flatMap(sanitizeNode)
    // bold, small, italic, strike, link(表示テキスト)
    default:
      return node.children.flatMap(sanitizeNode)
  }
}

export function sanitize(nodes: Array<mfm.MfmNode>): Array<SanitizedNode> {
  return nodes.flatMap(sanitizeNode)
}

export type EmiToken = {
  id: number | undefined,
  surface: string,
  feature: {
    pos: string,
    [key: string]: any
  },
  [key: string]: any
}

const BOS_TOKEN: EmiToken = { surface: 'BOS', feature: { pos: 'BOS/EOS' }, id: undefined }
const EOS_TOKEN: EmiToken = { surface: 'EOS', feature: { pos: 'BOS/EOS' }, id: undefined }

const isBoundary = (t: EmiToken) => t.feature.pos === 'BOS/EOS'
const isBOS = (t: EmiToken) => isBoundary(t) && t.surface === 'BOS'
const isEOS = (t: EmiToken) => isBoundary(t) && t.surface === 'EOS'
const GAP_TOKEN: EmiToken = { surface: 'GAP', feature: { pos: 'GAP' }, id: undefined }
const isGap = (t: EmiToken) => t.feature.pos === 'GAP'

// 行頭・行末のGAPと連続するGAPを取り除く
function trimGaps(line: Array<EmiToken>): Array<EmiToken> {
  const result = line.filter((t, i) => !isGap(t) || (i > 0 && !isGap(line[i - 1])))
  while (result.length > 0 && isGap(result[0])) result.shift()
  while (result.length > 0 && isGap(result[result.length - 1])) result.pop()
  return result
}

function mecab(text: string): Array<EmiToken> {
  let options = {}
  if (Config.mecabDicDir) options = { ...options, dicdir: Config.mecabDicDir }
  // MeCabが付与するBOS/EOSは除き、文の区切りはtokenize側で管理する
  return (tokenizeSync(text, options).flat() as unknown as EmiToken[])
    .filter(t => !isBoundary(t) && t.surface !== '')
}

// 改行ごとに BOS ... EOS で囲んだトークン列を返す
// MFMノードの境界では文を区切らず、連続するテキストはまとめて解析する
// 除去された要素の位置には GAP トークンが入る
export function tokenize(nodes: Array<SanitizedNode>): Array<EmiToken> {
  const lines: Array<Array<EmiToken>> = [[]]
  let buffer = ''
  const flush = () => {
    if (buffer.trim() !== '') lines[lines.length - 1].push(...mecab(buffer))
    buffer = ''
  }

  for (const node of nodes) {
    if (node.type == 'text') {
      node.props.text.split('\n').forEach((part, i) => {
        if (i > 0) {
          flush()
          lines.push([])
        }
        buffer += part
      })
    } else if (node.type == 'unicodeEmoji') {
      flush()
      lines[lines.length - 1].push({ surface: node.props.emoji, feature: { pos: '絵文字' }, id: undefined })
    } else if (node.type == 'emojiCode') {
      flush()
      lines[lines.length - 1].push({ surface: `:${node.props.name}:`, feature: { pos: '絵文字' }, id: undefined })
    } else if (node.type == 'gap') {
      flush()
      lines[lines.length - 1].push(GAP_TOKEN)
    }
  }
  flush()

  return lines.map(trimGaps).filter(line => line.length > 0).flatMap(line => [BOS_TOKEN, ...line, EOS_TOKEN])
}

// BOS ... EOS 単位に分割する
function splitSentences(tokens: Array<EmiToken>): Array<Array<EmiToken>> {
  const sentences: Array<Array<EmiToken>> = []
  let current: Array<EmiToken> = []
  for (const t of tokens) {
    if (isBOS(t)) current = []
    current.push(t)
    if (isEOS(t)) sentences.push(current)
  }
  return sentences
}

// 表層形が"BOS"/"EOS"の通常の単語と区別するため、境界トークンには印を付ける
const tokenKey = (t: EmiToken) => isBoundary(t) ? `\u0001${t.surface}` : t.surface
const contextKey = (tokens: Array<EmiToken>) => tokens.map(tokenKey).join('\u0000')

type Candidates = Map<string, { token: EmiToken, count: number }>

function weightedPick(candidates: Array<{ token: EmiToken, count: number }>): EmiToken {
  const total = candidates.reduce((sum, c) => sum + c.count, 0)
  let r = Math.random() * total
  for (const c of candidates) {
    r -= c.count
    if (r < 0) return c.token
  }
  return candidates[candidates.length - 1].token
}

// 直前 1〜maxOrder トークンを文脈とし、次に来るトークンの出現回数を保持する
export class NgramModel {
  private readonly table = new Map<string, Candidates>()

  constructor(readonly maxOrder: number = MAX_MATCH_LENGTH) { }

  // sentence は BOS で始まり EOS で終わるトークン列
  addSentence(sentence: Array<EmiToken>) {
    for (let i = 1; i < sentence.length; i++) {
      const next = sentence[i]
      if (isGap(next)) continue
      for (let n = 1; n <= this.maxOrder && i - n >= 0; n++) {
        // GAPをまたぐ文脈は学習しない(これより長い文脈も同様)
        if (isGap(sentence[i - n])) break
        const key = contextKey(sentence.slice(i - n, i))
        let candidates = this.table.get(key)
        if (!candidates) {
          candidates = new Map()
          this.table.set(key, candidates)
        }
        const entry = candidates.get(tokenKey(next))
        if (entry) entry.count += 1
        else candidates.set(tokenKey(next), { token: next, count: 1 })
      }
    }
  }

  // 長い文脈から順に候補を探し、なければ短い文脈にバックオフする
  // accept で候補を絞り込み、残らなければさらに短い文脈を試す
  next(context: Array<EmiToken>, accept: (t: EmiToken) => boolean = () => true): EmiToken | null {
    for (let n = Math.min(this.maxOrder, context.length); n >= 1; n--) {
      const candidates = this.table.get(contextKey(context.slice(-n)))
      if (!candidates) continue
      const accepted = [...candidates.values()].filter(c => accept(c.token))
      if (accepted.length > 0) return weightedPick(accepted)
    }
    return null
  }
}

export function buildModel(textInputs: Array<string>): NgramModel {
  const model = new NgramModel()
  textInputs
    .filter(i => !i.match(/^[0-9A-z\n ]+$/))
    .forEach(txt => splitSentences(tokenize(sanitize(mfm.parse(txt)))).forEach(s => model.addSentence(s)))
  return model
}

const BRACKET_PAIRS = new Map([
  ['「', '」'], ['『', '』'], ['【', '】'], ['（', '）'], ['［', '］'], ['｛', '｝'],
  ['〈', '〉'], ['《', '》'], ['(', ')'], ['[', ']'], ['{', '}'],
])
const CLOSING_BRACKETS = new Map([...BRACKET_PAIRS].map(([open, close]) => [close, open]))

// 未対応の開き括弧のスタックを text の分だけ進める。対応しない閉じ括弧があれば null
export function updateBrackets(stack: ReadonlyArray<string>, text: string): Array<string> | null {
  const next = [...stack]
  for (const ch of text) {
    if (BRACKET_PAIRS.has(ch)) {
      next.push(ch)
    } else if (CLOSING_BRACKETS.has(ch)) {
      if (next[next.length - 1] !== CLOSING_BRACKETS.get(ch)) return null
      next.pop()
    }
  }
  return next
}

const isBalanced = (text: string) => updateBrackets([], text)?.length === 0

// BOS から EOS まで生成する。終端に到達できなかった場合は null
export function generate(model: NgramModel): Array<EmiToken> | null {
  const tokens: Array<EmiToken> = [BOS_TOKEN]
  let brackets: Array<string> = []
  // 閉じ括弧は対応する開き括弧があるときのみ、EOSは括弧がすべて閉じているときのみ許可する
  const acceptBrackets = (t: EmiToken) => isEOS(t) ? brackets.length === 0 : updateBrackets(brackets, t.surface) !== null

  // 助詞から始まるのは不自然なので避ける
  const first = model.next(tokens, t => t.feature.pos !== '助詞' && !isEOS(t) && acceptBrackets(t))
  if (!first) return null
  tokens.push(first)
  brackets = updateBrackets(brackets, first.surface)!

  while (tokens.length < MAX_TOKEN_LENGTH) {
    const next = model.next(tokens.slice(-match_length()), acceptBrackets)
    if (!next) return null
    tokens.push(next)
    if (isEOS(next)) return tokens
    brackets = updateBrackets(brackets, next.surface)!
  }
  return null
}

export function tokensToString(tokens: Array<EmiToken>): string {
  const words = tokens.filter(t => !isBoundary(t))
  return words.map((word, i) => {
    const prev = words[i - 1]
    if (prev?.surface.match(emojiRegex) && word.surface.match(/^[0-9A-z]+.*/)) {
      return `𝅳${word.surface}`
    }
    if (prev?.surface.match(/^[0-9A-z.!]{2,}/) && word.surface.match(/^[0-9A-z.!]+/)) {
      // English
      return ` ${word.surface}`
    }
    return word.surface
  }).join('')
}

export function createTextFromInputs(textInputs: Array<string>) {
  const model = buildModel(textInputs)
  const minimum = MIN_TOKEN_LENGTH + Math.floor(Math.random() * 5)

  for (let retry_count = 0; retry_count <= 100; retry_count++) {
    const tokens = generate(model)
    if (!tokens) continue
    const result = tokensToString(tokens)
    const wordCount = tokens.filter(t => !isBoundary(t)).length
    if (result.length < 5 || wordCount < minimum || !isBalanced(result)) continue
    if (textInputs.includes(result)) {
      console.debug('同じ文章が生成されたため再試行します。')
      continue
    }
    return result
  }
  console.warn('Text generation retry limit exceeded.')
  return ''
}
