import katex from 'katex'
import 'katex/contrib/mhchem'

/** 公式定界符：$$...$$ / \[...\] / $...$ / \(...\) */
const DELIMITER_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g

/** 行首编号：1）/（1）/1、/1./① 等 */
const LIST_MARKER = /^(\s*(?:[（(]\s*\d{1,2}\s*[）)]|\d{1,2}\s*[）)]|\d{1,2}[、．]|[①②③④⑤⑥⑦⑧⑨⑩])\s*)([\s\S]*)$/

const CJK_PATTERN = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function renderFormula(latex: string, display: boolean): string {
  const value = latex.trim()
  if (!value) return ''
  try {
    return katex.renderToString(value, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore'
    })
  } catch {
    return escapeHtml(latex)
  }
}

/** 旧数据里可能只有裸 LaTeX（如 \frac{1}{2}），整段都是公式时直接渲染 */
function isBareMath(text: string): boolean {
  const value = text.trim()
  if (!value || value.length > 240) return false
  if (CJK_PATTERN.test(value)) return false
  return /\\[a-zA-Z]+/.test(value) || /[_^]\s*(?:\{|[0-9A-Za-z])/.test(value)
}

/** 从 index 处的 { 或 [ 开始，返回配对括号之后的位置；不闭合时返回 -1 */
function consumeGroup(text: string, index: number, open: string, close: string): number {
  let depth = 0
  for (let i = index; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** 把中文与裸 LaTeX 混排的文本拆成「普通文字 / 公式」片段 */
function splitBareMath(text: string): Array<{ math: boolean; value: string }> {
  const parts: Array<{ math: boolean; value: string }> = []
  let plain = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && /[a-zA-Z]/.test(text[i + 1] ?? '')) {
      const start = i
      let j = i + 1
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++
      const command = text.slice(start, j)
      let ok = true
      if (command === '\\left' || command === '\\right') {
        // 连同后面的定界符一起渲染，避免出现孤立的 \left
        while (j < text.length && text[j] === ' ') j++
        if (j < text.length) j++
      }
      while (ok && j < text.length) {
        const ch = text[j]
        if (ch === '{' || ch === '[') {
          const end = consumeGroup(text, j, ch, ch === '{' ? '}' : ']')
          if (end < 0) {
            ok = false
            break
          }
          j = end
        } else if (ch === '^' || ch === '_') {
          j++
          if (text[j] === '{') {
            const end = consumeGroup(text, j, '{', '}')
            if (end < 0) {
              ok = false
              break
            }
            j = end
          } else if (j < text.length) {
            j++
          }
        } else {
          break
        }
      }
      if (ok) {
        if (plain) {
          parts.push({ math: false, value: plain })
          plain = ''
        }
        parts.push({ math: true, value: text.slice(start, j) })
        i = j
        continue
      }
    }
    plain += text[i]
    i++
  }
  if (plain) parts.push({ math: false, value: plain })
  return parts
}

function renderPlain(text: string): string {
  if (!text) return ''
  if (isBareMath(text)) return renderFormula(text, false)
  if (!text.includes('\\')) return escapeHtml(text)
  return splitBareMath(text)
    .map((part) => (part.math ? renderFormula(part.value, false) : escapeHtml(part.value)))
    .join('')
}

function renderInline(text: string): string {
  let result = ''
  let lastIndex = 0
  DELIMITER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DELIMITER_PATTERN.exec(text))) {
    if (match.index > lastIndex) result += renderPlain(text.slice(lastIndex, match.index))
    const display = match[1] != null || match[2] != null
    const latex = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    result += renderFormula(latex, display)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) result += renderPlain(text.slice(lastIndex))
  return result
}

function renderLine(line: string): string {
  if (!line.trim()) return ''
  const marker = line.match(LIST_MARKER)
  if (marker) return `${escapeHtml(marker[1])}${renderLine(marker[2])}`
  return renderInline(line)
}

/** 把纯文本答案渲染为带 KaTeX 公式的 HTML：支持 $...$、$$...$$、\(...\)、\[...\] 与裸 LaTeX */
export function renderMathText(input: string): string {
  if (!input || !input.trim()) return ''
  return input
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => renderLine(line))
    .join('<br>')
}
