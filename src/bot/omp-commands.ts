import type { AgentAvailableCommand } from '../agent/types';

// Process-level cache of the OMP slash-command list, keyed by scope. OMP
// pushes `available_commands_update` at run start and whenever command
// metadata changes; the bridge mirrors the latest snapshot here so `/help`
// can render native OMP commands without spawning a run.
const cache = new Map<string, AgentAvailableCommand[]>();

export function setOmpCommands(scope: string, commands: AgentAvailableCommand[]): void {
  cache.set(scope, commands);
}

export function getOmpCommands(scope: string): AgentAvailableCommand[] | undefined {
  return cache.get(scope);
}

/** Test hook: drop the cached command list for a scope. */
export function clearOmpCommands(scope: string): void {
  cache.delete(scope);
}