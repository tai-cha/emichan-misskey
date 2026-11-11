import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // 開発環境用の設定(.env.development)を読み込ませる
    env: { NODE_ENV: 'development' },
    // ビルド成果物内のテストは対象外
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
