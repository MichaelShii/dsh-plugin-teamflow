/**
 * dsh-plugin-teamflow core — 产品线（product line）装配。
 *
 * 全局面板（侧边栏图标 + root `main` 面板）没有会话上下文：宿主据产品线 key
 * （`$DSH_HOME/teamflow/<key>/`）装配「产品线清单 / 产品线视图 / run 摘要」，
 * 与按 sessionId 寻址的路由**共用同一批 journal 与 state.json**（同源、不新增数据模型）。
 *
 * 依赖方向：types/constants/util → store → core/*；本文件只依赖 store、core/context、core/state。
 */
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { teamflowRoot } from '../../store.ts'
import type { JournalRecord } from '../../store.ts'
import { clip, normalizeRoot } from '../util.ts'
import { runs } from './context.ts'
import { loadState } from './state.ts'

/** 按产品线 key 过滤运行（未落 workspace 的旧运行只见于 default）。 */
export function runsFor(ws: string | null | undefined) {
  const arr: JournalRecord[] = []
  for (const j of runs.values()) {
    const rec = j as JournalRecord
    if (ws) {
      const jws = rec.workspace || (ws === 'default' ? 'default' : null)
      if (jws !== ws) continue
    }
    arr.push(rec)
  }
  arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return arr
}

/** run 详情地址（host 生成，client 直接交给右侧栏 openResource——与产物地址同一条原则：
 *  地址里的产品线 + runId 由 host 决定，client 不拼地址、不引宿主包）。 */
export function runAddress(product: string | null | undefined, runId: string): string {
  return `dsh-resource://teamflow/run/${encodeURIComponent(String(product || 'default'))}/${encodeURIComponent(String(runId))}`
}

/** 产品线 key 归一化：复用工具层白名单（拒绝盘符/穿越/空白），非法 → null。 */
export function productKeyOf(product: unknown): string | null {
  return normalizeRoot(product)
}

/** 该 run 是否属于该产品线（无 workspace 的旧 run 只在 default 兜底可见）。 */
export function runVisibleIn(j: JournalRecord, key: string): boolean {
  return !j.workspace || j.workspace === key || key === 'default'
}

/** 单 run 官方口径 usage 汇总（run 列表展示；stage 级明细仍走 snapshot）。 */
export function runUsageSum(j: JournalRecord) {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  for (const s of (j.stages || [])) {
    const u = s && s.usage
    if (!u) continue
    t.input += u.input || 0
    t.cacheRead += u.cacheRead || 0
    t.cacheWrite += u.cacheWrite || 0
    t.output += u.output || 0
    t.calls += u.calls || 0
  }
  return t
}

/** run 摘要（list() 与 productView() 共用同一形状）。 */
export function runBrief(j: JournalRecord) {
  const stages = j.stages || []
  return {
    id: j.id,
    status: j.status,
    mode: (j.options && (j.options as { mode?: string }).mode) || null,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    agentsStarted: j.agentsStarted,
    stageCount: stages.length,
    doneStages: stages.filter((x) => x.status === 'done').length,
    incompleteStages: stages.some((x) => x.status !== 'done'),
    requirement: clip(j.requirement, 60),
    usage: runUsageSum(j),
    address: runAddress(j.workspace || 'default', j.id),
    // 发起会话：右栏 run tab 要挂到它所属的会话（而不是"用户当前所在的会话"）
    ownerSession: j.ownerSession || null,
  }
}

/** 单产品线元信息（产品线清单与产品线视图共用）。 */
export function productMetaOf(key: string) {
  const js = runsFor(key)
  const st = loadState(key)
  const path = ((js.find((j) => j.workspacePath) || {}) as { workspacePath?: string | null }).workspacePath || null
  const lastRun = (st.lastRun || null) as { requirement?: string | null; verdict?: string | null } | null
  return {
    key,
    title: st.projectName || (path ? String(path).replace(/\\/g, '/').split('/').filter(Boolean).pop() : key),
    path,
    updatedAt: st.updatedAt || (js[0] ? (js[0].endedAt || js[0].startedAt || null) : null),
    totalRuns: js.length,
    activeRuns: js.filter((j) => j.status === 'running' || j.status === 'pending').length,
    lastRequirement: (lastRun && lastRun.requirement) ? clip(lastRun.requirement, 80) : (js[0] ? clip(js[0].requirement, 80) : null),
    lastVerdict: (lastRun && lastRun.verdict) || null,
  }
}

/** 产品线清单：`$DSH_HOME/teamflow` 下带 `backlog/` 或 `runs/` 的目录（无会话上下文也能用）。 */
export function listProducts() {
  const out: Array<ReturnType<typeof productMetaOf>> = []
  const root = teamflowRoot()
  let entries: Array<{ name: string; isDirectory(): boolean }> = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch (e) { return out }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'runs') continue
    let sub: string[] = []
    try { sub = readdirSync(join(root, ent.name)) } catch (e) { continue }
    if (!sub.includes('backlog') && !sub.includes('runs')) continue
    out.push(productMetaOf(ent.name))
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out
}
