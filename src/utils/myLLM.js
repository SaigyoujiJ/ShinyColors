/**
 * 自有 LLM 兜底翻译层。
 *
 * - 配置只保存在本机 localStorage（键 sczh:llm），不会写进仓库或提交。
 * - baseUrl 使用 OpenAI Chat Completions 兼容协议（OpenAI / DeepSeek / 通义 / 本地 Ollama 代理等）。
 * - apiKey 可以留空：此时请求发给你自己的后端代理，由后端持有密钥，更安全。
 * - 每次调用必须返回与输入等长、顺序一一对应的数组，否则整批视为失败并放弃兜底。
 */
import request from './request'

const STORE_KEY = 'sczh:llm'

const DEFAULTS = {
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  // false = 保留彩云作为第三层，自有 LLM 作为第四层；true = 跳过彩云，自有 LLM 直接当第三层
  skipCaiyun: false
}

const readConfig = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    return Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {})
  } catch (e) {
    return Object.assign({}, DEFAULTS)
  }
}

const saveConfig = (patch) => {
  const next = Object.assign(readConfig(), patch)
  localStorage.setItem(STORE_KEY, JSON.stringify(next))
  return next
}

/** 由 Violentmonkey 菜单触发，在本机填写配置 */
const setupLLMConfig = () => {
  const c = readConfig()
  const baseUrl = prompt('LLM BaseURL（OpenAI 兼容，末尾不要带斜杠）', c.baseUrl)
  if (baseUrl === null) return
  const apiKey = prompt('API Key（留空 = 由你的后端代理持有密钥）', c.apiKey)
  if (apiKey === null) return
  const model = prompt('模型名', c.model)
  if (model === null) return
  const skip = confirm(
    '是否跳过彩云机翻，直接使用自有 LLM？\n\n' +
    '【确定】跳过彩云 → 自有 LLM 成为第三层\n' +
    '【取消】保留彩云 → 彩云失败后自有 LLM 才作为第四层兜底'
  )
  saveConfig({
    enabled: true,
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    apiKey: apiKey.trim(),
    model: model.trim(),
    skipCaiyun: skip
  })
  alert('配置已保存到本机。\n请确认游戏地址带有 #auto=on，否则任何机翻层都不会触发。')
}

const SYSTEM_PROMPT = [
  '你是日译中游戏剧情翻译器。输入是一个 JSON 字符串数组，每个元素是一句日语台词。',
  '输出必须是严格的 JSON 字符串数组，长度与输入完全一致，顺序一一对应。',
  '规则：只输出数组本身，不要解释、不要 Markdown 代码块；',
  '保留每个元素内部的换行符 \\n；不要合并或拆分句子，不要增删元素；',
  '台词中的人名、偶像名与游戏专有名词使用简体中文常用译名；',
  '保持原文语气，中文表达自然流畅。'
].join('\n')

/**
 * 翻译一批句子。
 * @param {string[]} lines 逐句日文原文
 * @returns {Promise<string[]>} 等长译文数组；任何异常或格式不符返回 []
 */
const callLLM = async (lines) => {
  const c = readConfig()
  if (!c.enabled || !c.baseUrl || !lines.length) return []
  const headers = { 'Content-Type': 'application/json' }
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`
  const res = await request(`${c.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    data: JSON.stringify({
      model: c.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(lines) }
      ]
    })
  })
  let text = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content
  if (!text) return []
  text = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const arr = JSON.parse(text)
  if (!Array.isArray(arr) || arr.length !== lines.length) return []
  return arr.map(v => typeof v === 'string' ? v : '')
}

export { readConfig, saveConfig, setupLLMConfig, callLLM }
export default callLLM
