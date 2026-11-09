/** 试卷学科缺失时的占位名，保证编号标签不会为空 */
export const UNKNOWN_SUBJECT = '未设学科'

/** 学科名：去掉首尾空格；为空时回退为「未设学科」 */
export function subjectName(subject: string | null | undefined): string {
  return (subject ?? '').trim() || UNKNOWN_SUBJECT
}

/** 题目编号：学科 + 该试卷内序号，如「物理3」 */
export function questionTag(subject: string | null | undefined, indexInPaper: number): string {
  return `${subjectName(subject)}${indexInPaper}`
}

/** 答案框编号：题目编号规则 + 「答案」，如「物理3答案」 */
export function answerTag(subject: string | null | undefined, indexInPaper: number): string {
  return `${questionTag(subject, indexInPaper)}答案`
}
