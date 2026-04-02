import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PreprodConfig } from './config.js';
import { createLogger } from './logger-utils.js';
import {
  createAndFundWallet,
  buildProviders,
  deployVault,
  joinVault,
  generateOwnerKey,
  fromHexString,
  toHexString,
  encodeSecret,
  getWalletBalance,
  waitForFunds,
  type WalletContext,
} from './api.js';
import { printBanner, runCLI } from './cli.js';

const SESSION_FILE = path.resolve('./vault-session.json');
const WALLET_SEED_FILE = path.resolve('./wallet-seed.json');

interface VaultSession {
  contractAddress: string;
  ownerSecretKeyHex: string;
}

interface WalletSeed {
  seed: string;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

const loadSession = async (): Promise<VaultSession | null> => {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf-8');
    return JSON.parse(raw) as VaultSession;
  } catch {
    return null;
  }
};

const saveSession = async (session: VaultSession): Promise<void> => {
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
};

const loadWalletSeed = async (): Promise<string | null> => {
  try {
    const raw = await fs.readFile(WALLET_SEED_FILE, 'utf-8');
    const data = JSON.parse(raw) as WalletSeed;
    return data.seed;
  } catch {
    return null;
  }
};

const saveWalletSeed = async (seed: string): Promise<void> => {
  await fs.writeFile(WALLET_SEED_FILE, JSON.stringify({ seed }, null, 2), 'utf-8');
};

const displayBalance = async (walletCtx: WalletContext) => {
  try {
    const balance = await getWalletBalance(walletCtx.wallet);
    console.log(`\n  💰 Current Wallet Balance:`);
    console.log(`     Unshielded: ${balance.unshielded.toLocaleString()} tNight`);
    console.log(`     Dust:       ${balance.dust.toLocaleString()} DUST\n`);
  } catch (err) {
    console.error('  ❌ Failed to fetch balance:', (err as Error).message);
  }
};

const main = async () => {
  const config = new PreprodConfig();
  const logger = await createLogger(config.logDir);

  printBanner();
  console.log('  🌙 Connecting to Midnight Preprod network...\n');

  let walletSeed = await loadWalletSeed();
  if (walletSeed) {
    console.log('  📂 Found saved wallet seed in wallet-seed.json');
    const useSaved = await rl.question('  Use saved seed? (yes/no): ');
    if (!useSaved.toLowerCase().startsWith('y')) {
      walletSeed = null;
    }
    console.log('');
  }

  if (!walletSeed) {
    const inputSeed = await rl.question('  Enter your wallet seed (leave empty to generate a new one): ');
    walletSeed = inputSeed.trim() || null;
    console.log('');
  }

  const walletCtx = await createAndFundWallet(config, logger, walletSeed || undefined);

  if (!walletSeed) {
    await saveWalletSeed(walletCtx.seed);
    console.log('\n  📁 New wallet seed saved to wallet-seed.json');
  }

  await displayBalance(walletCtx);

  let running = true;
  while (running) {
    console.log('  ┌──────────────────────────────────────┐');
    console.log('  │           WALLET & VAULT             │');
    console.log('  ├──────────────────────────────────────┤');
    console.log('  │  1. Check wallet balance             │');
    console.log('  │  2. Fund wallet from faucet          │');
    console.log('  │  3. Deploy or join vault contract    │');
    console.log('  │  4. Exit                             │');
    console.log('  └──────────────────────────────────────┘');
    console.log('');

    const choice = await rl.question('  → Choose an option (1-4): ');
    console.log('');

    switch (choice.trim()) {
      case '1':
        await displayBalance(walletCtx);
        break;
      case '2': {
        const address = walletCtx.unshieldedKeystore.getBech32Address();
        console.log(`\n  💧 Faucet: https://faucet.preprod.midnight.network/?address=${address}`);
        console.log('  ⏳ Waiting for tokens to arrive (this may take a few minutes)...');
        await waitForFunds(walletCtx.wallet);
        console.log('  ✅ Tokens received!');
        await displayBalance(walletCtx);
        break;
      }
      case '3': {
        try {
          const existingSession = await loadSession();
          let mode: 'new' | 'resume' = 'new';

          if (existingSession) {
            console.log(`  📂 Found existing vault session: ${existingSession.contractAddress}`);
            const resumeChoice = await rl.question('  Resume existing session? (yes/no): ');
            if (resumeChoice.toLowerCase().startsWith('y')) mode = 'resume';
            console.log('');
          }

          const providers = await buildProviders(config, walletCtx, logger);

          let contract;
          let contractAddress: string;

          if (mode === 'resume' && existingSession) {
            const ownerKey = fromHexString(existingSession.ownerSecretKeyHex);
            const secretInput = await rl.question('  Enter your vault secret to reconnect: ');
            const secretBytes = encodeSecret(secretInput);

            contract = await joinVault(
              providers,
              existingSession.contractAddress as any,
              ownerKey,
              secretBytes,
              logger,
            );
            contractAddress = existingSession.contractAddress;
            console.log('\n  ✅ Reconnected to your vault!\n');
          } else {
            const ownerKey = generateOwnerKey();
            contract = await deployVault(providers, ownerKey, logger);
            contractAddress = (contract as any).deployTxData?.public?.contractAddress ?? 'unknown';

            await saveSession({
              contractAddress,
              ownerSecretKeyHex: toHexString(ownerKey),
            });

            console.log('\n  📁 Session saved to vault-session.json');
            console.log('  ⚠  Keep this file private — it contains your owner key!\n');
          }

          await runCLI(contract, contractAddress, providers, logger, rl);
        } catch (err) {
          console.error('\n  ❌ Vault operation failed:', (err as Error).message);
          if ((err as Error).message.includes('Failed to prove')) {
            console.log('     Hint: Make sure your proof server is running at http://127.0.0.1:6300');
          }
        }
        break;
      }
      case '4':
        console.log('  👋 Goodbye!\n');
        running = false;
        break;
      default:
        console.log('  ⚠  Invalid choice. Try again.\n');
    }
  }

  rl.close();
  process.exit(0);
};

main().catch((err) => {
  console.error('\n  💥 Fatal error:', err.message ?? err);
  process.exit(1);
});
