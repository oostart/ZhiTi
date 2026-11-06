import type { ContentDoc, ContentNode } from '../types'

const WORD_JOINER = '\u2060'
const TERMINAL = /[。！？；：]$/
const STRUCTURAL =
  /^(?:[(（]?[A-Da-d][)）.、]|[(（]\d+[)）]|\d+[.、]|[①-⑩]|第\s*\d+|注[：:]|解析[：:]|答案[：:]|解[：:])/

function plainOf(node: ContentNode): string {
  return (node.content ?? [])
    .map((child) => (child.type === 'text' ? child.text ?? '' : child.type === 'mathInline' ? ' ' : ''))
    .join('')
}

function canMerge(prev: ContentNode, next: ContentNode): boolean {
  if (prev.type !== 'paragraph' || next.type !== 'paragraph') return false
  if (!prev.content?.length || !next.content?.length) return false

  const gap = Number(next.attrs?.gapBefore ?? 0)
  if (Number.isFinite(gap) && gap > 0) return false
  if (String(prev.attrs?.align ?? 'left') !== String(next.attrs?.align ?? 'left')) return false
  if (String(prev.attrs?.size ?? 'normal') !== String(next.attrs?.size ?? 'normal')) return false

  const last = prev.content[prev.content.length - 1]
  if (!last || last.type !== 'text') return false

  const prevPlain = plainOf(prev).trimEnd()
  if (prevPlain.length < 16) return false
  if (TERMINAL.test(prevPlain)) return false

  const nextPlain = plainOf(next).trimStart()
  if (!nextPlain) return false
  if (STRUCTURAL.test(nextPlain)) return false

  return true
}

function mergeParagraphs(prev: ContentNode, next: ContentNode): ContentNode {
  const prevContent = [...(prev.content ?? [])]
  const nextContent = [...(next.content ?? [])]

  const last = prevContent[prevContent.length - 1]
  if (last?.type === 'text') {
    prevContent[prevContent.length - 1] = { ...last, text: (last.text ?? '').replace(/\s+$/, '') }
  }
  const first = nextContent[0]
  if (first?.type === 'text') {
    nextContent[0] = { ...first, text: (first.text ?? '').replace(/^\s+/, '') }
  }

  const lastText = last?.type === 'text' ? (last.text ?? '').replace(/\s+$/, '') : ''
  const firstText = first?.type === 'text' ? (first.text ?? '').replace(/^\s+/, '') : ''
  let separator = ''
  if (lastText && firstText) {
    const cjkEnd = /[\u4e00-\u9fff]$/.test(lastText)
    const cjkStart = /^[\u4e00-\u9fff]/.test(firstText)
    const asciiEnd = /[A-Za-z0-9]$/.test(lastText)
    const asciiStart = /^[A-Za-z0-9]/.test(firstText)
    if (cjkEnd && cjkStart) separator = WORD_JOINER
    else if ((asciiEnd && asciiStart) || (cjkEnd && asciiStart) || (asciiEnd && cjkStart)) separator = ' '
  }

  const mergedContent = [
    ...prevContent.filter((node) => !(node.type === 'text' && !node.text)),
    ...(separator ? [{ type: 'text', text: separator }] : []),
    ...nextContent.filter((node) => !(node.type === 'text' && !node.text))
  ]

  return { ...prev, attrs: { ...(prev.attrs ?? {}) }, content: mergedContent }
}

/** 将同一段落的续行合并，避免源行末断词；只改换行，不改文字和公式 */
export function mergeContinuationLines(doc: ContentDoc): { doc: ContentDoc; changed: boolean } {
  const nodes = doc.content ?? []
  const out: ContentNode[] = []
  let changed = false

  for (const node of nodes) {
    const prev = out[out.length - 1]
    if (prev && canMerge(prev, node)) {
      out[out.length - 1] = mergeParagraphs(prev, node)
      changed = true
    } else {
      out.push(node)
    }
  }

  return changed ? { doc: { ...doc, content: out }, changed: true } : { doc, changed: false }
}
