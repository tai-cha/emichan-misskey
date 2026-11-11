import type { Note } from "@/@types/index.js"
import { Misskey } from '@/utils/misskey.js'
import retry from 'async-retry'
import { isFiniteAndPositive } from '@/utils/type_checker.js';

const raiseOmittedTimeline = (notes: Note[]) => {
  // misskey.ioでノートが取得できない場合にエラー扱いしてリトライするためにエラーを起こす
  if (notes.filter(note => note.userId === '7rkr4nmz19' && note.text?.includes('読み込み時のタイムライン表示を簡略化')).length >= 2) {
    console.debug('高負荷のためTL取得不可')
    throw new Error('omitted timeline')
  }
}

const getLastNote = (notes: Array<Note>) => notes.slice(-1)[0];

export const getNotes = async (options?: { numToTake?: number }): Promise<Array<Note>> => {
  const numToTake = options !== undefined && isFiniteAndPositive(options.numToTake) ? options.numToTake : 500

  const requestOptions = {
    excludeNsfw: false,
    limit: 100
  }
  console.log('loading notes...')
  let notes: Note[] = []
  let untilId: string | undefined = undefined

  while (notes.length < numToTake) {
    const newNotes = (await retry(async () => {
      if (notes.length > 0) {
        untilId = getLastNote(notes).id
        console.log(`Getting notes: {untilId: ${untilId}}`)
      } else {
        console.log('Getting first notes...')
      }
      const req = await Misskey.request('notes/hybrid-timeline', {
        untilId,
        ...requestOptions
      })

      raiseOmittedTimeline(req)

      return req
    }, {
      retries: 10,
      minTimeout: 5000,
      onRetry: (err, num) => {
        console.log(`get note retrying...${num}`)
        console.debug(err)
      }
    }
    )).filter(note => !Misskey.isUserDetailed(note.user) || note.user.isBot !== true)
    notes = notes.concat(newNotes)
    if (newNotes.length <= 0) break;
    console.log(notes.length)
    await new Promise((resolve) => setTimeout(resolve, 700))
  }

  return notes
}

// 文章生成の入力にするテキスト (CWなし・公開ノートの本文)
export const notesToTexts = (notes: Array<Note>): Array<string> =>
  notes.filter(note => note.cw == null && note.visibility == 'public').map(note => note.text).filter((text): text is string => text !== null)
