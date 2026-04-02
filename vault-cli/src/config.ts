import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const contractConfig = {
  privateStateStoreName: 'vault-private-state',
  zkConfigPath: path.resolve(__dirname, '..', '..', 'contract', 'src', 'managed', 'vault'),
};

export interface Config {
  readonly logDir: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

export class PreprodConfig implements Config {
  logDir = path.resolve(
    __dirname,
    '..',
    'logs',
    'preprod',
    `${new Date().toISOString().replace(/:/g, '-')}.log`,
  );
  indexer = 'https://indexer.preprod.midnight.network/api/v3/graphql';
  indexerWS = 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws';
  node = 'https://rpc.preprod.midnight.network';
  proofServer = 'http://127.0.0.1:6300';

  constructor() {
    setNetworkId('preprod');
  }
}

export class StandaloneConfig implements Config {
  logDir = path.resolve(
    __dirname,
    '..',
    'logs',
    'standalone',
    `${new Date().toISOString().replace(/:/g, '-')}.log`,
  );
  indexer = 'http://127.0.0.1:8088/api/v3/graphql';
  indexerWS = 'ws://127.0.0.1:8088/api/v3/graphql/ws';
  node = 'http://127.0.0.1:9944';
  proofServer = 'http://127.0.0.1:6300';

  constructor() {
    setNetworkId('undeployed');
  }
}
