/**
 * `/teamflow-brainstorm` 技能注册（2026-10-23）。
 *
 * **为什么自己做**：superpowers 的 `brainstorming` 用 "You MUST use this before any creative work"
 * 强制**模型自触发** ⇒ 每个新需求都被拦下来讨论一轮（真机实锤：用户说「开始做流年推演吧」
 * 就被拉进多轮澄清）。而且它最后会出完整 design doc + invoke 它自己的 writing-plans，
 * 与我们的「技术方案」阶段重叠。
 *
 * 我们这版反过来：
 * - `modelInvocable: false` —— **模型不许自己进**，只有用户敲 `/teamflow-brainstorm` 才进；
 * - `userInvocable: true` —— 出现在人的命令目录里；
 * - 产出只到「需求 + 验收 + 非目标/反面目标」，**不碰架构**（那是 tech 阶段的活）；
 * - 最后一句指向 `teamflow_start`，与流水线接上。
 *
 * 名字用 `teamflow-brainstorm` 而不是 `brainstorm`：用户机器上已有 `brainstorming`
 * （`~/.agents/skills/`，superpowers 装的），两个名字太近会让人敲错、也让模型在目录里看到两个近义项。
 *
 * ⚠️ 注册是**尽力而为**：`skills` 服务缺失（最小 profile）、名字被占（宿主的 reserved/duplicate
 * 会 throw）、字段不合规 —— 任何一种都只返回 false，**绝不让插件加载失败**。理由与该插件其余
 * 可选能力一致（`ctx.inject` 的所有用法都是「缺失即降级，不阻塞」）。
 */
import { brainstormSkillPrompt } from '../prompts/index.ts'

export const BRAINSTORM_SKILL_NAME = 'teamflow-brainstorm'

/** 注册面用的最小鸭子类型（不 import 宿主类型：本模块只拿得到 ctx.get 的结果）。 */
interface SkillRegistryLike {
  register?: (skill: unknown) => unknown
}

/**
 * 把 `/teamflow-brainstorm` 注册进宿主 skill 注册表。
 * @returns 是否真的注册成功（失败即降级，不抛）。
 */
export function registerBrainstormSkill(skills: unknown): boolean {
  const reg = skills as SkillRegistryLike | null | undefined
  if (!reg || typeof reg.register !== 'function') return false
  try {
    reg.register({
      name: BRAINSTORM_SKILL_NAME,
      description:
        'Think a requirement through with the user before it enters the TeamFlow pipeline, then output a requirement text to hand to teamflow_start. User-invoked only.',
      // `SkillSource` 的合法值含 'runtime'（虚拟 skill，没有磁盘文件）。
      source: 'runtime',
      content: brainstormSkillPrompt(),
      // 关键：模型不可自触发。少了这一行，它就会变成第二个「每个需求先讨论一轮」的强制入口。
      invocation: { modelInvocable: false, userInvocable: true },
    })
    return true
  } catch (e) {
    return false
  }
}
