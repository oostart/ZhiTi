import StarterKit from '@tiptap/starter-kit'
import { Figure } from './figure'
import { LayoutParagraph } from './layoutParagraph'
import { MathBlock } from './mathBlock'
import { MathInline } from './mathInline'

const starterKit = StarterKit.configure({ paragraph: false })

export const editorExtensions = [starterKit, LayoutParagraph, MathInline, MathBlock, Figure]
