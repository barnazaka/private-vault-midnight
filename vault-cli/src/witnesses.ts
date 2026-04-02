import type { VaultPrivateState } from '@midnight-ntwrk/vault-contract';
import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '@midnight-ntwrk/vault-contract';

export const witnesses = {
  ownerSecretKey: (
    context: WitnessContext<Ledger, VaultPrivateState>,
  ): [VaultPrivateState, Uint8Array] => {
    return [context.privateState, context.privateState.ownerSecretKey];
  },

  secretValue: (
    context: WitnessContext<Ledger, VaultPrivateState>,
  ): [VaultPrivateState, Uint8Array] => {
    const { privateState } = context;
    if (privateState.rotationNewSecret) {
      const newSecret = privateState.rotationNewSecret;
      // For rotation: the circuit calls secretValue() twice.
      // 1st call: we return the old secret and update state with the new one.
      // 2nd call: rotationNewSecret is now undefined (in the updated state),
      // so we return the new secret (which is now in currentSecret).
      return [{ ...privateState, currentSecret: newSecret, rotationNewSecret: undefined }, privateState.currentSecret];
    }
    return [privateState, privateState.currentSecret];
  },
};
