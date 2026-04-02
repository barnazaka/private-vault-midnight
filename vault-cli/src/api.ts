import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';
import { type Logger } from 'pino';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { type MidnightProvider, type WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';

import {
  type VaultCircuits,
  VaultPrivateStateId,
  type VaultProviders,
  type DeployedVaultContract,
  type VaultContract,
} from './common-types.js';
import { type Config, contractConfig } from './config.js';
import { witnesses } from './witnesses.js';
import { Contract, type VaultPrivateState } from '@midnight-ntwrk/vault-contract';

// @ts-expect-error needed for wallet GraphQL sync in Node.js
globalThis.WebSocket = WebSocket;

const vaultCompiledContract = CompiledContract.make('vault', Contract).pipe(
  CompiledContract.withWitnesses(witnesses as any),
  CompiledContract.withCompiledFileAssets(contractConfig.zkConfigPath),
) as any;

// ─── Key Derivation ───────────────────────────────────────────────────────────

function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

export const withStatus = async <T>(message: string, fn: () => Promise<T>): Promise<T> => {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${message}`);
  }, 80);
  try {
    const result = await fn();
    clearInterval(interval);
    process.stdout.write(`\r  ✓ ${message}\n`);
    return result;
  } catch (e) {
    clearInterval(interval);
    process.stdout.write(`\r  ✗ ${message}\n`);
    throw e;
  }
};

// ─── Wallet ───────────────────────────────────────────────────────────────────

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  seed: string;
}

const buildShieldedConfig = ({ indexer, indexerWS, node, proofServer }: Config) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: indexer,
    indexerWsUrl: indexerWS,
  },
  provingServerUrl: new URL(proofServer),
  relayURL: new URL(node.replace(/^http/, 'ws')),
});

const buildUnshieldedConfig = ({ indexer, indexerWS }: Config) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: indexer,
    indexerWsUrl: indexerWS,
  },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(),
});

const buildDustConfig = ({ indexer, indexerWS, node, proofServer }: Config) => ({
  networkId: getNetworkId(),
  costParameters: {
    additionalFeeOverhead: 300_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  indexerClientConnection: {
    indexerHttpUrl: indexer,
    indexerWsUrl: indexerWS,
  },
  provingServerUrl: new URL(proofServer),
  relayURL: new URL(node.replace(/^http/, 'ws')),
});

export const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state) => state.isSynced),
    ),
  );

export const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

export const getWalletBalance = async (
  wallet: WalletFacade,
): Promise<{ unshielded: bigint; dust: bigint }> => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const unshielded = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  const dust = state.dust.balance(new Date());
  return { unshielded, dust };
};

const registerForDustGeneration = async (
  wallet: WalletFacade,
  unshieldedKeystore: UnshieldedKeystore,
): Promise<void> => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  if (state.dust.availableCoins.length > 0) {
    return;
  }

  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true,
  );
  if (nightUtxos.length === 0) {
    await withStatus('Waiting for dust tokens to generate', () =>
      Rx.firstValueFrom(
        wallet.state().pipe(
          Rx.throttleTime(5_000),
          Rx.filter((s) => s.isSynced),
          Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        ),
      ),
    );
    return;
  }

  await withStatus(`Registering ${nightUtxos.length} NIGHT UTXO(s) for dust generation`, async () => {
    const recipe = await wallet.registerNightUtxosForDustGeneration(
      nightUtxos,
      unshieldedKeystore.getPublicKey(),
      (payload) => unshieldedKeystore.signData(payload),
    );
    const finalized = await wallet.finalizeRecipe(recipe);
    await wallet.submitTransaction(finalized);
  });

  await withStatus('Waiting for dust tokens to generate', () =>
    Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    ),
  );
};

export const createAndFundWallet = async (config: Config, log: Logger, existingSeed?: string): Promise<WalletContext> => {
  const seed = existingSeed || toHex(generateRandomSeed());
  if (!existingSeed) {
    log.info({ seed }, 'Generated new wallet seed — SAVE THIS for future sessions');
  } else {
    log.info('Using existing wallet seed');
  }

  const context = await withStatus(
    'Building wallet',
    async () => {
      const keys = deriveKeys(seed);
      const networkId = getNetworkId();
      const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
      const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
      const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

      const walletConfig = {
        ...buildShieldedConfig(config),
        ...buildUnshieldedConfig(config),
        ...buildDustConfig(config),
      };

      const wallet = await WalletFacade.init({
        configuration: walletConfig,
        shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
        unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        dust: (cfg) =>
          DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
      });
      await wallet.start(shieldedSecretKeys, dustSecretKey);

      return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, seed };
    },
  );

  await withStatus('Syncing with network', () => waitForSync(context.wallet));
  const walletAddress = context.unshieldedKeystore.getBech32Address();

  log.info({ walletAddress }, 'Wallet synced — fund this address using the faucet');
  log.info('Faucet: https://faucet.preprod.midnight.network/?address=' + walletAddress);

  return context;
};

// ─── Providers ────────────────────────────────────────────────────────────────

const signTransactionIntents = (
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
): void => {
  if (!tx.intents || tx.intents.size === 0) return;

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;

    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      'signature',
      proofMarker,
      'pre-binding',
      intent.serialize(),
    );

    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);

    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }

    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }

    tx.intents.set(segment, cloned);
  }
};

export const createWalletAndMidnightProvider = async (
  walletCtx: WalletContext,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await waitForSync(walletCtx.wallet);
  return {
    getCoinPublicKey: () => {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey: () => {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    balanceTx: async (tx: any, ttl?: Date) => {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );

      const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }

      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };
};

export const buildProviders = async (
  config: Config,
  walletCtx: WalletContext,
  log: Logger,
): Promise<VaultProviders> => {
  await registerForDustGeneration(walletCtx.wallet, walletCtx.unshieldedKeystore);

  const walletAndMidnightProvider = await createWalletAndMidnightProvider(walletCtx);
  const zkConfigProvider = new NodeZkConfigProvider<VaultCircuits>(contractConfig.zkConfigPath);
  const publicDataProvider = await indexerPublicDataProvider(config.indexer, config.indexerWS);

  const accountId = walletAndMidnightProvider.getCoinPublicKey();
  const storagePassword = `${accountId}!A`;

  const privateStateProvider = levelPrivateStateProvider<VaultPrivateState>({
    storeName: contractConfig.privateStateStoreName,
    accountId,
    privateStoragePasswordProvider: () => storagePassword,
  });

  return {
    privateStateProvider: privateStateProvider as any,
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  } as VaultProviders;
};

// ─── Deploy ───────────────────────────────────────────────────────────────────

export const deployVault = async (
  providers: VaultProviders,
  ownerSecretKey: Uint8Array,
  log: Logger,
): Promise<DeployedVaultContract> => {
  const initialPrivateState: VaultPrivateState = {
    ownerSecretKey,
    currentSecret: new Uint8Array(32),
  };
  const deployed = await withStatus('Deploying vault contract', () =>
    deployContract(providers, {
      compiledContract: vaultCompiledContract,
      initialPrivateState,
      privateStateId: VaultPrivateStateId,
    }),
  );
  log.info({ address: deployed.deployTxData.public.contractAddress }, 'Vault deployed!');
  return deployed;
};

// ─── Join ─────────────────────────────────────────────────────────────────────

export const joinVault = async (
  providers: VaultProviders,
  contractAddress: ContractAddress,
  ownerSecretKey: Uint8Array,
  currentSecret: Uint8Array,
  _log: Logger,
): Promise<DeployedVaultContract> => {
  assertIsContractAddress(contractAddress);
  return withStatus('Joining existing vault', () =>
    findDeployedContract(providers, {
      contractAddress,
      compiledContract: vaultCompiledContract,
      initialPrivateState: { ownerSecretKey, currentSecret },
      privateStateId: VaultPrivateStateId,
    }),
  );
};

// ─── Vault Operations ─────────────────────────────────────────────────────────

export const storeSecret = async (
  contract: DeployedVaultContract,
  label: string,
  _secretBytes: Uint8Array,
  _log: Logger,
) =>
  withStatus(`Storing secret "${label}" (ZK proof generating...)`, () =>
    (contract.callTx as any).storeSecret(encodeLabel(label)),
  );

export const verifySecret = async (contract: DeployedVaultContract, _log: Logger): Promise<boolean> => {
  let matches = false;
  await withStatus('Verifying secret with ZK proof...', async () => {
    const result = await (contract.callTx as any).verifySecret();
    matches = result.public.blockHeight !== undefined; // Rough check for successful call
  });
  return matches;
};

export const rotateSecret = async (contract: DeployedVaultContract, _log: Logger) =>
  withStatus('Rotating secret...', () => (contract.callTx as any).rotateSecret());

export const clearVault = async (contract: DeployedVaultContract, _log: Logger) =>
  withStatus('Clearing vault...', () => (contract.callTx as any).clearVault());

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const encodeLabel = (label: string): Uint8Array => {
  const bytes = new TextEncoder().encode(label.slice(0, 32));
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return padded;
};

export const encodeSecret = (secret: string): Uint8Array => {
  const bytes = new TextEncoder().encode(secret.slice(0, 32));
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return padded;
};

export const generateOwnerKey = (): Uint8Array => {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
};

export const toHexString = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

export const fromHexString = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
};
