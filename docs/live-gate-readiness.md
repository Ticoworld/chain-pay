# Live-gate readiness (2026-10-19)

The automated suites exercise the chain and accounting logic, but they do not prove the live acceptance gates. Use the existing smoke playbooks for exact steps and record transaction hashes, submitted Journal Entry IDs, replay results, and failures there.

| Gate | Available now | Still needed | Playbook |
|---|---|---|---|
| Sepolia Safe → ERPNext → compliance export | Sepolia RPC and local ERPNext environment configured | Funded threshold-2 Safe with two externally controlled owners; owner A injected wallet, owner B WalletConnect wallet; WalletConnect project ID; Sepolia ETH for payment and execution | [two-instance Safe](phase-3-slice-e-walletconnect-interchange-smoke-playbook.md), [accounting](phase-3-slice-d-safe-accounting-smoke-playbook.md), [export](phase-4-compliance-export-smoke-playbook.md) |
| BTC A/A2/A3 | External Bitcoin testnet wallet available; Esplora and local ERPNext environment configured | Verify wallet can export fully signed raw transaction hex; fund it with testnet coins; use a fresh receive address; allow time for six confirmations | [watch](phase-5-slice-a-bitcoin-watch-smoke-playbook.md), [broadcast](phase-5-slice-a2-bitcoin-manual-broadcast-smoke-playbook.md), [accounting](phase-5-slice-a3-bitcoin-accounting-smoke-playbook.md) |
| SOL B1/B2A/B2B | Devnet RPC and local ERPNext environment configured | Funded devnet source, initialized durable-nonce account, nonce authority, separate funded fee payer, and external Ed25519 signer that exposes the exact message bytes | [watch](phase-5-slice-b1-solana-watch-smoke-playbook.md), [payment](phase-5-slice-b2a-solana-durable-nonce-payment-smoke-playbook.md), [accounting](phase-5-slice-b2b-solana-accounting-smoke-playbook.md) |

Do not place seed phrases, private keys, or wallet export files in this repository or the smoke notes. Keep transaction identifiers and public addresses as the evidence.
