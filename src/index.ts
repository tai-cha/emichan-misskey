import { createTextFromInputs } from '@/utils/text_maker.js'
import { Misskey } from '@/utils/misskey.js'
import { getNotes, notesToTexts } from '@/utils/timeline.js'
import retry from 'async-retry'

async function create(): Promise<string | null> {
  const notes = await getNotes({ numToTake: 700 });
  return createTextFromInputs(notesToTexts(notes))
}

//ここから実行

(async () => {
  let text = await retry(create, {
    retries: 3,
    minTimeout: 5000,
    onRetry: (err, num) => {
      console.log(`Retrying: create text...${num}`)
      console.debug(err)
    }
  }).catch(err => {
    console.log("テキスト生成の失敗が既定の回数を超えました")
    console.debug(err)
    return null
  })
  if (text !== null) {
    await retry(async () => {
      return await Misskey.postNote(text || '')
    }, {
      retries: 15,
      minTimeout: 5000,
      onRetry: (err, num) => {
        console.log(`Retrying: note posting...${num}`)
        console.debug(err)
      }
    }).then(async () => {
      if (process.env?.NODE_ENV !== 'development') console.log('投稿完了')
      else console.log('[DEV] 投稿処理完了')
    }).catch(err => {
      console.log("ノート投稿の失敗が既定の回数を超えました")
      console.log(err)
    })
  }
})()