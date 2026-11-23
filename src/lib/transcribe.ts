import type { TranscribeResult } from '../types'

const API_BASE = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/+$/, '')

export const EMOTION_LABEL: Record<string, string> = {
  neutral: '中性',
  happy: '高兴',
  sad: '低落',
  angry: '生气',
  fearful: '恐惧',
  disgusted: '厌恶',
  surprised: '惊讶',
}

export const EVENT_LABEL: Record<string, string> = {
  Laughter: '笑声',
  Applause: '掌声',
  BGM: '背景音乐',
  Cough: '咳嗽',
  Sneeze: '喷嚏',
  Cry: '哭声',
  Breath: '呼吸',
}

export function emotionLabel(e: string | null): string | null {
  if (!e) return null
  return EMOTION_LABEL[e] ?? e
}

export function eventLabel(e: string): string {
  return EVENT_LABEL[e] ?? e
}

/** 调用后端转写。失败时抛出带具体原因的错误，绝不回退示例。 */
export async function transcribeFile(
  file: File,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/transcribe`, { method: 'POST', body: form, signal })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(
      API_BASE
        ? `识别服务暂时无法连接（${API_BASE}）。请检查网络后重试。`
        : '识别服务暂时无法连接，请稍后重试。',
    )
  }
  if (!res.ok) {
    let detail: string | null = null
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      detail = null
    }
    if (detail) throw new Error(detail)
    if (res.status >= 500) {
      throw new Error(`识别服务暂时不可用（HTTP ${res.status}），请稍后重试。`)
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      throw new Error(
        `识别服务暂时无法连接（HTTP ${res.status}），请稍后重试；若持续出现请联系站点维护者。`,
      )
    }
    throw new Error(`识别失败（HTTP ${res.status}），请重试或查看后端日志`)
  }
  return (await res.json()) as TranscribeResult
}

/** 探测识别服务是否可用；请求失败或非 ok 状态视为不可用。 */
export async function checkTranscribeService(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`)
    if (!res.ok) return false
    const body = await res.json()
    return body?.status === 'ok'
  } catch {
    return false
  }
}