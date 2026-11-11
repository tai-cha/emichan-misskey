import * as mfm from 'mfm-js'
import { isMfmBlock } from 'mfm-js/built/node.js';
import { tokenizeSync } from "@enjoyjs/node-mecab"
import Config from '@/utils/config.js'

// load env
Config

const MAX_MATCH_LENGTH = 4
// 最大マッチ長 + 次の1トークン分を保持できる長さが必要
const CHUNK_SIZE = MAX_MATCH_LENGTH + 1
const MIN_CHUNK_LENGTH = 3
const TERMINATION_PROBABILITY = 0.5
const NOUN_TERMINATION_RATIO = 1.25
const emojiRegex = /:[0-9A-z_\-]+:/
const endLetters = ["\n", "。", "　"]

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

type EmiToken = {
  id: number | undefined,
  surface: string,
  feature: {
    pos: string,
    [key: string]: any
  },
  [key: string]: any
}

export function tokenize(mfm: Array<mfm.MfmNode>): Array<EmiToken> {
  let tokens: Array<EmiToken> = mfm.map(node => {
    if (node.type == 'text') {
      let options = {}
      if (Config.mecabDicDir) options = { ...options, dicdir: Config.mecabDicDir }
      return tokenizeSync(node.props.text, options).flat() as unknown as EmiToken[]
    }
    if (node.type == 'unicodeEmoji') {
      return { surface: node.props.emoji, feature: { pos: '絵文字' } } as EmiToken
    }
    if (node.type == 'emojiCode') {
      return { surface: `:${node.props.name}:`, feature: { pos: '絵文字' } } as EmiToken
    }
  }).flat().filter((t): t is EmiToken => t !== undefined)
  if (tokens.length > 0 && tokens[0]?.surface === '') {
    tokens = tokens.slice(1)
  }

  // MeCabの設定によってはBOS/EOSが付与されないため、強制的に付与する
  if (tokens.length > 0) {
    if (tokens[0].surface !== 'BOS') {
      tokens.unshift({ surface: 'BOS', feature: { pos: 'BOS/EOS' }, id: undefined })
    }
    if (tokens[tokens.length - 1].surface !== 'EOS') {
      tokens.push({ surface: 'EOS', feature: { pos: 'BOS/EOS' }, id: undefined })
    }
  }

  return tokens
}

function createTokenChunk(tokens: Array<EmiToken>): Array<Array<EmiToken>> {
  if (!tokens || tokens.length <= 0) return []
  if (tokens.length < CHUNK_SIZE) return [[...tokens]]
  let lines: Array<Array<EmiToken>> = [[]]
  tokens.forEach((t) => {
    const lastIdx = lines.length - 1
    lines[lastIdx].push(t)
    if (endLetters.includes(t.surface)) {
      lines.push([])
    }
  })
  let chunks: Array<Array<EmiToken>> = []
  lines.forEach(line => {
    line.forEach((token, i, arr) => {
      if (i > arr.length - CHUNK_SIZE && token.surface === "\n") return
      let res = arr.slice(i, i + CHUNK_SIZE)
      chunks.push(res)
    })
  })

  return chunks
}

const EOS_TOKEN: EmiToken = { surface: "EOS", feature: { pos: "BOS/EOS" }, id: undefined }

// 戻り値: [マッチに使ったトークン数, チャンク]。チャンクの先頭からマッチ数分は既出なので出力されない
function selectChunk(chunks: Array<Array<EmiToken>>, start: Array<EmiToken>): [number, Array<EmiToken>] {
  // Tier 1: Surface Match (流暢さ最優先)
  // 長い文脈から順に試し、見つからなければ短い文脈にバックオフする
  for (let len = start.length; len >= 1; len--) {
    const context = start.slice(-len)
    const matched_surface = chunks.filter(chunk =>
      chunk.length > len && context.every((el, i) => chunk[i].surface === el.surface)
    )
    if (matched_surface.length > 0) {
      // 重複するチャンクも候補に含まれるため、出現頻度に比例した選択になる
      const selected = matched_surface[Math.floor(Math.random() * matched_surface.length)]
      // 次の1トークンだけを採用する
      return [len, selected.slice(0, len + 1)]
    }
  }

  // Tier 2: 確率的終了判定 (長さの厳格な制御)
  // 助詞や接続詞で終わるのは不自然なので避ける
  const lastToken = start[start.length - 1]
  const lastPos = lastToken?.feature.pos
  const isBadEndPos = ['助詞', '接続詞'].includes(lastPos)
  const isNounEnd = lastPos === '名詞'

  // 名詞の場合は終了確率を上げる (相対値)、それ以外はデフォルト
  const threshold = isNounEnd
    ? Math.min(1, TERMINATION_PROBABILITY * NOUN_TERMINATION_RATIO)
    : TERMINATION_PROBABILITY

  if (start.length > 0 && !isBadEndPos && Math.random() < threshold) {
    return [0, [EOS_TOKEN]]
  }

  // Tier 3: 品詞フォールバック (文法的な安全ネット)
  if (start.length > 0) {
    // チャンクの最初の単語の品詞が、BOS/EOSでないものを抽出
    let matched_pos = chunks.filter(chunk => {
      if (chunk.length <= 0) return false
      const firstPos = chunk[0].feature.pos
      if (firstPos === 'BOS/EOS') return false

      // 不自然な繋がりを避ける
      const lastToken = start[start.length - 1]
      const lastPos = lastToken?.feature.pos
      if (lastPos === '助詞' && firstPos === '助詞') return false

      return true
    }).filter(chunk => chunk.length !== start.length)

    if (matched_pos.length > 0) {
      let selectedIdx = Math.floor(Math.random() * matched_pos.length)
      // 文脈とは繋がらないため、チャンク全体を新しく出力する
      return [0, matched_pos[selectedIdx]]
    }
  }

  // Tier 4: 最終フォールバック（破綻終了）
  return [0, [EOS_TOKEN]]
}

function createResultChunk(chunks: Array<Array<EmiToken>>) {
  const startCandidates = chunks.filter((chunk) => (chunk.length > 1 && chunk[0]?.surface === "BOS" && chunk[0]?.feature.pos === "BOS/EOS") && !['助詞'].includes(chunk[1].feature.pos))

  const start = startCandidates[Math.floor(Math.random() * startCandidates.length)]
  if (!start) return []
  // 開始時は BOS + 最初の1トークンのみ採用する
  let result: Array<[number, Array<EmiToken>]> = [[0, start.slice(0, 2)]]
  // 文脈は直前のチャンクではなく、これまでに生成した(出力された)トークン列から取る
  let generated: Array<EmiToken> = start.slice(0, 2)

  let cnt = 0
  // cnt条件未満または生成した最後のトークンが終端でないとき
  while (cnt < 50 && !['。', "EOS"].includes(generated[generated.length - 1]?.surface)) {
    const this_match_length = match_length()
    const [matched, selected] = selectChunk(chunks, generated.slice(-this_match_length))
    result.push([matched, selected])
    generated = generated.concat(selected.slice(matched))
    cnt += 1
  }
  return result
}

function chunkToString(chunks: Array<[number, Array<EmiToken>]>): string {
  if (chunks.length < 1) return ''

  let _chunks = chunks.map((chunk) => {
    return chunk[1].map((word, i, words) => {
      if (i <= chunk[0] - 1) return ''

      if (word.feature.pos === 'BOS/EOS') {
        if (words?.[i - 1]?.surface === 'EOS' && word.surface === 'BOS') return "\n"
        else return ''
      }
      if (words?.[i - 1]?.surface.match(emojiRegex) && word.surface.match(/^[0-9A-z]+.*/)) {
        return `𝅳${word.surface}`
      }
      if (words?.[i - 1]?.surface.match(/^[0-9A-z.!]{2,}/) && word.surface.match(/^[0-9A-z.!]+/)) {
        // English
        return ` ${word.surface}`
      }
      return word.surface
    })
  })

  if (_chunks.length === 1) return _chunks[0].join('')

  return _chunks.map(t => t.join('')).join('')
}

function createChunksFromInput(text: string) {
  const mfmTree = mfm.parse(text);
  let sanitized = sanitize(mfmTree);
  return createTokenChunk(tokenize(sanitized))
}

function assertPairBrackets(text: string): boolean {
  const brackets: Array<string | [string, string] | [RegExp, RegExp]> = ['「」', '【】', [/\[/, /\]/], [/\(/, /\)/], '『』', '{}', '（）']
  return brackets.every(bracket => [...text.matchAll(new RegExp(bracket[0], 'g'))].length === [...text.matchAll(new RegExp(bracket[1], 'g'))].length)
}

export function createTextFromInputs(textInputs: Array<string>) {
  const chunks = textInputs.filter(i => !i.match(/^[0-9A-z\n ]+$/)).map(txt => createChunksFromInput(txt))
  let result: string = ''
  let needs_retry = true
  const minimum = MIN_CHUNK_LENGTH + Math.floor(Math.random() * 5)
  const retry_condition = () => {
    return result === '' ||
      !assertPairBrackets(result) ||
      needs_retry ||
      result.length < 5 ||
      createChunksFromInput(result).length < minimum
  }

  let retry_count = 0
  while (retry_condition()) {
    if (retry_count > 100) {
      console.warn('Text generation retry limit exceeded.')
      return ''
    }
    retry_count += 1
    result = chunkToString(createResultChunk(chunks.flat(1)))
    let same = textInputs.find(i => i === result)
    if (same == undefined) needs_retry = false
    else console.debug('同じ文章が生成されたため再試行します。')
  }
  return result
}