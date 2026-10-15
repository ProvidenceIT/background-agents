# ADR 0005: Turn Admission Lives at the Session's Prompt Queue

## Status

Accepted

## Context

A session bound to a subscription home may serve a turn only for an actor eligible for that home,
under the home's trigger-kind and consent gates, and every served turn is audited. That rule was
enforced separately at each entry point: the HTTP prompt route, the WebSocket prompt handler, Slack
thread steering, child spawn and scheduled runs. Gaps were closed one channel at a time (5be1c9af,
eae31eb0, ca501f1a, 620dbe8e), and autofix still enqueued turns with no gate. The audit row was
written when the gate passed, before quota or queue limits could still refuse the turn.

Every later turn already passes through the session Durable Object's prompt queue, where usage quota
is admitted.

## Decision

1. **One Turn admission module, called at the prompt queue.** Later turns are admitted inside the
   session DO, wrapped around the enqueue: home gate → usage quota → enqueue → audit. Worker routes
   do not gate later turns; they only work out the actor and trigger kind and pass them through.
2. **Audit on accept.** `credential.auth_home_prompt` is written only for a turn that was enqueued.
3. **Access checks are not turns.** WebSocket token issuance and sandbox access use the same
   eligibility rule without recording a served turn.
4. **Creation uses the same module.** Create, child spawn and scheduled runs bind a home through the
   module's new-session operation, which shares the gate rules and the audit with later turns.
5. **The refusal contract is unchanged.** The DO returns the same status, code and message, and the
   Worker passes them through.

## Considered Options

- **Gate in each Worker route through one deeper function.** Rejected: "every channel is gated"
  would still depend on each route remembering to call it, which is the cause of the gaps above.

## Consequences

- A new channel that adds turns to a session is gated and audited by construction.
- The DO reads D1 for home eligibility on every turn of a session bound to a home (the WebSocket
  path already did).
- Route-level tests of the gate move to the module; each channel keeps one wiring test.
