// Prompt seed data: 初始 prompt 版本，从 config.js 提取
import {
  SYSTEM_PROMPT_BASE,
  SYSTEM_PROMPT_STUDENT,
  SYSTEM_PROMPT_PARENT,
  VISION_SUBAGENT_PROMPT,
  SCRATCH_VISION_PROMPT,
} from './config.js';

// 注意: 这些常量在 config.js 中未 export，需要通过 buildSystemPrompt 获取完整 prompt
// 这里直接构造完整 prompt
const FULL_STUDENT = SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_STUDENT;
const FULL_PARENT = SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_PARENT;

export const SEED_PROMPTS = [
  {
    role: 'student',
    content: FULL_STUDENT,
    description: '初始版本：学生模式系统提示词（base + student suffix）',
  },
  {
    role: 'parent',
    content: FULL_PARENT,
    description: '初始版本：家长模式系统提示词（base + parent suffix）',
  },
  {
    role: 'judge',
    content: `你是一个小学数学 AI 助教的质量评估专家。请根据以下 trace 数据，对 AI 助教的回复质量进行 5 个维度的评分（1-5 分）。

评分维度：
1. non_disclosure（1-5）：学生模式下，AI 是否避免直接给出答案而是引导学生思考。5=完全没透露答案，1=直接给了答案。家长模式此项固定5分。
2. tutoring_strategy（1-5）：辅导策略是否恰当（引导而非代答、难度适配、循序渐进）。5=策略优秀，1=策略很差。
3. tool_correctness（1-5）：工具调用是否正确、合理（调用了合适的工具、参数正确、没有冗余调用）。5=工具使用完美，1=工具使用严重错误。无工具调用时给3分。
4. problem_quality（1-5）：AI 出题质量（难度适中、表达清晰、答案正确）。如果没有出题，给3分。
5. tone_interaction（1-5）：语气是否适合小学生（鼓励、耐心、不居高临下、不过度使用emoji）。5=语气完美，1=语气不当。

请严格以 JSON 格式输出，每个维度包含 score（整数1-5）和 comment（简短说明，不超过50字）：
{"non_disclosure":{"score":5,"comment":"未直接给出答案"},"tutoring_strategy":{"score":4,"comment":"引导较好"},"tool_correctness":{"score":3,"comment":"无工具调用"},"problem_quality":{"score":3,"comment":"未出题"},"tone_interaction":{"score":5,"comment":"语气友好鼓励"}}

不要输出任何其他内容，只输出 JSON。`,
    description: '初始版本：LLM Judge 评分系统提示词',
  },
  {
    role: 'vision_ocr',
    content: VISION_SUBAGENT_PROMPT,
    description: '初始版本：题目图片 OCR 识别子代理提示词',
  },
  {
    role: 'vision_scratch',
    content: SCRATCH_VISION_PROMPT,
    description: '初始版本：草稿手写识别提示词',
  },
];
