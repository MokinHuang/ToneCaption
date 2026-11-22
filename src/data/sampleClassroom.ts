import type { ClassroomSession } from '../types'

/** 课堂示例 · 取自策划书「这周五交」案例（1.1 节 / 5.3 节 / 6.2 节）。
 *  第一阶段为本地静态数据；第二阶段由 SenseVoice / ASR 的真实语段替换。 */
export const sampleClassroomSession: ClassroomSession = {
  id: 'class-demo',
  title: '课堂字幕',
  scene: '语文课 · 作业截止时间',
  currentId: 's03',
  segments: [
    {
      id: 's01',
      text: '大家觉得哪天合适？',
      start: 4.1,
    },
    {
      id: 's02',
      text: '这周五交？',
      start: 8.2,
      tone: '可能在征求确认',
      evidence: '承接前面的提问，句末上扬',
    },
    {
      id: 's03',
      text: '有冲突的同学今天下课前告诉我。',
      start: 11.0,
    },
  ],
}