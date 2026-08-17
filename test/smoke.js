/**
 * dsh-plugin-teamflow — smoke test（无外部依赖，node test/smoke.js 直接运行）。
 *
 * 1) 校验 TEAMFLOW_DESCRIPTORS 满足 typert registry 的 validateInvocation 规则
 *    （id/service/namespace/method/参数 wire 唯一/src-json codec/endpoint 唯一）
 * 2) 校验 client 模块导出形状（inject/apply）与 host 模块结构（默认导出 class）
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TEAMFLOW_DESCRIPTORS } from '../descriptors.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const assert = (cond, msg) => { if (!cond) { throw new Error(`assert failed: ${msg}`) } }

console.log('── 1) descriptors 校验（typert validateInvocation 规则）──')
assert(Array.isArray(TEAMFLOW_DESCRIPTORS) && TEAMFLOW_DESCRIPTORS.length === 8, '应有 8 个 Remote 描述符')
const endpoints = new Set()
const ids = new Set()
for (const d of TEAMFLOW_DESCRIPTORS) {
  assert(typeof d.id === 'string' && d.id.length > 0, `id 非空: ${d.id}`)
  assert(typeof d.service === 'string' && d.service.length > 0 && !d.service.includes('#'), `service 合法: ${d.service}`)
  assert(/^[A-Za-z0-9_$.-]+$/.test(d.namespace), `namespace 合法: ${d.namespace}`)
  assert(/^[A-Za-z0-9_$.-]+$/.test(d.method), `method 合法: ${d.method}`)
  assert(d.invocation && d.invocation.kind === 'direct', `direct invocation: ${d.method}`)
  assert(d.result && d.result.mode === 'strict' && typeof d.result.schema.parse === 'function', `strict result codec: ${d.method}`)
  const endpoint = `${d.namespace}/${d.method}`
  assert(!endpoints.has(endpoint), `endpoint 唯一: ${endpoint}`)
  assert(!ids.has(d.id), `id 唯一: ${d.id}`)
  endpoints.add(endpoint); ids.add(d.id)
  const wires = new Set()
  for (const p of d.parameters) {
    assert(/^[A-Za-z0-9_$.-]+$/.test(p.name), `参数名合法: ${p.name}`)
    assert(typeof p.wire === 'string' && p.wire.length > 0, `wire 合法: ${p.wire}`)
    assert(!wires.has(p.wire), `wire 不重复: ${p.wire}`)
    wires.add(p.wire)
    assert(p.source === 'json', `参数为 json: ${p.name}`)
    assert(p.codec && p.codec.mode === 'strict' && typeof p.codec.schema.parse === 'function', `参数 codec strict: ${p.name}`)
  }
}
ok(true, `${TEAMFLOW_DESCRIPTORS.length} 个描述符全部通过规则校验`)

console.log('── 2) client 模块结构 ──')
const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '../client/index.js'), 'utf8')
ok(/export const inject = \['remote', 'slots', 'sessions', 'locale'\]/.test(clientSrc), '导出 inject（remote/slots/sessions/locale）')
ok(/export async function apply/.test(clientSrc), '导出 async apply')
ok(/ctx\.remote\.\$mount\(TEAMFLOW_REMOTE_CONTRIBUTION\)/.test(clientSrc), 'apply 中 $mount Remote 贡献')
ok(/conversation\.view/.test(clientSrc), '注册 conversation.view tab')
ok(/conversation\.view'[\s\S]*id: 'teamflow'/.test(clientSrc), 'tab id=teamflow')
ok(/onDrop/.test(clientSrc) && /draggable/.test(clientSrc), '看板包含拖拽（onDrop/draggable）')

console.log('── 3) host 模块结构 ──')
const hostSrc = readFileSync(join(here, '../host/index.js'), 'utf8')
ok(/class TeamflowService extends TypertRemoteService/.test(hostSrc), 'TeamflowService extends TypertRemoteService')
ok(/static inject = \['agents', 'subagents', 'tokenMeter', 'typert', 'tools'\]/.test(hostSrc), 'static inject 完整')
ok(/ctx\.typert\.register\(\{[\s\S]*invocations: TEAMFLOW_DESCRIPTORS/.test(hostSrc), 'typert.register 注册 strict descriptors')
for (const m of ['ping', 'list', 'snapshot', 'start', 'cancel', 'backlog', 'backlogUpdate', 'resume']) {
  ok(new RegExp(`\\n  ${m}\\(`).test(hostSrc), `Remote 方法 ${m}()`)
}
ok(/export default TeamflowService/.test(hostSrc), '默认导出 TeamflowService')
ok(/from '\.\.\/descriptors\.js'/.test(hostSrc), 'import descriptors.js')
ok(/from '\.\.\/store\.js'/.test(hostSrc), 'import store.js（持久化层独立）')

console.log('── 3b) 断点续跑（v0.4.0）──')
ok(/loadJournals\(\)/.test(hostSrc), '构造时加载磁盘 journal')
ok(/interruptedCount/.test(hostSrc), '中断残留计数提示')
ok(/persistJournal\(journal\)/.test(hostSrc), 'checkpoint 落盘')
ok(/resumeRun\(/.test(hostSrc) && /interruptedPhaseOf\(/.test(hostSrc) && /buildResumeProducts\(/.test(hostSrc), 'resume 逻辑（起点/产物重建）')
ok(/resumed\(/.test(hostSrc) && /logSkip\(/.test(hostSrc), 'executePipeline 阶段跳过')
ok(/stage\.output = clip\(text, 50000\)/.test(hostSrc), '阶段产物全文记录（续跑重建上下文）')
const storeSrc = readFileSync(join(here, '../store.js'), 'utf8')
ok(/export function loadJournals/.test(storeSrc) && /export function persistJournal/.test(storeSrc) && /export function serializeJournal/.test(storeSrc), 'store.js 导出 journal 三件套')
ok(/status === 'running' \|\| j\.status === 'pending'/.test(storeSrc), 'loadJournals 中断标记逻辑（store.js）')

console.log('── 3c) 完成汇总投递（v0.5.0）──')
ok(/from '@deepseek-ai\/dsh-llm'/.test(hostSrc), 'import createUserMessage（dsh-llm）')
ok(/function deliverCompletion/.test(hostSrc), 'deliverCompletion 函数')
ok(/parent\.status === 'idle'\) parent\.followup\(message\)/.test(hostSrc), 'idle → followup 唤醒')
ok(/else parent\.inject\(message\)/.test(hostSrc), 'running → inject 注入')
ok(/kind: 'plugin',[\s\S]*plugin: 'dsh-plugin-teamflow',[\s\S]*form: 'notice'/.test(hostSrc), 'notice 来源标记（与 tool-jobs 同款）')
ok(/deliverCompletion\(journal, parent\)/.test(hostSrc), 'finally 中投递')
ok(/teamflow_resume/.test(hostSrc), '汇报文本引导断点重跑')

console.log('── 3d) 防恶心人加固（v0.6.0）──')
ok(/parameterSchemaSpecToJsonSchema/.test(hostSrc), '工具 parameters 经 schema 编译（wire 带 type: object）')
ok(/function hasSubstance/.test(hostSrc) && /REFUSAL_PATTERN/.test(hostSrc), '假阳性检测（拒绝词 + 长度下限）')
ok(/STAGE_TOKEN_BUDGET = 60000/.test(hostSrc), '阶段 token 熔断预算 60k')
ok(/function isUnretryable/.test(hostSrc), 'context-limit 类失败不重试')
ok(/activeProducts/.test(hostSrc) && /已有流水线/.test(hostSrc), '产品级并发限制（防 req 状态互踩）')
ok(/summarizeTimeline\(/.test(hostSrc) && /delete s\.output/.test(hostSrc), '内存裁剪（timeline 摘要 + stage 删 output）')
ok(/readJsonAny\(journalFile\(id\)/.test(hostSrc), 'resume 从磁盘加载完整 journal')

console.log('── 4) 其他文件 ──')
for (const f of ['../cordis.patch.yml', '../package.json', '../README.md', '../descriptors.js', '../client/index.js', '../host/index.js', '../store.js']) {
  ok(existsSync(join(here, f)), `存在 ${f}`)
}

console.log('── 5) 安全加固（v0.3.1，持久化逻辑位于 store.js）──')
const patchSrc = readFileSync(join(here, '../cordis.patch.yml'), 'utf8')
ok(!/teamflow-client/.test(patchSrc), 'cordis.patch.yml 不再声明 client host row（自动扫描）')
ok(/- insert:/.test(patchSrc), 'patch 用 insert 块（顶层 - id: 是替换语义会静默跳过）')
ok(/name: 'dsh-plugin-teamflow'/.test(patchSrc) && !/name: 'dsh-plugin-teamflow\/host'/.test(patchSrc), 'entry 名用包根（子路径行导致 clientModules 扫不到 dsh.client）')
ok(/s\.includes\('\.\.'\)/.test(hostSrc), 'normalizeRoot 拒绝 .. 穿越段')
ok(/s\.startsWith\('\/'\)/.test(hostSrc) && /\^\[a-zA-Z\]:/.test(hostSrc), 'normalizeRoot 拒绝绝对路径/盘符')
ok(/copyFileSync\(file, file \+ '\.bak'\)/.test(storeSrc), '写前保留 .bak 备份')
ok(/renameSync\(tmp, file\)/.test(storeSrc), '原子写（.tmp → rename）')
ok(/从 \.bak 恢复/.test(storeSrc), '主文件损坏自动从 .bak 恢复')

console.log(failed === 0 ? '\n✅ smoke 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
