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

// 候補を集める数と、そのための最大試行回数
const CANDIDATE_COUNT = 30
const MAX_ATTEMPTS = 300
// 長い文脈で見つからず短い文脈に落ちるたびに確率へ掛ける係数 (Stupid Backoff)
const BACKOFF_PENALTY = 0.4
// 元の1文からそのまま使った部分の割合がこれを超えるとペナルティ
const COPY_TOLERANCE = 0.7
const COPY_PENALTY = 4
// 同じ3トークン列が繰り返されるごとのペナルティ (「〜ですが、〜ですが、」のようなループ対策)
const REPEAT_NGRAM = 3
const REPEAT_PENALTY = 0.5
// 元の文の長さ(トークン数)のこの分位点を超える長さの候補を減点する
const LENGTH_LIMIT_PERCENTILE = 0.9
const LENGTH_PENALTY = 2.0
// 候補選択の温度。高いほどスコアの低い候補も選ばれやすくなる
const SELECTION_TEMPERATURE = 0.3

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

// 複数のテキストをまとめて1回のMeCab呼び出しで解析する (呼び出しごとにプロセスが起動するため)
// MeCabは入力を1行ずつ独立に解析するので、改行を含まないテキストを改行で連結しても結果は変わらない
function mecabBatch(texts: Array<string>): Array<Array<EmiToken>> {
  if (texts.length === 0) return []
  if (texts.some(t => /[\r\n]/.test(t))) throw new Error('mecabBatch: text must not contain line breaks')
  let options = {}
  if (Config.mecabDicDir) options = { ...options, dicdir: Config.mecabDicDir }
  const raw = tokenizeSync(texts.join('\n'), options) as unknown as EmiToken[]

  // 出力は1行ごとに BOS ... EOS で区切られている
  const results: Array<Array<EmiToken>> = []
  let current: Array<EmiToken> | null = null
  for (const t of raw) {
    if (isBOS(t)) current = []
    else if (isEOS(t)) {
      if (current) results.push(current)
      current = null
    } else if (current && t.surface !== '') current.push(t)
  }
  if (results.length !== texts.length) {
    throw new Error(`mecabBatch: expected ${texts.length} results but got ${results.length}`)
  }
  return results
}

// 解析待ちのテキスト断片の位置を示す
type Pending = { pending: number }
type Line = Array<EmiToken | Pending>

// 改行ごとに区切った行を作る。MeCabで解析するテキスト断片は segments に追加し、その位置を Pending で示す
// MFMノードの境界では文を区切らず、連続するテキストはまとめて1つの断片にする
function splitLines(nodes: Array<SanitizedNode>, segments: Array<string>): Array<Line> {
  const lines: Array<Line> = [[]]
  let buffer = ''
  const flush = () => {
    if (buffer.trim() !== '') {
      lines[lines.length - 1].push({ pending: segments.length })
      segments.push(buffer)
    }
    buffer = ''
  }

  for (const node of nodes) {
    if (node.type == 'text') {
      node.props.text.split(/\r?\n/).forEach((part, i) => {
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
  return lines
}

// 複数の文章をまとめて解析し、それぞれ改行ごとに BOS ... EOS で囲んだトークン列を返す
// 除去された要素の位置には GAP トークンが入る
export function tokenizeMany(documents: Array<Array<SanitizedNode>>): Array<Array<EmiToken>> {
  const segments: Array<string> = []
  const documentLines = documents.map(nodes => splitLines(nodes, segments))
  const analyzed = mecabBatch(segments)

  return documentLines.map(lines => lines
    .map(line => trimGaps(line.flatMap(item => 'pending' in item ? analyzed[item.pending] : [item])))
    .filter(line => line.length > 0)
    .flatMap(line => [BOS_TOKEN, ...line, EOS_TOKEN]))
}

export function tokenize(nodes: Array<SanitizedNode>): Array<EmiToken> {
  return tokenizeMany([nodes])[0]
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
  private readonly totals = new Map<string, number>()

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
        this.totals.set(key, (this.totals.get(key) ?? 0) + 1)
      }
    }
  }

  // 1トークンあたりの平均対数尤度 (Stupid Backoff)。流暢さの指標として使う
  averageLogProb(sentence: Array<EmiToken>): number {
    let sum = 0
    let count = 0
    for (let i = 1; i < sentence.length; i++) {
      const next = tokenKey(sentence[i])
      let p = 0
      let penalty = 1
      for (let n = Math.min(this.maxOrder, i); n >= 1; n--) {
        const key = contextKey(sentence.slice(i - n, i))
        const entry = this.table.get(key)?.get(next)
        if (entry) {
          p = penalty * entry.count / this.totals.get(key)!
          break
        }
        penalty *= BACKOFF_PENALTY
      }
      sum += Math.log(p > 0 ? p : 1e-6)
      count += 1
    }
    return count > 0 ? sum / count : -Infinity
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

export function buildCorpus(textInputs: Array<string>): Array<Array<EmiToken>> {
  const documents = textInputs
    .filter(i => !i.match(/^[0-9A-z\n ]+$/))
    .map(txt => sanitize(mfm.parse(txt)))
  return tokenizeMany(documents).flatMap(splitSentences)
}

export function buildModel(textInputs: Array<string>): NgramModel {
  const model = new NgramModel()
  buildCorpus(textInputs).forEach(s => model.addSentence(s))
  return model
}

// 文の区切りとみなす記号 (SNSでは全角スペースも文の区切りとして使われる)
const SENTENCE_TERMINATORS = /^[。．！？!?　]+$/

// 生成文のうち、元の1文から連続してそのまま使われている部分を調べる
export class CopyDetector {
  private readonly spans = new Set<string>()

  constructor(sentences: Array<Array<EmiToken>>, readonly maxSpan: number = 40) {
    for (const sentence of sentences) {
      // GAPで区切られた断片ごとに、連続するトークン列をすべて登録する
      const fragments: Array<Array<EmiToken>> = [[]]
      for (const t of sentence.filter(t => !isBoundary(t))) {
        if (isGap(t)) fragments.push([])
        else fragments[fragments.length - 1].push(t)
      }
      for (const fragment of fragments) {
        for (let i = 0; i < fragment.length; i++) {
          for (let j = i + 1; j <= Math.min(fragment.length, i + maxSpan); j++) {
            this.spans.add(contextKey(fragment.slice(i, j)))
          }
        }
      }
    }
  }

  // 元の1文から連続して使われている最長のトークン数
  longestCopiedSpan(tokens: Array<EmiToken>): number {
    const words = tokens.filter(t => !isBoundary(t))
    let longest = 0
    for (let i = 0; i < words.length; i++) {
      // 長さ L の部分列が元文にあれば、それより短い部分列も必ずある
      for (let j = i + longest + 1; j <= words.length; j++) {
        if (!this.spans.has(contextKey(words.slice(i, j)))) break
        longest = j - i
      }
    }
    return longest
  }

  // 生成文のうち元の1文からそのまま使った部分の割合 (1 なら丸写し)
  // 「。」などで区切った文ごとに求めてトークン数で加重平均する
  // (丸写しの文を「。」で繋いだだけの文章も丸写しとみなすため)
  copyRatio(tokens: Array<EmiToken>): number {
    const words = tokens.filter(t => !isBoundary(t))
    if (words.length === 0) return 1
    const segments: Array<Array<EmiToken>> = [[]]
    for (const t of words) {
      segments[segments.length - 1].push(t)
      if (SENTENCE_TERMINATORS.test(t.surface)) segments.push([])
    }
    const copied = segments
      .filter(segment => segment.length > 0)
      .reduce((sum, segment) => sum + this.longestCopiedSpan(segment), 0)
    return copied / words.length
  }
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

// スコアが高いほど選ばれやすいが、低い候補も確率的に選ばれる (温度付きsoftmax)
export function pickBySoftmax<T>(items: Array<{ item: T, score: number }>, temperature: number): T {
  const max = Math.max(...items.map(i => i.score))
  const weights = items.map(i => Math.exp((i.score - max) / temperature))
  let r = Math.random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]
    if (r < 0) return items[i].item
  }
  return items[items.length - 1].item
}

// 同じ n トークン列が2回目以降に現れた回数
export function countRepeatedNgrams(tokens: Array<EmiToken>, n: number = REPEAT_NGRAM): number {
  const words = tokens.filter(t => !isBoundary(t))
  const seen = new Set<string>()
  let repeated = 0
  for (let i = 0; i + n <= words.length; i++) {
    const key = contextKey(words.slice(i, i + n))
    if (seen.has(key)) repeated += 1
    else seen.add(key)
  }
  return repeated
}

const wordCountOf = (tokens: Array<EmiToken>) => tokens.filter(t => !isBoundary(t) && !isGap(t)).length

// 元の文の長さの分布から、長すぎるとみなす長さを求める
export function lengthLimitOf(sentences: Array<Array<EmiToken>>, percentile: number = LENGTH_LIMIT_PERCENTILE): number {
  const lengths = sentences.map(wordCountOf).sort((a, b) => a - b)
  if (lengths.length === 0) return Infinity
  return Math.max(1, lengths[Math.floor(percentile * (lengths.length - 1))])
}

// lengthLimit を超えた長さの分だけ対数的に減点する (短い文・普通の長さの文は減点しない)
export function scoreCandidate(model: NgramModel, tokens: Array<EmiToken>, copyRatio: number, lengthLimit: number = Infinity): number {
  const fluency = model.averageLogProb(tokens)
  return fluency
    - COPY_PENALTY * Math.max(0, copyRatio - COPY_TOLERANCE)
    - REPEAT_PENALTY * countRepeatedNgrams(tokens)
    - LENGTH_PENALTY * Math.max(0, Math.log(wordCountOf(tokens) / lengthLimit))
}

export function createTextFromInputs(textInputs: Array<string>) {
  const sentences = buildCorpus(textInputs)
  const model = new NgramModel()
  sentences.forEach(s => model.addSentence(s))
  const copyDetector = new CopyDetector(sentences)
  const lengthLimit = lengthLimitOf(sentences)
  const minimum = MIN_TOKEN_LENGTH + Math.floor(Math.random() * 5)

  const candidates = new Map<string, { item: string, score: number }>()
  for (let attempt = 0; attempt < MAX_ATTEMPTS && candidates.size < CANDIDATE_COUNT; attempt++) {
    const tokens = generate(model)
    if (!tokens) continue
    const result = tokensToString(tokens)
    const wordCount = tokens.filter(t => !isBoundary(t)).length
    if (result.length < 5 || wordCount < minimum || !isBalanced(result)) continue
    if (candidates.has(result)) continue
    const copyRatio = copyDetector.copyRatio(tokens)
    // 入力そのもの、または元の1文の一部をそのまま切り出しただけの文は候補にしない
    if (textInputs.includes(result) || copyRatio >= 1) continue
    candidates.set(result, { item: result, score: scoreCandidate(model, tokens, copyRatio, lengthLimit) })
  }

  if (candidates.size === 0) {
    console.warn('Text generation retry limit exceeded.')
    return ''
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score)
  const result = pickBySoftmax(ranked, SELECTION_TEMPERATURE)
  const rank = ranked.findIndex(c => c.item === result)
  console.debug(`候補${ranked.length}件中${rank + 1}位を採用 (score: ${ranked[rank].score.toFixed(2)})`)
  return result
}
