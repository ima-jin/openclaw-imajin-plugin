# Harness horizon sync

The opt-in horizon publisher pushes local queue facts to an existing owning
loop through the signed `/api/loops` rail. The kernel never reads the harness,
gateway, sessions or transcripts. Inbound `/jin` claims are a separate feature.

The wire contract is `docs/loops-rail-contract.md` on kernel PR #2909
(`feat/2878-horizon-steps`). Zones are kernel projections, never published fields.
Local `head` is not a lease; local `near` is not proof of settled design.

The bridge's current `refs` and `pr` do not contain issue OUTCOMEs, release
containment or production deployment evidence. The publisher must not invent
these facts. A local `past` can report finished work and issue closure, but
cannot prove release or deployment. Full exit requires explicit evidence.
