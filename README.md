# @openclaw/imajin-plugin

OpenClaw plugin for the [Imajin](https://jin.imajin.ai) sovereign identity and settlement network.

## What it does

Gives your OpenClaw agent access to the Imajin network through five tools mapping to Imajin's five primitives:

| Tool              | Primitive   | What it does                                                 |
| ----------------- | ----------- | ------------------------------------------------------------ |
| `imajin_identity` | Identity    | Look up DIDs, resolve handles, check trust graph connections |
| `imajin_attest`   | Attestation | List and create signed attestations                          |
| `imajin_transact` | Settlement  | Check MJNx/MJN balances, view transaction history            |
| `imajin_fair`     | Attribution | Inspect .fair manifests — who made what and who gets paid    |
| `imajin_discover` | Discovery   | Search the network for people, businesses, events, stubs     |

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "imajin": {
        "enabled": true,
        "config": {
          "nodeUrl": "https://jin.imajin.ai",
          "did": "did:imajin:...",
          "keypairPath": "/path/to/.jin-identity.json"
        }
      }
    }
  }
}
```

- **`nodeUrl`** (required) — URL of the Imajin node
- **`did`** (optional) — Agent's DID for authenticated requests
- **`keypairPath`** (optional) — Path to Ed25519 keypair for signing attestations

## Roadmap

- [ ] Memory corpus supplement — agent's attestation chain as searchable memory
- [ ] Entity context hook — auto-decorate prompts with Imajin identity context
- [ ] Background service — persistent node connection, auth refresh
- [ ] Webhook receiver — push Imajin events (messages, transactions) into agent sessions
- [ ] Chat bridge — send/receive messages as a DID via Imajin chat

## About Imajin

Imajin (今人) is sovereign technology infrastructure — federated identity, .fair attribution, MJN/MJNx settlement, and discovery. No subscriptions, no cloud dependency, no vendor lock-in.

- **Network:** [jin.imajin.ai](https://jin.imajin.ai)
- **Protocol:** [protocol.dfos.com](https://protocol.dfos.com)
- **Code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
