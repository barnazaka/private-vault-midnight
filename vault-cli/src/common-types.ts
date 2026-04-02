import { type Contract, type VaultPrivateState } from '@midnight-ntwrk/vault-contract';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { ProvableCircuitId } from '@midnight-ntwrk/compact-js';

export type VaultCircuits = ProvableCircuitId<Contract<VaultPrivateState>>;

export const VaultPrivateStateId = 'vaultPrivateState';

export type VaultProviders = MidnightProviders<
  VaultCircuits,
  typeof VaultPrivateStateId,
  VaultPrivateState
>;

export type VaultContract = Contract<VaultPrivateState>;

export type DeployedVaultContract = DeployedContract<VaultContract> | FoundContract<VaultContract>;
