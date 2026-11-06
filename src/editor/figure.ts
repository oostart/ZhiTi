import { Node } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import FigureNodeView from '../components/FigureNodeView.vue'

/** 题目中的图形/表格：从原图裁剪出的位图，原子节点 */
export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: { default: '' },
      bbox: { default: null },
      unresolved: { default: false },
      width: { default: 1 },
      align: { default: 'center' },
      gapBefore: { default: 1 }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-figure]',
        getAttrs: (element) => {
          const el = element as HTMLElement
          const img = el.querySelector('img')
          return {
            src: img?.getAttribute('src') || '',
            bbox: null,
            unresolved: !img?.getAttribute('src'),
            width: Number(el.getAttribute('data-width') || 1),
            align: el.getAttribute('data-align') || 'center',
            gapBefore: Number(el.getAttribute('data-gap-before') || 1)
          }
        }
      }
    ]
  },

  renderHTML({ node }) {
    return [
      'figure',
      {
        'data-figure': 'true',
        'data-width': node.attrs.width,
        'data-align': node.attrs.align,
        'data-gap-before': node.attrs.gapBefore,
        class: 'figure-block'
      },
      ['img', { src: node.attrs.src, alt: '题目图形' }]
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(FigureNodeView)
  }
})
