import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'

const prototypeDataPath = path.resolve(__dirname, '../../design/console-prototype/data.js')

function prototypeDataAsset() {
  const serve = (_req: unknown, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void }, next: () => void) => {
    void next
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(fs.readFileSync(prototypeDataPath, 'utf8'))
  }
  return {
    name: 'costkey-prototype-data',
    configureServer(server: { middlewares: { use: (route: string, handler: typeof serve) => void } }) {
      server.middlewares.use('/__costkey/prototype-data.js', serve)
    },
    generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: string }) => void }) {
      this.emitFile({ type: 'asset', fileName: 'prototype-data.js', source: fs.readFileSync(prototypeDataPath, 'utf8') })
    },
  }
}

export default defineConfig({
  // Relative asset URLs let one build serve under any base path. The server
  // anchors index.html's URLs at its base path when it serves the shell, and
  // lazy chunks load relative to the chunk that imports them. The dev server
  // still serves from the root.
  base: './',
  plugins: [react(), tailwindcss(), prototypeDataAsset()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
