import { Node } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import MathNodeView from '../components/MathNodeView.vue'

/** 行内公式：原子节点，光标无法进入，只能整体选中或点击修改 */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      latex: { default: '' },
      display: { default: false }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-latex]',
        getAttrs: (element) => ({ latex: (element as HTMLElement).getAttribute('data-latex') || '' })
      }
    ]
  },

  renderHTML({ node }) {
    return ['span', { 'data-latex': node.attrs.latex, class: 'math-inline' }, node.attrs.latex]
  },

  addNodeView() {
    return VueNodeViewRenderer(MathNodeView)
  }
})
