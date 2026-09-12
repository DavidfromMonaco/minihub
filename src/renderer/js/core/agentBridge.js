import { handleAgentRequest } from './agentRequests.js';

/**
 * Wire the agent channel's requests to the router. INTENT §8 sexies.
 *
 * WHY EVERY PATH ANSWERS
 * ----------------------
 * The main process is holding a socket open for this reply and a timer against
 * it. A request that throws on the way through therefore does not fail once —
 * it fails thirty seconds later, as a timeout, with the agent unable to tell a
 * refusal from a hung application. So an unexpected throw becomes an answer
 * like any other, which is the same reasoning `SequencerController` applies to
 * a Clip Editor request.
 *
 * Installed after the history has started, and that is not incidental: an
 * agent's undo has to step the same one linear history the keyboard steps.
 */
export function installAgentBridge(hub) {
  return hub.api?.onAgentRequest?.((message) => {
    Promise.resolve()
      .then(() => handleAgentRequest(hub, message?.request || {}))
      .catch((error) => ({ ok: false, reason: 'internal-error', message: String(error?.message || error) }))
      .then((result) => hub.api.agentRespond?.({ requestId: message?.requestId, result }))
      .catch(() => {});
  }) || null;
}
