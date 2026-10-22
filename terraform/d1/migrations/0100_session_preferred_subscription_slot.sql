-- The pool slot a session prefers (`claude-3`), chosen when it was forked onto a
-- named subscription. A launch passes it to the sandbox, whose slot picker uses
-- it unless the slot is refused or exhausted. A slot name only, never a
-- credential; NULL lets the picker choose by headroom, as for every other session.
ALTER TABLE sessions ADD COLUMN preferred_subscription_slot TEXT;
