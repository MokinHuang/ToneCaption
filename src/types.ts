/** 一条课堂字幕。字段与策划书 5.4 节的语段约定保持可映射：
 *  id 对应语段编号，tone 对应 tone_display，evidence 对应依据短行。
 *  第二阶段接入真实识别结果时，仅需把服务端语段映射为本结构。 */
export interface CaptionSegment {
  id: string
  text: string
  tone?: string
  evidence?: string
  /** 只有可靠声学线索、不足以推断语气时显示的短线索（与 tone 互斥） */
  cue?: string
  /** 会话起点后的秒，示例数据用于展示时间标记 */
  start?: number
  /** 实时收音：该段已提交、仍在识别 */
  pending?: boolean
  /** 实时收音：该段识别失败的具体原因 */
  error?: string
}

/** 句末音高实测值（本地规则提取，进语气分析详情）。 */
export interface PitchMeasurement {
  /** 句末连续浊音时长 */
  tailVoicedMs: number
  /** 上升趋势覆盖时长 */
  spanMs: number
  /** 净上扬（半音） */
  riseSemitones: number
  /** 句中基线频率 */
  baselineHz: number
  /** 句末锚点频率 */
  endHz: number
  /** 窗口内自相关置信度中位数 */
  confidence: number
}

/** 一段语气分析的完整中间量与结论（详情表可解释性核心）。 */
export interface ToneAnalysisDetail {
  textPattern: string | null
  textExcerpt: string | null
  suppressedBy: 'quoted' | 'reported-speech' | null
  pitch: PitchMeasurement | null
  pitchNullReason: string | null
  /** SenseVoice 声学情感，仅记录，不参与语气判断 */
  emotion: string | null
  contextPrevQuestion: string | null
  conclusion: 'tone' | 'cue-only' | 'none'
  reason: string
}

/** 实时收音的一段字幕（第三阶段 · 本地连续收音）。 */
export interface LiveSegment {
  seq: number
  status: 'pending' | 'done' | 'error'
  text: string
  error?: string
  audioSeconds: number
  /** 语气分析结果（异步补充，可能晚于正文） */
  tone?: string
  evidence?: string
  toneCue?: string
  toneDetail?: ToneAnalysisDetail
  metrics?: {
    /** 最后一个有效语音帧 → 判定停顿切段 */
    waitMs: number
    /** 切段 → 开始上传（前一段仍在识别时排队） */
    queueMs: number
    /** 开始上传 → 收到结果（网络 + 服务端推理） */
    uploadMs: number
    /** 最后一个有效语音帧 → 字幕显示（端到端） */
    latencyMs: number
    /** 正文显示 → 语气提示显示（仅分析给出提示时记录） */
    toneLatencyMs?: number
  }
}

export type MicPhase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'failed'

export interface ClassroomSession {
  id: string
  title: string
  scene: string
  segments: CaptionSegment[]
  currentId: string
}

/** 后端 /api/transcribe 的真实识别结果（第二阶段）。 */
export interface TranscribeSegment {
  text: string
  emotion: string | null
  events: string[]
}

export interface TranscribeResult {
  text: string
  emotion: string | null
  events: string[]
  language: string | null
  segments: TranscribeSegment[]
  raw: string[]
  duration_s: number
  device: string
}