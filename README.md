# 🔐 Private Vault 

> Zero-Knowledge Secret Storage on the Midnight Network

Private Vault lets you store and verify secrets on-chain **without ever revealing them**. The actual secret stays on your machine — only a ZK-proven hash commitment touches the blockchain.


---

## What it does

| Operation | What's on-chain | What stays local |
|-----------|----------------|-----------------|
| `storeSecret` | Hash commitment of your secret | Your actual secret |
| `verifySecret` | ZK proof of knowledge | The value being verified |
| `rotateSecret` | New hash commitment | Old secret + new secret |
| `clearVault` | Cleared state | Your owner key |

Every write to the blockchain is backed by a **Zero Knowledge proof** — validators confirm the operation is valid without seeing any private data.

## Privacy features used

- **`witness ownerSecretKey()`** — owner's secret key never leaves the local machine; the contract only ever sees a derived public key hash
- **`witness secretValue()`** — the secret value never leaves the local machine; the contract only stores a `persistentHash` of it
- **Private state** — `VaultPrivateState` stores `ownerSecretKey` and `currentSecret` locally via LevelDB, never submitted to the chain
- **No `disclose()` on sensitive data** — only hashes and booleans are disclosed on-chain

---

## Prerequisites

Make sure you have these installed before starting:

**1. Node.js 22+**
```bash
node --version
# Should show v22.x.x or higher
```

**2. Docker Desktop** (needed to run the proof server)
```bash
docker --version
# Should show Docker version X.X.X
```
Make sure Docker Desktop is **running** (not just installed).

**3. Compact compiler**
```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh

compact --version
# Should print the compiler version
```

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/private-vault.git
cd private-vault
```

### 2. Install dependencies

```bash
npm install
```

### 3. Compile the Compact contract

```bash
cd contract
npm run compile
npm run build
```

This generates the ZK circuit artifacts.

### 4. Start the proof server

Open a **separate terminal** and run:

```bash
docker run -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
```

Leave this running. It handles ZK proof generation locally.

---

## Running on Preprod

From the repo root:

```bash
cd vault-cli
npm run preprod
```

### First run (deploy a new vault)

1. The CLI generates a wallet and shows you a **faucet link**
2. Open the link in your browser to fund the wallet with test tokens
3. Press ENTER once funded
4. A new vault contract gets **deployed on Midnight Preprod**
5. A `vault-session.json` file is saved locally — **keep this safe**, it holds your owner key

### Returning run (resume existing vault)

If `vault-session.json` exists, you'll be asked if you want to resume. Say yes, enter your secret, and you're reconnected to your existing on-chain vault.

### Example session

```
  ╔══════════════════════════════════════════════════╗
  ║         🔐  P R I V A T E   V A U L T  🔐        ║
  ║      Zero-Knowledge Secret Storage on Midnight    ║
  ║                                                    ║
  ║   Your secrets stay on YOUR machine.              ║
  ║   Only ZK proofs touch the blockchain.            ║
  ╚══════════════════════════════════════════════════╝

  🌙 Connecting to Midnight Preprod network...

  Wallet created. Starting sync with preprod...
  Your shielded address: midnight1abc...
  Faucet: https://faucet.midnight.network/?address=midnight1abc...

  → Press ENTER when wallet is funded:

  ✓ Deploying vault contract
  📍 Vault contract address: 0xabc123...

  ┌──────────────────────────────────────┐
  │           VAULT OPERATIONS           │
  ├──────────────────────────────────────┤
  │  1. Store a secret                   │
  │  2. Verify my secret                 │
  │  3. Rotate (update) my secret        │
  │  4. Clear the vault                  │
  │  5. Exit                             │
  └──────────────────────────────────────┘

  → Choose an option (1-5): 1

  📝 Store a new secret
  ─────────────────────────────────────────────
  Your secret will be hashed locally. Only the
  hash commitment is stored on the blockchain.

  Enter a label for this secret: github-api-key
  Enter your secret value: ********

  ✓ Storing secret "github-api-key" on-chain (ZK proof generating...)

  ✅ Secret stored successfully!
  What went on-chain: SHA-256 hash of your secret
  What stayed local:  your actual secret value
  ZK proof verified:  you know the preimage of the hash
```

---

## Project structure

```
private-vault/
├── package.json              # Root monorepo config (npm workspaces)
├── tsconfig.json             # Shared TypeScript config
├── README.md
│
├── contract/                 # Compact smart contract
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── vault.compact     # The ZK contract (privacy lives here)
│       ├── index.ts          # Re-exports compiled contract
│       └── managed/          # Generated by `compact compile` (gitignored)
│           └── vault/
│               ├── index.cjs
│               ├── keys/
│               └── zkir/
│
└── vault-cli/                # TypeScript CLI application
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── preprod.ts        # Entry point — run with `npm run preprod`
        ├── api.ts            # Midnight network interaction layer
        ├── cli.ts            # Interactive CLI menu
        ├── witnesses.ts      # Private witness implementations
        ├── common-types.ts   # TypeScript type aliases
        ├── config.ts         # Network endpoint configuration
        ├── logger-utils.ts   # Pino logging setup
        └── index.ts          # Re-exports
```

---

## How the privacy works (technical)

The Compact contract declares two **witnesses**:

```compact
witness ownerSecretKey(): Bytes<32>;
witness secretValue(): Bytes<32>;
```

Witnesses are functions that the **local machine executes** — they are never sent to the network. The Compact compiler generates a ZK circuit that proves the circuit executed correctly using these witness values, without revealing them.

When you call `storeSecret`:
1. Your machine calls `secretValue()` locally → returns your secret bytes
2. The circuit computes `persistentHash(secret)` locally
3. Only `disclose(hash)` goes on-chain
4. A ZK proof is generated that proves: *"I ran this hash function on a valid input"*
5. Validators verify the proof — they never see the input

This is **Midnight's core privacy primitive** — zero-knowledge proofs over private witness data.

---

## Troubleshooting

**`compact: command not found`**
Re-run the Compact compiler install script and restart your terminal.

**`Could not find a working container runtime strategy`**
Docker Desktop isn't running. Open Docker Desktop and wait for it to fully start.

**`Wallet sync timeout`**
Preprod can be slow. Wait a minute and retry. Make sure the faucet transaction went through.

**`Not the vault owner` error**
Your `vault-session.json` owner key doesn't match the deployed contract. Either use the original session file or deploy a new vault.

**ZK proof generation is slow**
Normal! First-time proof generation can take 30–60 seconds as keys are loaded. Subsequent proofs are faster.

---

## License

Apache-2.0

# private-vault
