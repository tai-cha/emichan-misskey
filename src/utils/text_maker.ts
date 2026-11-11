import * as mfm from 'mfm-js'
import { isMfmBlock } from 'mfm-js/built/node.js';
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

function sanitizeLoop<T extends mfm.MfmNode['type'], N extends mfm.NodeType<T>>(node: N): Array<N> {
  const inlineTypes: mfm.MfmNode['type'][] = ['unicodeEmoji', 'emojiCode', 'bold', 'small', 'italic', 'strike', 'inlineCode', 'mathInline', 'mention', 'hashtag', 'url', 'link', 'fn', 'plain', 'text']
  function isMfmInline(n: mfm.MfmNode): n is mfm.MfmInline {
    return inlineTypes.includes(n.type)
  }
  function isMfmNode(n: mfm.MfmNode): n is N {
    return isMfmBlock(n) || isMfmInline(n)
  }
  function isMfmNodeArray(nodes: Array<mfm.MfmNode>): nodes is Array<N> {
    return nodes.every(isMfmNode)
  }
  if (['text', 'emojiCode', 'unicodeEmoji'].includes(node.type)) {
    return [node]
  }

  // FIXME: ruby関数対応
  if (node.type == 'fn' && node.props.name == 'ruby') {
    return []
  }

  if (['url', 'mention', 'hashtag', 'link'].includes(node.type)) {
    return []
  } else if (node.children && node.children.length > 0 && isMfmNodeArray(node.children)) {
    let children: Array<N> = node.children
    return children.map(sanitizeLoop).flat()
  } else {
    return []
  }
}

export function sanitize(nodes: Array<mfm.MfmNode>): Array<mfm.MfmNode> {
  return nodes.map(n => sanitizeLoop(n)).flat()
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

function mecab(text: string): Array<EmiToken> {
  let options = {}
  if (Config.mecabDicDir) options = { ...options, dicdir: Config.mecabDicDir }
  // MeCabが付与するBOS/EOSは除き、文の区切りはtokenize側で管理する
  return (tokenizeSync(text, options).flat() as unknown as EmiToken[])
    .filter(t => !isBoundary(t) && t.surface !== '')
}

// 改行ごとに BOS ... EOS で囲んだトークン列を返す
// MFMノードの境界では文を区切らず、連続するテキストはまとめて解析する
export function tokenize(nodes: Array<mfm.MfmNode>): Array<EmiToken> {
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
    }
  }
  flush()

  return lines.filter(line => line.length > 0).flatMap(line => [BOS_TOKEN, ...line, EOS_TOKEN])
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
      for (let n = 1; n <= this.maxOrder && i - n >= 0; n++) {
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

// BOS から EOS まで生成する。終端に到達できなかった場合は null
export function generate(model: NgramModel): Array<EmiToken> | null {
  const tokens: Array<EmiToken> = [BOS_TOKEN]
  // 助詞から始まるのは不自然なので避ける
  const first = model.next(tokens, t => t.feature.pos !== '助詞' && !isEOS(t))
  if (!first) return null
  tokens.push(first)

  while (tokens.length < MAX_TOKEN_LENGTH) {
    const next = model.next(tokens.slice(-match_length()))
    if (!next) return null
    tokens.push(next)
    if (isEOS(next)) return tokens
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

function assertPairBrackets(text: string): boolean {
  const brackets: Array<string | [string, string] | [RegExp, RegExp]> = ['「」', '【】', [/\[/, /\]/], [/\(/, /\)/], '『』', '{}', '（）']
  return brackets.every(bracket => [...text.matchAll(new RegExp(bracket[0], 'g'))].length === [...text.matchAll(new RegExp(bracket[1], 'g'))].length)
}

export function createTextFromInputs(textInputs: Array<string>) {
  const model = buildModel(textInputs)
  const minimum = MIN_TOKEN_LENGTH + Math.floor(Math.random() * 5)

  for (let retry_count = 0; retry_count <= 100; retry_count++) {
    const tokens = generate(model)
    if (!tokens) continue
    const result = tokensToString(tokens)
    const wordCount = tokens.filter(t => !isBoundary(t)).length
    if (result.length < 5 || wordCount < minimum || !assertPairBrackets(result)) continue
    if (textInputs.includes(result)) {
      console.debug('同じ文章が生成されたため再試行します。')
      continue
    }
    return result
  }
  console.warn('Text generation retry limit exceeded.')
  return ''
}
