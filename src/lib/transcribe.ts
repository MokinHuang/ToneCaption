import type { TranscribeResult } from '../types'

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
    res = await fetch('/api/transcribe', { method: 'POST', body: form, signal })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(
      '无法连接后端服务。请先在 backend 目录启动：uvicorn app:app --host 0.0.0.0 --port 8000',
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
      throw new Error(
        `无法连接后端服务（HTTP ${res.status}，后端可能未启动）。请在 backend 目录运行：uvicorn app:app --host 0.0.0.0 --port 8000`,
      )
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      throw new Error(
        `当前页面没有识别服务（HTTP ${res.status}）。线上演示站是静态页面，不含后端；识别自己的录音请在本地启动 npm run dev 与 backend 的 uvicorn（端口 8000）。`,
      )
    }
    throw new Error(`识别失败（HTTP ${res.status}），请重试或查看后端日志`)
  }
  return (await res.json()) as TranscribeResult
}

/** 探测本地识别服务是否可用；线上静态站会返回 404/HTML，视为不可用。 */
export async function checkTranscribeService(): Promise<boolean> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return false
    const body = await res.json()
    return body?.status === 'ok'
  } catch {
    return false
  }
}