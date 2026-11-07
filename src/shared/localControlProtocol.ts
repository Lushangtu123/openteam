export const OPENTEAM_CONTROL_PROTOCOL_VERSION = 1
export const OPENTEAM_CONTROL_DEFAULT_PORT = 19305
export const OPENTEAM_CONTROL_LEGACY_DEFAULT_PORT = 19826

export type OpenTeamControlConnectionState = 'disabled' | 'connecting' | 'connected' | 'disconnected'

export interface OpenTeamControlConnectionStatus {
  state: OpenTeamControlConnectionState
  port: number
  url?: string
  lastError?: string
}

export const OPENTEAM_CONTROL_CAPABILITIES = [
  'store.get',
  'chat.list',
  'chat.get',
  'chat.create',
  'chat.activate',
  'chat.initialize',
  'roles.batchAdd',
  'task.post',
  'task.wait',
  'task.read',
  'run.createAndPost',
  'agent.list',
  'agent.run',
  'agent.cancel',
  'agent.read',
] as const

export type OpenTeamControlCapability = typeof OPENTEAM_CONTROL_CAPABILITIES[number]

export interface ControlHttpCommand {
  id: string
  action: string
  payload?: unknown
  timeoutMs?: number
  profileId?: string
}

export interface ControlHttpResult {
  id: string
  ok: boolean
  data?: unknown
  error?: ControlErrorPayload
}

export interface ControlErrorPayload {
  code: string
  message: string
  hint?: string
  recoverable?: boolean
}

export interface ExtensionHello {
  type: 'hello'
  extensionVersion: string
  protocolVersion: typeof OPENTEAM_CONTROL_PROTOCOL_VERSION
  profileId: string
  capabilities: OpenTeamControlCapability[]
}

// What the extension asks of the daemon itself (local agents).
export interface ExtensionRequest {
  id: string
  action: 'agent.list' | 'agent.run' | 'agent.cancel' | 'agent.permission'
  payload?: Record<string, unknown>
}

// Progress of a local agent run, as the daemon streams it.
export type LocalAgentEvent =
  | { kind: 'started' }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind?: string; status: string }
  | { kind: 'plan'; entries: Array<{ content: string; status: string }> }
  | { kind: 'file'; action: 'read' | 'write'; path: string }
  | { kind: 'permission'; permissionId: string; title: string; toolKind?: string; options: Array<{ optionId: string; name: string; kind: string }> }
  | { kind: 'done'; output: string; stopReason?: string }
  | { kind: 'error' | 'cancelled'; message: string }

export interface LocalAgentInfo {
  id: string
  name: string
  type: string
  enabled: boolean
  cwdAllowlist: string[]
}

export type ExtensionControlMessage =
  | ExtensionHello
  | { type: 'result'; result: ControlHttpResult }
  | { type: 'request'; request: ExtensionRequest }

export type DaemonControlMessage =
  | { type: 'command'; command: ControlHttpCommand }
  | { type: 'response'; response: ControlHttpResult }
  | { type: 'agent-event'; runId: string; event: LocalAgentEvent }

export function controlSuccess(id: string, data?: unknown): ControlHttpResult {
  return { id, ok: true, ...(data === undefined ? {} : { data }) }
}

export function controlFailure(id: string, code: string, message: string, options: Pick<ControlErrorPayload, 'hint' | 'recoverable'> = {}): ControlHttpResult {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      ...options,
    },
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
