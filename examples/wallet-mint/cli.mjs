import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { config } from './config.mjs';
import { quoteById, prepareMint, json, MintError } from './mint.mjs';

const { values } = parseArgs({
  options: {
    wallet: { type: 'string' }, quantity: { type: 'string', default: '1' },
    'referrer-id': { type: 'string' }, rpc: { type: 'string' },
    prepare: { type: 'boolean', default: false }, settings: { type: 'string' },
    help: { type: 'boolean', default: false },
  }, strict: true,
});
if (values.help) {
  console.log('node cli.mjs --wallet <PUBLIC_BSC_ADDRESS> [--quantity 1..10] [--referrer-id <DECIMAL_UINT256>] [--rpc <HTTPS_RPC>] [--prepare --settings <FRESH_WALLET_SETTINGS_JSON>]');
  console.log('Default: read-only quote. --prepare: estimate gas and emit preview arguments only. Never signs or broadcasts.');
} else {
  try {
    if (!values.wallet) throw new MintError('WALLET_REQUIRED', 'Pass your own public BSC Agentic Wallet address using --wallet.');
    if (values.prepare && !values.settings) throw new MintError('SETTINGS_REQUIRED', '--prepare requires a fresh wallet settings JSON file; see docs/wallet-mint.md.');
    const rpc = values.rpc ?? process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com';
    const url = new URL(rpc);
    if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:'))
      throw new MintError('INVALID_RPC', 'Use HTTPS for remote RPC or HTTP for local testing.');
    const client = createPublicClient({ chain: bsc, cacheTime: 0, transport: http(rpc, { timeout: 15000, retryCount: 1 }) });
    const input = { wallet: values.wallet, quantity: values.quantity, referrerId: values['referrer-id'] };
    const result = values.prepare
      ? await prepareMint(client, config, input, JSON.parse((await readFile(values.settings, 'utf8')).replace(/^\uFEFF/, '')))
      : await quoteById(client, config, input);
    console.log(json(result));
  } catch (error) {
    // Do not print RPC URLs, private query keys, stack traces, session details or complete provider responses.
    console.error(json(error instanceof MintError
      ? { error: error.code, message: error.message, details: error.details }
      : { error: 'READ_OR_SIMULATION_FAILED', message: 'RPC read or gas simulation failed. No wallet action was performed. Check the network, contract state and quote freshness.' }));
    process.exitCode = 1;
  }
}

