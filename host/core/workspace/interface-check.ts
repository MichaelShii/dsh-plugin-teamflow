/**
 * host 侧**接口一致性核对**（2026-09-29）。
 *
 * 为什么必须有它：
 * 之前「接口对不对」完全靠 prompt 要求 QA 自己核对（qaPrompt 的 0a）。实测的尴尬是 ——
 * mercury 那轮 QA 确实做了核对，但**报告全文没提蓝图**，无从判断结论是「引自契约」还是
 * 「读代码读出来」。模型核对是**概率**，且不可复现。
 *
 * 而这类 bug 静态可查、代价极低：tf-mul4t5ga-ajs4i4（贪吃蛇）产出的 main.js 调用了
 * GameEngine 上不存在的 move()/render()/toggleRunning()/score，首帧 TypeError 直接死机，
 * 「文件存在 / 有 export」级别的检查却全绿。
 *
 * 做法（两端事实都来自代码，无一句来自模型描述）：
 *   ① 收集每个交付模块的真实导出（class 及其方法/字段 + 顶层 function/const + export {}）；
 *   ② 收集 import 绑定与 `const v = new X()` 的实例追踪；
 *   ③ 检查 `v.m()` / `importedFn()` 是否真在目标模块里存在 → 给出「文件:行号 成员」。
 * 只检查绑定了本项目导出的对象，所以 `document.getElementById` 之类不会被误报。
 *
 * ⚠️ 局限（如实说明）：正则级启发式，不做类型推断。动态属性（obj[k]）、继承成员、
 * `export * from` 重导出可能漏检或误报 ⇒ 本轮**只写日志、不参与判定**，观察期校准后再议。
 * 也**不治**「循环判定写反」「初始化漏调」那类（那归 host 加载检查 / 像素统计）。
 */
import { readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { listDeliverableFiles } from '../../util.ts'

const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'])
const MAX_ISSUES = 20

export interface InterfaceIssue {
  file: string
  line: number
  kind: 'member' | 'import-fn'
  expr: string
  target: string
}

export interface InterfaceCheck {
  status: 'ok' | 'mismatch' | 'skip' | 'error'
  files: number
  issues: InterfaceIssue[]
  ms: number
}

const norm = (p: string): string => p.split(sep).join('/')
const lineAt = (src: string, index: number): number => src.slice(0, index).split('\n').length

/** 扒出该文件导出的成员：类（含方法/字段）、顶层函数、顶层变量。纯函数，便于单测。 */
export function collectModuleExports(src: string): { classes: Map<string, Set<string>>; top: Set<string> } {
  const classes = new Map<string, Set<string>>()
  const top = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)([\s\S]*?)\n\}/g)) {
    const body = m[2]
    const members = new Set<string>()
    for (const mm of body.matchAll(/^\s{2,}(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(/gm)) members.add(mm[1])
    for (const mm of body.matchAll(/^\s{2,}(?:static\s+)?([A-Za-z_$][\w$]*)\s*=/gm)) members.add(mm[1])
    // `this.X = …`（构造函数字段赋值）也算成员 —— 漏这条会把 direction/speed/isRunning 这类
    // 真实字段误报成「不存在」（首版自测就因此多报 4 处）。
    for (const mm of body.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=/g)) members.add(mm[1])
    classes.set(m[1], members)
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) top.add(m[1])
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) top.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/)
      if (t.length) top.add((t[1] || t[0]).trim())
    }
  }
  return { classes, top }
}

/**
 * 对一份交付做接口一致性核对。
 * `skip` = 不足两个源文件（没有跨模块调用可查）—— 与「查了、没毛病」区分开。
 */
export function checkDeliverableInterfaces(
  root: string | null | undefined,
  maxIssues: number = MAX_ISSUES,
): InterfaceCheck {
  const t0 = Date.now()
  const out: InterfaceCheck = { status: 'error', files: 0, issues: [], ms: 0 }
  try {
    if (!root) { out.status = 'skip'; out.ms = Date.now() - t0; return out }
    const rels = listDeliverableFiles(root).filter((f) => SRC_EXT.has(extname(String(f)).toLowerCase()))
    out.files = rels.length
    if (rels.length < 2) { out.status = 'skip'; out.ms = Date.now() - t0; return out }

    const byPath = new Map<string, ReturnType<typeof collectModuleExports>>()
    const srcOf = new Map<string, string>()
    for (const rel of rels) {
      try {
        const s = readFileSync(resolve(root, rel), 'utf8')
        srcOf.set(rel, s)
        byPath.set(rel, collectModuleExports(s))
      } catch (e) { /* 单个文件读不了就跳过它 */ }
    }

    for (const rel of rels) {
      const src = srcOf.get(rel)
      if (!src) continue
      // import 绑定：localName → { target, orig }
      const bind = new Map<string, { target: string; orig: string }>()
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
        const target = norm(relative(root, resolve(dirname(resolve(root, rel)), m[2])))
        for (const part of m[1].split(',')) {
          const t = part.trim().split(/\s+as\s+/)
          if (!t.length || !t[0]) continue
          bind.set((t[1] || t[0]).trim(), { target, orig: t[0].trim() })
        }
      }
      // 实例追踪：const v = new X()
      const inst = new Map<string, string>()
      for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (bind.has(m[2])) inst.set(m[1], bind.get(m[2]).orig)
      }
      // ① 实例成员
      for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
        const obj = m[1]
        const member = m[2]
        if (!inst.has(obj)) continue
        const cls = inst.get(obj)
        let members: Set<string> | null = null
        for (const e of byPath.values()) if (e.classes.has(cls)) { members = e.classes.get(cls); break }
        if (!members || members.has(member)) continue
        out.issues.push({ file: rel, line: lineAt(src, m.index), kind: 'member', expr: `${obj}.${member}`, target: cls })
        if (out.issues.length >= maxIssues) break
      }
      // ② import 的顶层函数调用
      for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1]
        if (!bind.has(name)) continue
        const b = bind.get(name)
        const def = byPath.get(b.target)
        if (!def || def.top.has(b.orig) || def.classes.has(b.orig)) continue
        out.issues.push({
          file: rel, line: lineAt(src, m.index), kind: 'import-fn',
          expr: `${name}() ← ${b.target}`, target: b.target,
        })
        if (out.issues.length >= maxIssues) break
      }
      if (out.issues.length >= maxIssues) break
    }
    out.status = out.issues.length ? 'mismatch' : 'ok'
  } catch (e) {
    out.status = 'error'
  }
  out.ms = Date.now() - t0
  return out
}
