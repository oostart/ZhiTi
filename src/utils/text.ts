/** 统一分点编号：把 1）/(1/1、/1. 等写成完整的（1），避免出现只有一半括号 */
export function normalizeNumberedList(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)[（(]\s*(\d{1,2})\s*[）)．.、:：]?/, '$1（$2）')
        .replace(/^(\s*)(\d{1,2})\s*[）)]/, '$1（$2）')
        .replace(/^(\s*)(\d{1,2})[、．]\s*/, '$1（$2）')
        .replace(/^(\s*)(\d{1,2})\.(?!\d)\s*/, '$1（$2）')
    )
    .join('\n')
}
