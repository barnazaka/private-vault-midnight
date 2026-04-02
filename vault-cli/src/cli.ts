/**
 * cli.ts
 *
 * The interactive command-line interface for Private Vault.
 * Handles user input and drives the vault operations.
 */

import type { Interface } from 'node:readline/promises';
import type { Logger } from 'pino';
import type { DeployedVaultContract, VaultProviders } from './common-types.js';
import {
  storeSecret,
  verifySecret,
  rotateSecret,
  clearVault,
  encodeSecret,
} from './api.js';

// ─── ASCII Banner ─────────────────────────────────────────────────────────────

export const printBanner = () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║         🔐  P R I V A T E   V A U L T  🔐        ║');
  console.log('  ║      Zero-Knowledge Secret Storage on Midnight    ║');
  console.log('  ║                                                    ║');
  console.log('  ║   Your secrets stay on YOUR machine.              ║');
  console.log('  ║   Only ZK proofs touch the blockchain.            ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
};

// ─── Readline Helpers ─────────────────────────────────────────────────────────

let activeRl: Interface;

const ask = (question: string): Promise<string> =>
  activeRl.question(question);

const askHidden = (question: string): Promise<string> => {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (char: string) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        process.exit();
      } else if (char === '\u007F') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
};

// ─── Main Menu ────────────────────────────────────────────────────────────────

export const runCLI = async (
  contract: DeployedVaultContract,
  contractAddress: string,
  providers: VaultProviders,
  logger: Logger,
  rl: Interface,
): Promise<void> => {
  activeRl = rl;
  console.log('');
  console.log(`  📍 Vault contract address: ${contractAddress}`);
  console.log('  (Save this address to reconnect to your vault later)');
  console.log('');

  let running = true;

  while (running) {
    console.log('  ┌──────────────────────────────────────┐');
    console.log('  │           VAULT OPERATIONS           │');
    console.log('  ├──────────────────────────────────────┤');
    console.log('  │  1. Store a secret                   │');
    console.log('  │  2. Verify my secret                 │');
    console.log('  │  3. Rotate (update) my secret        │');
    console.log('  │  4. Clear the vault                  │');
    console.log('  │  5. Exit                             │');
    console.log('  └──────────────────────────────────────┘');
    console.log('');

    const choice = await ask('  → Choose an option (1-5): ');
    console.log('');

    switch (choice.trim()) {
      case '1': {
        await handleStoreSecret(contract, logger);
        break;
      }
      case '2': {
        await handleVerifySecret(contract, logger);
        break;
      }
      case '3': {
        await handleRotateSecret(contract, logger);
        break;
      }
      case '4': {
        await handleClearVault(contract, logger);
        break;
      }
      case '5': {
        console.log('  👋 Vault locked. Goodbye.\n');
        running = false;
        break;
      }
      default: {
        console.log('  ⚠  Invalid choice. Try again.\n');
      }
    }
  }
};

// ─── Operation Handlers ───────────────────────────────────────────────────────

const handleStoreSecret = async (
  contract: DeployedVaultContract,
  logger: Logger,
): Promise<void> => {
  console.log('  📝 Store a new secret');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Your secret will be hashed locally. Only the');
  console.log('  hash commitment is stored on the blockchain.\n');

  const label = await ask('  Enter a label for this secret (e.g. "github-api-key"): ');
  const secret = await askHidden('  Enter your secret value: ');

  if (!label.trim() || !secret.trim()) {
    console.log('\n  ⚠  Label and secret cannot be empty.\n');
    return;
  }

  try {
    // Update private state with the new secret before the ZK proof
    const secretBytes = encodeSecret(secret);

    // The witness will read the current secret from private state
    // We need to update the in-memory private state
    await updatePrivateSecret(contract, secretBytes);

    await storeSecret(contract, label.trim(), secretBytes, logger);

    console.log('');
    console.log('  ✅ Secret stored successfully!');
    console.log('  ─────────────────────────────────────────────');
    console.log('  What went on-chain: SHA-256 hash of your secret');
    console.log('  What stayed local:  your actual secret value');
    console.log('  ZK proof verified:  you know the preimage of the hash\n');
  } catch (err) {
    console.log('\n  ❌ Failed to store secret:', (err as Error).message, '\n');
    logger.error(err);
  }
};

const handleVerifySecret = async (
  contract: DeployedVaultContract,
  logger: Logger,
): Promise<void> => {
  console.log('  🔍 Verify your secret');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Prove you know the secret without revealing it.\n');

  const secret = await askHidden('  Enter the secret to verify: ');

  if (!secret.trim()) {
    console.log('\n  ⚠  Secret cannot be empty.\n');
    return;
  }

  try {
    const secretBytes = encodeSecret(secret);
    await updatePrivateSecret(contract, secretBytes);

    const matches = await verifySecret(contract, logger);

    console.log('');
    if (matches) {
      console.log('  ✅ Secret VERIFIED! ✓');
      console.log('  ─────────────────────────────────────────────');
      console.log('  The ZK proof confirmed your secret matches');
      console.log('  the commitment stored on-chain.');
    } else {
      console.log('  ❌ Secret does NOT match.');
      console.log('  ─────────────────────────────────────────────');
      console.log('  The provided value is incorrect.');
    }
    console.log('');
  } catch (err) {
    console.log('\n  ❌ Verification failed:', (err as Error).message, '\n');
    logger.error(err);
  }
};

const handleRotateSecret = async (
  contract: DeployedVaultContract,
  logger: Logger,
): Promise<void> => {
  console.log('  🔄 Rotate your secret');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Prove you know the OLD secret, then set a new one.');
  console.log('  Both stay private. Only hashes touch the chain.\n');

  const oldSecret = await askHidden('  Enter your CURRENT secret: ');
  const newSecret = await askHidden('  Enter your NEW secret: ');

  if (!oldSecret.trim() || !newSecret.trim()) {
    console.log('\n  ⚠  Both fields are required.\n');
    return;
  }

  try {
    // For rotation: first witness call = old secret (verify), second = new secret (store)
    const oldBytes = encodeSecret(oldSecret);
    const newBytes = encodeSecret(newSecret);

    // Set up rotation witness context
    await updatePrivateStateForRotation(contract, oldBytes, newBytes);

    await rotateSecret(contract, logger);

    console.log('');
    console.log('  ✅ Secret rotated successfully!');
    console.log('  ─────────────────────────────────────────────');
    console.log('  Old hash: overwritten');
    console.log('  New hash: committed on-chain');
    console.log('  Old secret: never touched the blockchain\n');

    // Update local state to new secret
    await updatePrivateSecret(contract, newBytes);
  } catch (err) {
    console.log('\n  ❌ Rotation failed:', (err as Error).message, '\n');
    logger.error(err);
  }
};

const handleClearVault = async (contract: DeployedVaultContract, logger: Logger): Promise<void> => {
  console.log('  🗑  Clear the vault');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Prove ownership and wipe the stored secret hash.\n');

  const confirm = await ask('  Are you sure you want to clear the vault? (yes/no): ');

  if (confirm.toLowerCase() !== 'yes') {
    console.log('\n  Operation cancelled.\n');
    return;
  }

  try {
    await clearVault(contract, logger);
    console.log('');
    console.log('  ✅ Vault cleared. Secret hash removed from chain.\n');
  } catch (err) {
    console.log('\n  ❌ Failed to clear vault:', (err as Error).message, '\n');
    logger.error(err);
  }
};

// ─── Private State Helpers ────────────────────────────────────────────────────
// These update the LOCAL private state so witnesses return the right value.

const updatePrivateSecret = async (
  contract: DeployedVaultContract,
  secretBytes: Uint8Array,
): Promise<void> => {
  // Access the private state provider through the contract's providers
  // and update the currentSecret field before the next ZK proof generation
  const currentState = await (contract as any).providers.privateStateProvider.get(
    'vaultPrivateState',
  );
  if (currentState) {
    await (contract as any).providers.privateStateProvider.set('vaultPrivateState', {
      ...currentState,
      currentSecret: secretBytes,
    });
  }
};

const updatePrivateStateForRotation = async (
  contract: DeployedVaultContract,
  oldSecret: Uint8Array,
  newSecret: Uint8Array,
): Promise<void> => {
  // For rotation the witness will be called twice by the circuit
  // First call should return old secret, second should return new secret
  // We set currentSecret to old first, and the witness implementation
  // handles the rotation sequence via the rotationNewSecret field
  const currentState = await (contract as any).providers.privateStateProvider.get(
    'vaultPrivateState',
  );
  if (currentState) {
    await (contract as any).providers.privateStateProvider.set('vaultPrivateState', {
      ...currentState,
      currentSecret: oldSecret,
      rotationNewSecret: newSecret,
    });
  }
};
