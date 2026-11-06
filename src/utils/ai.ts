import type { AiSettings } from '../types'
import { normalizeNumberedList } from './text'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatOptions {
  maxTokens?: number
  timeoutMs?: number
  temperature?: number
  model?: string
}

export const PROVIDER_PRESETS: Record<
  Exclude<AiSettings['provider'], 'custom'>,
  { label: string; baseUrl: string; model: string; visionModel: string }
> = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', visionModel: '' },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    visionModel: 'qwen-vl-max'
  }
}

/** 通用对话请求，content 支持纯文本或 OpenAI 多模态数组（文字 + 图片） */
export async function chat(config: AiSettings, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  if (!config.apiKey) throw new Error('尚未配置 API 密钥，请先在「设置」中填写 AI 接口信息')
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? 45000
  const usesVision = messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: options.model || config.model,
        messages,
        temperature: options.temperature ?? config.temperature,
        max_tokens: options.maxTokens ?? 1024,
        stream: false
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 401) throw new Error('API 密钥无效（401），请检查密钥是否正确')
      if (response.status === 429) throw new Error('调用频率或额度受限（429），请稍后再试')
      if (usesVision && (response.status === 400 || response.status === 415 || response.status === 422)) {
        throw new Error(
          `当前模型可能不支持图片输入（${response.status}），请在「设置」中填写支持识图的视觉模型。${detail.slice(0, 120)}`
        )
      }
      throw new Error(`AI 接口返回 ${response.status}：${detail.slice(0, 160)}`)
    }
    const data = await response.json()
    const raw = data?.choices?.[0]?.message?.content
    const content =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
          : ''
    if (!content.trim()) throw new Error('AI 接口未返回内容')
    return content.trim()
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`AI 接口响应超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`)
    }
    if ((error as Error).message.includes('Failed to fetch')) {
      throw new Error('无法连接 AI 接口：可能是网络不可达或浏览器跨域限制。桌面版（Tauri）中调用不受此限制')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function stripFence(text: string): string {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
}

function questionPrompt(subject: string, grade: string, text: string, answerHint?: string): string {
  return [
    subject || grade ? `试卷信息：${[subject, grade].filter(Boolean).join(' / ')}` : '',
    '题目内容：',
    text.slice(0, 4000),
    answerHint ? `\n参考答案（如有）：${answerHint}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export type AnswerMode = 'choice' | 'fill' | 'judge' | 'solution' | 'reading' | 'essay' | 'auto'

/** 按题型和题干判断作答方式；题型只是提示，题干特征可覆盖明显不准的题型 */
function detectAnswerMode(type: string, text: string): AnswerMode {
  const t = (type || '').trim()
  const plain = (text || '').replace(/\s+/g, '')
  const wantsProcess = /证明|说明理由|写出过程|解答过程|推导|论证|求证|求解|计算过程/.test(plain)
  const asksValue =
    /最大值|最小值|值域|取值范围|解析式|表达式/.test(plain) || /求[^。；]{0,32}(?:值|范围)/.test(plain)

  if (t === '作文题') return 'essay'
  if (t === '阅读理解') return 'reading'
  if (t === '判断题') return 'judge'
  if (t === '单选题' || t === '多选题') return 'choice'
  if (t === '解答题' || t === '计算题' || t === '实验题') {
    // 自动题型可能把「只留横线」的题判成解答题；没有过程要求时按填空处理
    if (!wantsProcess && !asksValue && /____|＿{2,}/.test(text)) return 'fill'
    return 'solution'
  }
  if (t === '填空题') return 'fill'

  // 题型为「其他」或未标注：按题干特征兜底
  if (/[ABCD][.．、]/.test(plain) && /（\s*）|\(\s*\)/.test(text)) return 'choice'
  if (/____|＿{2,}|（\s*）|\(\s*\)/.test(text) && !wantsProcess) return 'fill'
  if (/判断|正确的打|错误的打/.test(plain)) return 'judge'
  if (wantsProcess || asksValue) return 'solution'
  return 'auto'
}

const ANSWER_SYSTEM_PROMPT = [
  '你是一位阅卷经验丰富的中小学教师，负责写出可直接填入答题卡的参考答案。',
  '先判断题目实际问什么，再严格按题目要求作答；题目没有要求的解释一律不写。',
  '规则：',
  '1. 不复述题干，不写「答案：」「解析：」「解答：」等标签，不写客套话。',
  '2. 只要求结果的题（选择、填空、判断、求值等）只给最终结果；禁止写推导、举例、反例、知识点说明或逐项验证。',
  '3. 题目明确要求解答、证明、说明理由或写出过程时，才给出必要步骤和最终结论；步骤精简，不展开无关讨论。',
  '4. 多空、多小问按题目顺序给出，每个空/小问一行；保留题目要求的格式和单位。',
  '5. 数学公式必须用 LaTeX 书写：行内公式用 $...$ 包裹，独立成行的公式用 $$...$$ 包裹；不要只写裸命令（如 \\frac{1}{2}）让读者看到代码。',
  '6. 不要输出乱码、重复内容或与题目无关的文字。',
  '7. 即使信息不完整，也给出最可能的答案，不要写「不确定」「需补充信息」。',
  '8. 题型标注仅供参考；若与题目实际问法不符，以题目实际问法为准。',
  '9. 以题目最后的问句或横线处的要求为准，题目没有问的内容不要回答。'
].join('\n')

const ANSWER_MODE_RULES: Record<AnswerMode, string> = {
  choice:
    '本题为选择题：只输出选项字母。单选给 1 个字母；多选按字母连写（如 ACD）。不要输出选项内容、理由或「故选」。若题目同时要求说明理由，再简要补上；若与题目实际问法不符，以实际问法为准。',
  fill:
    '本题为填空题：只输出应填入横线的内容，按空的顺序逐条给出，有多个空时每个空一行。不要解释、推导或写「填：」。若题目同时要求说明理由，再简要补上；若与题目实际问法不符，以实际问法为准。',
  judge:
    '本题为判断题：只输出「正确」或「错误」，不要解释。若与题目实际问法不符，以实际问法为准。',
  solution:
    '本题需要解答过程：给出必要的步骤和最终结论，步骤精简；不写与解题无关的分析、举例或知识点总结，最终结果要明确。若题目实际只要求结果，则只给结果。',
  reading:
    '本题为阅读理解：按小问顺序逐条给出答案，每条一行，语言简洁，不要复述原文。',
  essay:
    '本题为作文题：给出立意与 3-5 条写作提纲，不写整篇作文。',
  auto:
    '先判断题目实际要求：只要结果（选择、填空、判断、求值）就只给最终结果；题目明确要求解答、证明、说明理由或写过程时，才给出必要过程。'
}

function cleanAnswer(raw: string, mode: AnswerMode): string {
  let text = stripFence(raw).replace(/\r\n/g, '\n').trim()
  text = text.replace(/^(?:[【\[]?\s*(?:参考答案|答案|解答|解析|答)\s*[】\]]?\s*[：:]?\s*)+/, '').trim()

  // 结果类题目：模型若仍补了解析，从「解析：」起整段丢弃
  if (mode === 'choice' || mode === 'fill' || mode === 'judge') {
    const kept: string[] = []
    for (const line of text.split('\n')) {
      if (/^\s*(?:解析|分析|详解|解答过程|说明|理由|考点|点评|注意)\s*[：:]/.test(line)) break
      kept.push(line)
    }
    text = kept.join('\n').trim()
  }

  // 选择题：首行只有字母时归一化为紧凑字母串（A、C → AC）
  if (mode === 'choice') {
    const first = text.split('\n')[0].trim().replace(/[（(【\s、，,．.：:]/g, '')
    if (/^[A-H]{1,4}$/.test(first)) text = first
  }

  // 判断题：首行是短答时归一化
  if (mode === 'judge') {
    const first = text.split('\n')[0].trim()
    if (first.length <= 8) {
      if (/正确|√|对/.test(first)) text = '正确'
      else if (/错误|×|不对/.test(first)) text = '错误'
    }
  }

  return normalizeNumberedList(text.replace(/\n{3,}/g, '\n\n').trim())
}

/** AI 生成参考答案：按题目实际问法决定只给结果还是给解答过程 */
export async function generateAnswer(
  config: AiSettings,
  question: { text: string; subject: string; grade: string; type: string }
): Promise<string> {
  const mode = detectAnswerMode(question.type, question.text)
  const userPrompt = [
    question.subject || question.grade ? `试卷信息：${[question.subject, question.grade].filter(Boolean).join(' / ')}` : '',
    `题型（仅供参考）：${question.type || '未标注'}`,
    `作答要求：${ANSWER_MODE_RULES[mode]}`,
    '题目内容：',
    question.text.slice(0, 4000)
  ]
    .filter(Boolean)
    .join('\n')

  const content = await chat(
    config,
    [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    { maxTokens: 2048, timeoutMs: 60000 }
  )
  return cleanAnswer(content, mode)
}

/** AI 推荐知识点，返回知识点名称数组 */
export async function recommendKnowledge(
  config: AiSettings,
  question: { text: string; subject: string; grade: string },
  existingNames: string[]
): Promise<string[]> {
  const content = await chat(
    config,
    [
      {
        role: 'system',
        content:
          '你是一位中小学教研专家。请依据题目内容推荐 2-4 个最贴切的知识点。优先使用候选知识点列表中的名称；若确实没有合适的，可补充简洁的新知识点名称（不超过 10 个字）。只返回 JSON 数组，例如 ["牛顿第二定律","受力分析"]，不要任何解释。'
      },
      {
        role: 'user',
        content: [
          questionPrompt(question.subject, question.grade, question.text),
          existingNames.length ? `候选知识点：${existingNames.slice(0, 80).join('、')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ],
    { maxTokens: 600 }
  )
  const cleaned = stripFence(content)
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      }
    } catch {
      /* fallthrough */
    }
  }
  return cleaned
    .split(/[，,、；;\n]/)
    .map((s) => s.replace(/["'[\]{}]/g, '').trim())
    .filter(Boolean)
    .slice(0, 4)
}

/** AI 题目理解：考察模型、应用场景、解题思路 */
export async function analyzeQuestion(config: AiSettings, question: { text: string; subject: string; grade: string; answer: string }): Promise<string> {
  const content = await chat(
    config,
    [
      {
        role: 'system',
        content: [
          '你是一位中小学教研专家。请用简洁中文分析这道题，分三点作答：',
          '（1）考查的核心知识点；',
          '（2）涉及的情境/物理模型或应用场景；',
          '（3）解题的关键思路。',
          '编号必须写成完整的全角括号「（1）（2）（3）」，左右括号都要有，不要写成 1）或 (1 这种缺一半括号的形式，也不要用其他编号样式。',
          '数学公式用 LaTeX：行内用 $...$ 包裹，不要写裸命令。',
          '总字数控制在 250 字以内，不要复述题目原文。'
        ].join('\n')
      },
      { role: 'user', content: questionPrompt(question.subject, question.grade, question.text, question.answer) }
    ],
    { maxTokens: 800 }
  )
  return normalizeNumberedList(stripFence(content))
}

/** 测试 AI 接口连通性 */
export async function testConnection(config: AiSettings): Promise<string> {
  return await chat(config, [{ role: 'user', content: '请回复“连接成功”四个字。' }], { maxTokens: 64 })
}
