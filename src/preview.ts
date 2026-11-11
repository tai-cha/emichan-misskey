// テスト用: TLを1回だけ取得し、投稿せずに指定した数の文章を生成して表示する
// 使い方: pnpm preview [生成する数 (既定: 10)]
import { createTextFromInputs } from '@/utils/text_maker.js'
import { getNotes, notesToTexts } from '@/utils/timeline.js'

const DEFAULT_COUNT = 10

const parseCount = (arg: string | undefined): number => {
  if (arg === undefined) return DEFAULT_COUNT
  const count = Number(arg)
  if (!Number.isInteger(count) || count <= 0) {
    console.error(`生成する数には正の整数を指定してください: ${arg}`)
    process.exit(1)
  }
  return count
}

(async () => {
  const count = parseCount(process.argv[2])
  const texts = notesToTexts(await getNotes({ numToTake: 700 }))
  console.log(`${texts.length}件のノートから${count}件生成します`)

  for (let i = 1; i <= count; i++) {
    const text = createTextFromInputs(texts)
    console.log(`\n[${i}/${count}]\n${text}`)
  }
})()
