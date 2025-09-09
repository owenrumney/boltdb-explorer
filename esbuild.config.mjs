import esbuild from 'esbuild';

const isWebview = process.argv.includes('--webview');

const configs = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    sourcemap: true,
    minify: false
  },
  {
    entryPoints: ['src/webview/index.tsx'],
    bundle: true,
    platform: 'browser',
    outfile: 'media/webview.js',
    sourcemap: true,
    minify: false,
    jsx: 'automatic',
    jsxImportSource: 'react'
  }
];

Promise.all(configs.map(cfg => esbuild.build(cfg))).catch(() => process.exit(1));
