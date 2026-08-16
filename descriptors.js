/**
 * dsh-plugin-teamflow — Remote 描述符（纯数据，host 与 client 共用）。
 *
 * host 侧：通过 ctx.typert.register() 注册为 strict 本地调用定义（免 @Remote 装饰器）；
 * client 侧：通过 ctx.remote.$mount() 生成 `ctx.remote.teamflow.<method>` 调用面。
 * 两边使用同一份描述符，保证 endpoint（namespace/method）与 wire 参数一致。
 *
 * 参数规则：全部 src-json codec（宽松 JSON），wire 字段名 = host 方法参数名，
 * client 端按位置传参。src-json 参数允许省略（host 方法收到 undefined）。
 */

const json = { mode: 'src-json' }

const p = (name) => ({ name, wire: name, source: 'json', codec: json })

/**
 * @type {readonly import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor[]}
 */
export const TEAMFLOW_DESCRIPTORS = Object.freeze([
  {
    id: 'dsh-plugin-teamflow#teamflow/ping',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'ping',
    invocation: { kind: 'direct' },
    parameters: [],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/list',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/snapshot',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'snapshot',
    invocation: { kind: 'direct' },
    parameters: [p('runId')],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/start',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'start',
    invocation: { kind: 'direct' },
    parameters: [p('sessionId'), p('requirement'), p('options')],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/cancel',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'cancel',
    invocation: { kind: 'direct' },
    parameters: [p('runId')],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/backlog',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'backlog',
    invocation: { kind: 'direct' },
    parameters: [p('product')],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/backlogUpdate',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'backlogUpdate',
    invocation: { kind: 'direct' },
    parameters: [p('kind'), p('id'), p('to'), p('product'), p('reason')],
    result: json,
  },
  {
    id: 'dsh-plugin-teamflow#teamflow/resume',
    service: 'teamflow',
    namespace: 'teamflow',
    method: 'resume',
    invocation: { kind: 'direct' },
    parameters: [p('runId'), p('sessionId')],
    result: json,
  },
])

/** client 端 $mount 使用的贡献对象。 */
export const TEAMFLOW_REMOTE_CONTRIBUTION = Object.freeze({
  package: 'dsh-plugin-teamflow',
  descriptors: TEAMFLOW_DESCRIPTORS,
})
