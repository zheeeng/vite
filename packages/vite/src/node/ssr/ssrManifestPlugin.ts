import { relative, basename, join, dirname } from 'path'
import { parse as parseImports } from 'es-module-lexer'
import type { ImportSpecifier } from 'es-module-lexer'
import type { OutputChunk } from 'rollup'
import type { ResolvedConfig } from '..'
import type { Plugin } from '../plugin'
import { chunkToEmittedCssFileMap } from '../plugins/css'
import { chunkToEmittedAssetsMap } from '../plugins/asset'
import { preloadMethod } from '../plugins/importAnalysisBuild'
import { normalizePath } from '../utils'

export function ssrManifestPlugin(config: ResolvedConfig): Plugin {
  // module id => preload assets mapping
  const ssrManifest: Record<string, string[]> = {}
  const base = config.base

  return {
    name: 'vite:ssr-manifest',
    generateBundle(_options, bundle) {
      for (const file in bundle) {
        const chunk = bundle[file]
        if (chunk.type === 'chunk') {
          // links for certain entry chunks are already generated in static HTML
          // in those cases we only need to record info for non-entry chunks
          const cssFiles = chunk.isEntry
            ? null
            : chunkToEmittedCssFileMap.get(chunk)
          const assetFiles = chunkToEmittedAssetsMap.get(chunk)
          for (const id in chunk.modules) {
            const normalizedId = normalizePath(relative(config.root, id))
            const mappedChunks =
              ssrManifest[normalizedId] ?? (ssrManifest[normalizedId] = [])
            if (!chunk.isEntry) {
              mappedChunks.push(base + chunk.fileName)
            }
            if (cssFiles) {
              cssFiles.forEach((file) => {
                mappedChunks.push(base + file)
              })
            }
            if (assetFiles) {
              assetFiles.forEach((file) => {
                mappedChunks.push(base + file)
              })
            }
          }
          if (chunk.code.includes(preloadMethod)) {
            // generate css deps map
            const code = chunk.code
            let imports: ImportSpecifier[]
            try {
              imports = parseImports(code)[0].filter((i) => i.d > -1)
            } catch (e: any) {
              this.error(e, e.idx)
            }
            if (imports.length) {
              for (let index = 0; index < imports.length; index++) {
                const {
                  s: start,
                  e: end,
                  n: name,
                  d: dynamicIndex
                } = imports[index]
                if (dynamicIndex) {
                  // check the chunk being imported
                  const url = code.slice(start, end)
                  const deps: string[] = []
                  const ownerFilename = chunk.fileName
                  // literal import - trace direct imports and add to deps
                  const analyzed: Set<string> = new Set<string>()
                  const addDeps = (filename: string) => {
                    if (filename === ownerFilename) return
                    if (analyzed.has(filename)) return
                    analyzed.add(filename)
                    const chunk = bundle[filename] as OutputChunk | undefined
                    if (chunk) {
                      const cssFiles = chunkToEmittedCssFileMap.get(chunk)
                      if (cssFiles) {
                        cssFiles.forEach((file) => {
                          deps.push(`/${file}`)
                        })
                      }
                      chunk.imports.forEach(addDeps)
                    }
                  }
                  const normalizedFile = normalizePath(
                    join(dirname(chunk.fileName), url.slice(1, -1))
                  )
                  addDeps(normalizedFile)
                  ssrManifest[basename(name!)] = deps
                }
              }
            }
          }
        }
      }

      this.emitFile({
        fileName: 'ssr-manifest.json',
        type: 'asset',
        source: JSON.stringify(ssrManifest, null, 2)
      })
    }
  }
}
