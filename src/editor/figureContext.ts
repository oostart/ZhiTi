import type { ComputedRef, InjectionKey } from 'vue'

/** 题目原图（dataURL），供图形节点重新裁剪使用；为空表示当前上下文不支持调整裁剪 */
export const FIGURE_SOURCE_KEY: InjectionKey<ComputedRef<string>> = Symbol('figure-source')
