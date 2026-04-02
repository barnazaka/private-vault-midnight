export { Contract, ledger, pureCircuits } from './managed/vault/contract/index.js';
export type { Witnesses, ImpureCircuits, Circuits, Ledger, ContractReferenceLocations } from './managed/vault/contract/index.js';

// We define our own private state shape here
export type VaultPrivateState = {
  ownerSecretKey: Uint8Array;
  currentSecret: Uint8Array;
  rotationNewSecret?: Uint8Array;
};
