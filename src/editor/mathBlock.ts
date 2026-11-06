import { Node } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import MathNodeView from '../components/MathNodeView.vue'

/** 独立成行的公式块 */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      latex: { default: '' },
      display: { default: true },
      align: { default: 'center' },
      size: { default: 'normal' },
      gapBefore: { default: 1 }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-latex]',
        getAttrs: (element) => {
          const el = element as HTMLElement
          return {
            latex: el.getAttribute('data-latex') || '',
            display: true,
            align: el.getAttribute('data-align') || 'center',
            size: el.getAttribute('data-size') || 'normal',
            gapBefore: Number(el.getAttribute('data-gap-before') || 1)
          }
        }
      }
    ]
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        'data-latex': node.attrs.latex,
        'data-align': node.attrs.align,
        'data-size': node.attrs.size,
        'data-gap-before': node.attrs.gapBefore,
        class: 'math-block'
      },
      node.attrs.latex
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(MathNodeView)
  }
})
