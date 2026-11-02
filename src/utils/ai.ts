import type { AiSettings } from '../types'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const PROVIDER_PRESETS: Record<Exclude<AiSettings['provider'], 'custom'>, { label: string; baseUrl: string; model: string }> = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }
}

async function chat(config: AiSettings, messages: ChatMessage[], maxTokens = 1024): Promise<string> {
  if (!config.apiKey) throw new Error('尚未配置 API 密钥，请先在「设置」中填写 AI 接口信息')
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 401) throw new Error('API 密钥无效（401），请检查密钥是否正确')
      if (response.status === 429) throw new Error('调用频率或额度受限（429），请稍后再试')
      throw new Error(`AI 接口返回 ${response.status}：${detail.slice(0, 160)}`)
    }
    const data = await response.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    if (!content) throw new Error('AI 接口未返回内容')
    return content.trim()
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('AI 接口响应超时（45 秒），请稍后重试')
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

/** AI 生成参考答案 */
export async function generateAnswer(config: AiSettings, question: { text: string; subject: string; grade: string; type: string; answer: string }): Promise<string> {
  const content = await chat(config, [
    {
      role: 'system',
      content:
        '你是一位经验丰富的中小学教师。请为给定题目生成参考答案。要求：直接给出最终答案，选择题给出选项字母，填空/解答题给出完整答案要点；不要重复题目，不要输出多余的客套话；若信息不足以作答，请给出最合理的推断。'
    },
    {
      role: 'user',
      content: [questionPrompt(question.subject, question.grade, question.text, question.answer), `题型：${question.type || '未标注'}`].join('\n')
    }
  ])
  return stripFence(content)
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
    600
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
        content:
          '你是一位中小学教研专家。请用简洁中文分析这道题：1）考查的核心知识点；2）涉及的情境/物理模型或应用场景；3）解题的关键思路。分点作答，总字数控制在 250 字以内，不要复述题目原文。'
      },
      { role: 'user', content: questionPrompt(question.subject, question.grade, question.text, question.answer) }
    ],
    800
  )
  return stripFence(content)
}

/** 测试 AI 接口连通性 */
export async function testConnection(config: AiSettings): Promise<string> {
  return await chat(config, [{ role: 'user', content: '请回复“连接成功”四个字。' }], 64)
}
