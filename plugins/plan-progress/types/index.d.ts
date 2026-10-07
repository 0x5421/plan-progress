export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
export type PlanSubstep = { title: string; status: StepStatus }
export type PlanStep = { title: string; status: StepStatus; substeps: PlanSubstep[] }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
// one subagent shown as a state strip under a bar; depth 1 sits under its parent agent
export type AgentRun = {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'error'
  tool: string
  startedAt: number
  endedAt: number | null
  depth: number
}
export type Plan = {
  id: string
  title: string
  kind: 'plan' | 'todo'
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  agents?: AgentRun[]
  // when the current batch of agents all finished; their strips fold a few seconds later
  agentsDoneAt?: number | null
  // set when the person's next message retires a finished bar; it fades out, then leaves the list
  leavingAt?: number | null
  // the model finished it mid-turn; it turns done, with its sound, once the main turn ends
  isFinishing?: boolean
}

// another desktop session, as this session reads it from the shared folder: what it does now and its newest bar
// isLeaving: the person pressed ✕; the row dims for a moment, then leaves
export type OtherSession = { hostId: string; folder: string; label: string; state: 'working' | 'done' | 'needs_input'; since: number; bar?: Plan; isLeaving?: boolean }
export type OthersView = { rows: OtherSession[] }

declare module 'claude-code' {
  interface PluginState {
    'plan-progress': {
      plans: Plan[]
      // whether the bars show; also in $.store, so it holds across sessions
      isOpen: boolean
      // whether the decision, error and done sounds play; also in $.store
      sounds: boolean
      // bumped every second while agents run, so elapsed times and folding redraw
      tick: number
      // the bar style chosen with /progress-style, one of STYLE_IDS in hooks/styles.ts
      style: string
      // how subagent strips show: 'expanded', 'summary' or 'hidden'
      agentView: string
      // the other sessions that run, finished or wait on the person, each with its newest bar
      others: OthersView
      // whether those other sessions show above the prompt; also in $.store
      crossSessions: boolean
    }
  }
}
