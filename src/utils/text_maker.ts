import * as mfm from 'mfm-js'
import { isMfmBlock } from 'mfm-js/built/node.js';
import { tokenizeSync } from "@enjoyjs/node-mecab"
import Config from '@/utils/config.js'

// load env
Config

const CHUNK_SIZE = 2
const MAX_MATCH_LENGTH = 1
const emojiRegex = /:[0-9A-z_\-]+:/
const endLetters = ["\n", "。", "　"]

const match_length = ():number => {
  const n = 5
  const m = 13
  const min = 1
  //なんかいい感じの重み付きランダムみたいなあれを作る
  //sample: https://www.geogebra.org/graphing/kne365xj
  return Math.floor((MAX_MATCH_LENGTH - min) * Math.round(n * 2 * (Math.atan(m * Math.random())) / Math.PI) / n) + min
}

function sanitizeLoop<T extends mfm.MfmNode['type'], N extends mfm.NodeType<T>>(node: N):Array<N> {
  const inlineTypes: mfm.MfmNode['type'][] = ['unicodeEmoji', 'emojiCode', 'bold', 'small', 'italic', 'strike', 'inlineCode', 'mathInline', 'mention', 'hashtag', 'url', 'link', 'fn', 'plain', 'text']
  function isMfmInline(n: mfm.MfmNode): n is mfm.MfmInline {
    return inlineTypes.includes(n.type)
  }
  function isMfmNode(n: mfm.MfmNode):n is N {
    return isMfmBlock(n) || isMfmInline(n)
  }
  function isMfmNodeArray(nodes: Array<mfm.MfmNode>):nodes is Array<N> {
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
  } else if (node.children && node.children.length > 0 && isMfmNodeArray(node.children) ) {
    let children:Array<N> = node.children
    return children.map(sanitizeLoop).flat()
  } else {
    return []
  }
}

export function sanitize(nodes:Array<mfm.MfmNode>):Array<mfm.MfmNode> {
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

function tokenize(mfm:Array<mfm.MfmNode>):Array<EmiToken> {
  let tokens:Array<EmiToken> = mfm.map(node => {
    if (node.type == 'text') {
      let options = {}
      if (Config.mecabDicDir) options = {...options, dicdir: Config.mecabDicDir}
      return tokenizeSync(node.props.text, options).flat() as unknown as EmiToken[]
    }
    if (node.type == 'unicodeEmoji') {
      return { surface: node.props.emoji, feature: { pos: '絵文字' }} as EmiToken
    }
    if (node.type == 'emojiCode') {
      return { surface: `:${node.props.name}:`, feature: { pos: '絵文字' }} as EmiToken
    }
  }).flat().filter((t) : t is EmiToken => t !== undefined)
  if (tokens.length > 0 && tokens[0]?.surface === '') {
    tokens = tokens.slice(1)
  }
  return tokens
}

function createTokenChunk(tokens: Array<EmiToken>):Array<Array<EmiToken>> {
  if (!tokens || tokens.length <= 0) return []
  if (tokens.length < CHUNK_SIZE) return [[...tokens]]
  let lines:Array<Array<EmiToken>> = [[]]
  tokens.forEach((t)=> {
    const lastIdx = lines.length - 1
    lines[lastIdx].push(t)
    if (endLetters.includes(t.surface)) {
      lines.push([])
    }
  })
  let chunks:Array<Array<EmiToken>> = []
  lines.forEach(line=>{
    line.forEach((token, i, arr) =>{
      if (i > arr.length - CHUNK_SIZE && token.surface === "\n") return
      let res = arr.slice(i, i + CHUNK_SIZE)
      chunks.push(res)
    })
  })

  return chunks
}

function selectChunk(chunks:Array<Array<EmiToken>>, start:Array<EmiToken>):Array<EmiToken> {
  let matched = chunks.filter(chunk => start.every((el, i) => chunk?.[i].surface === el.surface)).filter(chunk => chunk.length !== start.length)
  if (matched.length === 0) return [{ surface: "\n", feature: 
    {pos: "なに"} } as EmiToken]
  let selectedIdx = Math.floor(Math.random() * matched.length)

  return matched[selectedIdx]
}

function createResultChunk(chunks:Array<Array<EmiToken>>) {
  const startCandidates = chunks.filter((chunk) => (chunk.length > 1 && chunk[0]?.surface === "BOS" && chunk[0]?.feature.pos === "BOS/EOS") && !['助詞'].includes(chunk[1].feature.pos))

  const start = startCandidates[Math.floor(Math.random() * startCandidates.length)]
  let result:Array<[number, Array<EmiToken>]> = [[0, start]]

  let cnt = 0
  // cnt条件未満または最後のチャンクの最後のトークンが指定された文字列でないとき
  while(cnt < 50 && !['。', "EOS"].includes(result?.slice(-1)?.[0]?.[1]?.slice(-1)?.[0].surface)) {
    const this_match_length = match_length()
    if (result.length > 0) {
      const lastChunk = result[result.length - 1]
      const lastWords = lastChunk[1].slice(-this_match_length)
      let selected = selectChunk(chunks, lastWords)
      result.push([this_match_length, selected])

      cnt += 1
    }
  }
  return result
}

function chunkToString(chunks:Array<[number, Array<EmiToken>]>):string {
  if (chunks.length < 1) return ''

  let _chunks = chunks.map((chunk) => {
    return chunk[1].map((word, i, words) => {
      if ( i <= chunk[0] - 1 ) return ''

      if (word.feature.pos === 'BOS/EOS') {
        if (words?.[i-1]?.surface === 'EOS' && word.surface === 'BOS') return "\n"
        else return ''
      }
      if (words?.[i-1]?.surface.match(emojiRegex) && word.surface.match(/^[0-9A-z]+.*/)) {
        return `𝅳${word.surface}`
      }
      if (words?.[i-1]?.surface.match(/^[0-9A-z.!]{2,}/) && word.surface.match(/^[0-9A-z.!]+/)) {
        // English
        return ` ${word.surface}`
      }
      return word.surface
    })
  })

  if (_chunks.length === 1) return _chunks[0].join('')

  return _chunks.map(t => t.join('')).join('')
}

function createChunksFromInput(text:string) {
  const mfmTree = mfm.parse(text);
  let sanitized = sanitize(mfmTree);
  return createTokenChunk(tokenize(sanitized))
}

function assertPairBrackets(text:string):boolean {
  const brackets:Array<string|[string, string]|[RegExp, RegExp]> = ['「」', '【】', [/\[/, /\]/], [/\(/, /\)/], '『』', '{}', '（）']
  return brackets.every(bracket => [...text.matchAll(new RegExp(bracket[0], 'g'))].length === [...text.matchAll(new RegExp(bracket[1], 'g'))].length)
}

export function createTextFromInputs(textInputs: Array<string>) {
  const chunks = textInputs.filter(i => !i.match(/^[0-9A-z\n ]+$/)).map(txt => createChunksFromInput(txt))
  let result:string = ''
  let needs_retry = true
  const minimum = 1 + Math.floor(Math.random() * 7)
  const retry_condition = () => {
    return result === '' ||
    !assertPairBrackets(result) ||
    needs_retry ||
    result.length < 5 ||
    createChunksFromInput(result).length < minimum
  }

  while(retry_condition()){
    result = chunkToString(createResultChunk(chunks.flat(1)))
    let same = textInputs.find(i => i === result)
    if (same == undefined) needs_retry = false
    else console.debug('同じ文章が生成されたため再試行します。')
  }
  return result
}