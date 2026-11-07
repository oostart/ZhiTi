/** 依据题干文字粗略判断题型，切割入库后仍可在题库中修改 */
export function guessQuestionType(text: string): string {
  const normalized = text.replace(/\s+/g, '')
  if (!normalized) return '其他'
  if (/[ABCD][\.．、]/.test(normalized) && /（\s*）|\(\s*\)/.test(text)) return '单选题'
  if (/^\s*[（(]?\s*(多选|下列说法|以下说法中正确)/.test(text)) return '多选题'
  if (/[（(]\s*[)）]|____|填(空|写)/.test(text)) return '填空题'
  if (/判断|正确与否|对的打|错的打/.test(text)) return '判断题'
  if (/阅读|read|passage/i.test(text)) return '阅读理解'
  if (/写作|作文|书面表达/.test(text)) return '作文题'
  if (/实验|探究/.test(text)) return '实验题'
  if (/计算|求[^。]{0,8}的?值|解方程/.test(text)) return '计算题'
  return '解答题'
}
