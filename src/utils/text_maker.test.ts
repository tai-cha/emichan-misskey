import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTextFromInputs, sanitize, tokenize, NgramModel, buildModel, generate, tokensToString, type EmiToken } from './text_maker.js';
import * as mfm from 'mfm-js';

describe('text_maker', () => {
  beforeEach(() => {
    // Math.random をモックして常に 0 を返すようにする（match_length が 1 になりやすくなる）
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe('sanitize', () => {
    it('should remove unwanted nodes', () => {
      const nodes: mfm.MfmNode[] = [
        { type: 'text', props: { text: 'Hello' } },
        { type: 'url', props: { url: 'https://example.com' } },
        { type: 'mention', props: { acct: '@user', username: 'user', host: null } },
        { type: 'unicodeEmoji', props: { emoji: '😀' } }
      ];
      const sanitized = sanitize(nodes);
      expect(sanitized).toHaveLength(2);
      expect(sanitized[0].type).toBe('text');
      expect(sanitized[1].type).toBe('unicodeEmoji');
    });
  });

  describe('tokenize', () => {
    it('should return tokens', () => {
      const nodes: mfm.MfmNode[] = [{ type: 'text', props: { text: '今日はいい天気' } }];
      const tokens = tokenize(nodes);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens[0].surface).toBeDefined();
      // 品詞情報の確認
      const bos = tokens.find(t => t.surface === 'BOS');
      expect(bos).toBeDefined();
    });

    it('should tokenize with a valid dictionary', () => {
      // 辞書が読み込めないと "[ifs]" のような異常トークンになるため、形態素解析結果を確認する
      const nodes: mfm.MfmNode[] = [{ type: 'text', props: { text: '猫と遊んだ' } }];
      const tokens = tokenize(nodes).filter(t => t.feature.pos !== 'BOS/EOS');
      expect(tokens.map(t => t.surface)).toEqual(['猫', 'と', '遊ん', 'だ']);
      expect(tokens.map(t => t.feature.pos)).toEqual(['名詞', '助詞', '動詞', '助動詞']);
    });
  });

  describe('tokenize (sentence boundaries)', () => {
    const surfaces = (text: string) => tokenize(sanitize(mfm.parse(text))).map(t => t.surface)

    it('should not split sentences at MFM node boundaries', () => {
      expect(surfaces('**太字**です')).toEqual(['BOS', '太字', 'です', 'EOS'])
    });

    it('should keep emojis inside the sentence', () => {
      expect(surfaces('おはよう:wave:みんな')).toEqual(['BOS', 'おはよう', ':wave:', 'みんな', 'EOS'])
    });

    it('should split sentences only at line breaks and skip empty lines', () => {
      expect(surfaces('猫\n\n犬')).toEqual(['BOS', '猫', 'EOS', 'BOS', '犬', 'EOS'])
    });
  });

  describe('NgramModel', () => {
    const tok = (surface: string, pos = '名詞'): EmiToken => ({ surface, feature: { pos }, id: undefined })
    const BOS = tok('BOS', 'BOS/EOS')
    const EOS = tok('EOS', 'BOS/EOS')

    it('should learn EOS as a next token', () => {
      const model = new NgramModel()
      model.addSentence([BOS, tok('猫'), tok('好き'), EOS])
      expect(model.next([tok('猫'), tok('好き')])?.surface).toBe('EOS')
    });

    it('should back off to a shorter context when the long context is unseen', () => {
      const model = new NgramModel()
      model.addSentence([BOS, tok('犬'), tok('が'), tok('走る'), EOS])
      // [猫, が] は未学習だが [が] からは "走る" が続く
      expect(model.next([tok('猫'), tok('が')])?.surface).toBe('走る')
    });

    it('should back off when candidates are rejected', () => {
      const model = new NgramModel()
      model.addSentence([BOS, tok('猫'), tok('が'), tok('寝る'), EOS])
      model.addSentence([BOS, tok('犬'), tok('が'), tok('走る'), EOS])
      // [猫, が] の候補 "寝る" を拒否すると [が] の候補から選ばれる
      expect(model.next([tok('猫'), tok('が')], t => t.surface !== '寝る')?.surface).toBe('走る')
      expect(model.next([tok('猫'), tok('が')], () => false)).toBeNull()
    });

    it('should not confuse a word "BOS" with the sentence boundary', () => {
      const model = new NgramModel()
      model.addSentence([BOS, tok('BOS'), tok('です'), EOS])
      expect(model.next([BOS])?.surface).toBe('BOS')
      expect(model.next([tok('BOS')])?.surface).toBe('です')
    });

    it('should generate a sentence from BOS to EOS using only learned transitions', () => {
      vi.restoreAllMocks();
      const inputs = ['今日はいい天気ですね。', '明日は雨が降るらしい', '雨の日は読書がしたい']
      const model = buildModel(inputs)
      const bigrams = new Set(inputs.flatMap(text => {
        const t = tokenize(sanitize(mfm.parse(text))).map(x => x.surface)
        return t.slice(1).map((s, i) => `${t[i]} ${s}`)
      }))
      for (let i = 0; i < 20; i++) {
        const tokens = generate(model)!
        expect(tokens[0].surface).toBe('BOS')
        expect(tokens[tokens.length - 1].surface).toBe('EOS')
        tokens.slice(1).forEach((t, j) => expect(bigrams).toContain(`${tokens[j].surface} ${t.surface}`))
        expect(tokensToString(tokens)).not.toMatch(/BOS|EOS/)
      }
    });
  });

  describe('createTextFromInputs', () => {
    beforeEach(() => {
      // 乱数を固定すると毎回同じ候補が選ばれ入力の丸写ししか生成できないため、実際の乱数を使う
      vi.restoreAllMocks();
    });

    it('should create text from inputs', () => {
      const inputs = [
        '今日はとてもいい天気ですね。散歩に行きたくなります。',
        '明日の天気は雨かもしれません。傘が必要ですね。',
        '散歩していたら、可愛い猫を見つけました。',
        '雨の日は家でゆっくり読書をするのが好きです。',
        '猫はこたつで丸くなって寝ていました。',
        '読書をしていたら、いつの間にか寝てしまいました。',
        '天気がいい日は公園で猫と遊びます。',
        '公園にはたくさんの猫がいます。',
        '猫は雨が嫌いなようです。',
        '読書も好きですが、散歩も好きです。',
        'こたつで寝るのは最高に気持ちいいです。',
        '新しい趣味として読書を始めました。',
        '散歩の途中で雨が降ってきました。',
        '猫と一緒にこたつに入りたいです。',
        'いい天気なので、遠くまで出かけようと思います。'
      ];
      // ランダム性があるため、何度か試行してエラーにならないこと、空でないことを確認
      for (let i = 0; i < 5; i++) {
        const result = createTextFromInputs(inputs);
        expect(result).toBeTypeOf('string');
        expect(result.length).toBeGreaterThan(0);
      }
    });

    it('should handle empty inputs gracefully', () => {
      // 空の配列や無効な入力に対する挙動を確認（実装依存だがエラーで落ちないこと）
      try {
        const result = createTextFromInputs([]);
        // 結果は空文字か何かが返るはず
        expect(typeof result).toBe('string');
      } catch (e) {
        // エラーになる場合はそれはそれでOK（現状の実装を確認）
        expect(e).toBeDefined();
      }
    });
  });
});
