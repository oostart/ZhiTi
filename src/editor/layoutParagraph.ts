import { Paragraph } from '@tiptap/extension-paragraph'

type LayoutAlign = 'left' | 'center' | 'right'
type LayoutSize = 'large' | 'normal' | 'small'

/** 带试卷版式属性的段落：每行一个段落，align/indent/size/gapBefore 用于纸张视图 */
export const LayoutParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: 'left',
        parseHTML: (element: HTMLElement) => (element.getAttribute('data-align') as LayoutAlign) || 'left',
        renderHTML: (attributes: Record<string, any>) => ({ 'data-align': attributes.align })
      },
      indent: {
        default: 0,
        parseHTML: (element: HTMLElement) => Number(element.getAttribute('data-indent') || 0),
        renderHTML: (attributes: Record<string, any>) => ({ 'data-indent': attributes.indent })
      },
      size: {
        default: 'normal',
        parseHTML: (element: HTMLElement) => (element.getAttribute('data-size') as LayoutSize) || 'normal',
        renderHTML: (attributes: Record<string, any>) => ({ 'data-size': attributes.size })
      },
      gapBefore: {
        default: 0,
        parseHTML: (element: HTMLElement) => Number(element.getAttribute('data-gap-before') || 0),
        renderHTML: (attributes: Record<string, any>) => ({ 'data-gap-before': attributes.gapBefore })
      }
    }
  }
})
