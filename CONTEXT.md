# Open-Inspect

Background coding agents that run sessions in sandboxes against a team's repositories, paid for
either by a deployment's API keys or by a person's own subscription.

## Language

### Sessions and turns

**Session**: One agent conversation on a repository, with its own sandbox and history.

**Turn**: One prompt the agent works on in a session, whoever or whatever sent it (a person, a bot
relay, a schedule, an autofix). _Avoid_: message (a turn is a prompt plus the work it starts), run

**Trigger kind**: What sent a turn: a person's `prompt`, a bot's `mention`, `issue_label` or
`pr_event`, or the control plane's `child` or `schedule`.

### Subscription homes

**Subscription home**: A person's own provider subscription (Claude, Codex, Z.AI), registered so
sessions can spend it instead of the deployment's API keys. _Avoid_: auth home (code name only),
provider account

**Bound home**: The subscription home a session was assigned at creation; every later turn of that
session spends it.

**Turn admission**: The decision whether a turn may run on its session's bound home for this actor
and trigger kind, made once per turn, and recorded only when the turn is actually accepted. _Avoid_:
turn gate, auth-home check

**Access check**: Whether an actor may reach a session's bound home without sending a turn (opening
a socket, entering the sandbox). Same eligibility as turn admission, but it does not record a served
turn.

### Teams

**Thread conversation**: A Teams thread's link to one session. A thread has one main conversation
and at most one fork per person.

**Fork**: A thread conversation owned by one person, started when that person may not spend the main
conversation's bound home; their later replies in the thread go to it.
