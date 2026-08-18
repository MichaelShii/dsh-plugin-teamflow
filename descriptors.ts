/**
 * dsh-plugin-teamflow — Remote 描述符（纯数据，host 与 client 共用）。
 *
 * host 侧：通过 ctx.typert.register() 注册为 strict 本地调用定义（免 @Remote 装饰器）；
 * client 侧：通过 ctx.remote.$mount() 生成 `ctx.remote.teamflow.<method>` 调用面。
 * 两边使用同一份描述符，保证 endpoint（namespace/method）与 wire 参数一致。
 *
 * 参数规则：全部宽松 JSON，wire 字段名 = host 方法参数名，client 端按位置传参；
 * 参数允许省略（host 方法收到 undefined）。
 *
 * codec 为什么用 strict：client 的 $mount 只接受 mode: 'strict' 描述符
 * （requireStrictDescriptor），src-json 会被拒（"field has no strict codec"）。
 * 本插件载荷本就是自由 JSON，因此 strict schema 用恒等 parse（不做形状校验；
 * host 侧 decode 仍会做 JSON 安全性检查，参数缺省语义与 src-json 一致）。
 */

import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** 恒等 parse：接受任意 JSON 值，原样返回。 */
const JSON_SCHEMA: { parse(value: unknown): unknown } = { parse: (value) => value }
/** 统一 strict codec（本插件所有参数/结果均为自由 JSON）。 */
const strict = {
  mode: 'strict' as const,
  typeSymbol: 'dsh-plugin-teamflow/types#Json',
  schema: JSON_SCHEMA,
}
type StrictCodec = typeof strict

const p = (name: string): InvocationParameter => ({ name, wire: name, source: 'json', codec: strict })

interface InvocationParameter {
  readonly name: string
  readonly wire: string
  readonly source: 'json'
  readonly codec: StrictCodec
}

export const TEAMFLOW_DESCRIPTORS: readonly InvocationDescriptor[] = Object.freeze([
  {
    id: 'dsh-plugin-teamflow#teamflow/ping',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'ping',
    invocation: { kind: 'direct' },
    parameters: [],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/list',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/snapshot',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'snapshot',
    invocation: { kind: 'direct' },
    parameters: [p('runId'), p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/start',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'start',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId'), p('requirement'), p('options')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/cancel',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'cancel',
    invocation: { kind: 'direct' },
    parameters: [p('runId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/backlog',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'backlog',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/backlogUpdate',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'backlogUpdate',
    invocation: { kind: 'direct' },
    parameters: [p('kind'), p('id'), p('to'), p('sessionId'), p('reason'), p('meta')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/assign',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'assign',
    invocation: { kind: 'direct' },
    parameters: [p('kind'), p('id'), p('role'), p('assignee'), p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/pause',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'pause',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/resumeSession',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'resumeSession',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/listTeams',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'listTeams',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/selectTeam',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'selectTeam',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId'), p('teamId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/getActiveTeam',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'getActiveTeam',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/clearTeam',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'clearTeam',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId')],
    result: strict,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/resume',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'resume',
    invocation: { kind: 'direct' },
    parameters: [p('runId'), p('sessionId')],
    result: strict,
  },
])

/** client 端 $mount 使用的贡献对象。 */
export const TEAMFLOW_REMOTE_CONTRIBUTION: {
  readonly package: string
  readonly descriptors: readonly InvocationDescriptor[]
} = Object.freeze({
  package: 'dsh-plugin-teamflow',
  descriptors: TEAMFLOW_DESCRIPTORS,
})
