import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, parseEther, stringToHex } from 'viem';
import { assertDeveloperMode, assertFunds, buildMintCall, idFromRawHandle, mintAbi, parseId, parseQuantity, prepareMint, quoteById } from '../mint.mjs';

const wallet = '0x0000000000000000000000000000000000000100';
const other = '0x0000000000000000000000000000000000000200';
const collection = '0x0000000000000000000000000000000000000300';
const contract = '0x0000000000000000000000000000000000000400';
const code = '0x6001600055';
const config = { name: 'Mock only', contract, runtimeCodeHash: keccak256(code), maxShares: '10000', fixedPriceWei: '2000000000000000' };
const settings = { data: { devMode: { enabled: true, expiresAt: Math.floor(Date.now() / 1000) + 600 } } };

function fixture(overrides = {}) {
  const state = {
    handle: 'Example-测试', owner: wallet, refOwner: other, chain: 56, code,
    totalMinted: 400n, quota: 10n, mintedById: 0n, firstPaid: false,
    opened: false, freeClaimed: false, freeMinted: 300n, balance: parseEther('1'),
    gas: 100000n, gasPrice: 1000000000n, ...overrides,
  };
  const calls = [];
  const client = {
    async getChainId() { return state.chain; },
    async getBlock() { return { number: 123n, timestamp: 1900000000n }; },
    async getCode(input) { calls.push(input); return state.code; },
    async getBalance(input) { calls.push(input); return state.balance; },
    async getGasPrice() { return state.gasPrice; },
    async estimateGas(input) { calls.push(input); if (state.gasError) throw state.gasError; return state.gas; },
    async readContract(input) {
      calls.push(input);
      const { functionName: fn, args = [] } = input;
      if (fn === 'idCollection') return collection;
      if (fn === 'handleOf') return state.handle;
      if (fn === 'quotaOf') return state.quota;
      if (fn === 'ownerOf') return args[0] === idFromRawHandle(state.handle) ? state.owner : state.refOwner;
      if (fn === 'quoteFor') {
        const free = !state.freeClaimed && state.freeMinted < 300n ? 1 : 0;
        const paid = args[1] - free;
        return [parseEther('0.002') * BigInt(paid), parseEther('50000000') * BigInt(args[1]), free, paid];
      }
      if (fn in state) return state[fn];
      throw new Error('Unexpected mock call: ' + fn);
    },
  };
  return { client, state, calls };
}
const codeIs = code => error => error.code === code;

test('hashes exact raw handle bytes, including case, spaces, suffix and Unicode normalization', () => {
  const raw = ' ExAmPle.ai ';
  assert.equal(idFromRawHandle(raw), BigInt(keccak256(stringToHex(raw))));
  assert.notEqual(idFromRawHandle(raw), idFromRawHandle(raw.trim().toLowerCase().replace(/\.ai$/, '')));
  assert.notEqual(idFromRawHandle('\u00e9'), idFromRawHandle('e\u0301'));
  assert.throws(() => idFromRawHandle(''), codeIs('ID_REQUIRED'));
});
test('quantity and uint256 parser reject unsafe input', () => {
  for (const bad of [0, 11, 1.5, '01', '-1', '1e0', undefined]) assert.throws(() => parseQuantity(bad));
  assert.equal(parseQuantity('10'), 10);
  assert.equal(parseId('0'), 0n);
  assert.throws(() => parseId(String(2n ** 256n)));
  assert.throws(() => parseId('example.ai'));
});
test('developer mode evidence accepts seconds/milliseconds, rejects missing, expired and disabled', () => {
  assertDeveloperMode({ devMode: { enabled: true, expiresAt: 2000000000 } }, 1900000000000);
  assertDeveloperMode({ devMode: { enabled: true, expiresAt: 2000000000000 } }, 1900000000000);
  assert.throws(() => assertDeveloperMode({}), codeIs('DEVELOPER_MODE'));
  assert.throws(() => assertDeveloperMode({ devMode: { enabled: true, expiresAt: 1 } }), codeIs('DEVELOPER_MODE_EXPIRED'));
});
test('quote fixes all registry and balance reads to one block and verifies raw identity', async () => {
  const { client, calls } = fixture();
  const q = await quoteById(client, config, { wallet, quantity: 10 });
  assert.equal(q.buyerId, idFromRawHandle('Example-测试'));
  assert.equal(q.cost, parseEther('0.02'));
  assert.equal(q.paidUnits, 10);
  assert.equal(q.freeUnits, 0);
  assert(calls.every(call => call.blockNumber === 123n));
});
test('wrong chain, runtime and owner are blocked', async () => {
  await assert.rejects(quoteById(fixture({ chain: 1 }).client, config, { wallet }), codeIs('WRONG_CHAIN'));
  await assert.rejects(quoteById(fixture({ code: '0x6002' }).client, config, { wallet }), codeIs('CONTRACT_CHANGED'));
  await assert.rejects(quoteById(fixture({ owner: other }).client, config, { wallet }), codeIs('ID_OWNER_MISMATCH'));
});
test('free plus paid order uses real quote; fully free still requires gas', async () => {
  const { client } = fixture({ freeMinted: 299n });
  const q = await quoteById(client, config, { wallet, quantity: 10 });
  assert.equal(q.cost, parseEther('0.018'));
  assert.equal(q.freeUnits, 1);
  assert.equal(q.paidUnits, 9);
  await assert.rejects(prepareMint(fixture({ freeMinted: 299n, balance: 0n }).client, config, { wallet }, settings), codeIs('INSUFFICIENT_GAS'));
});
test('quota and global cap are separate; early opened pool is not falsely blocked', async () => {
  await assert.rejects(quoteById(fixture({ mintedById: 10n }).client, config, { wallet }), codeIs('QUOTA_EXCEEDED'));
  await assert.rejects(quoteById(fixture({ totalMinted: 10000n }).client, config, { wallet }), codeIs('GLOBAL_CAP'));
  assert.equal((await quoteById(fixture({ opened: true }).client, config, { wallet })).opened, true);
  const burn = { ...config, maxShares: '4440000', fixedPriceWei: undefined };
  assert.equal((await quoteById(fixture({ opened: true, totalMinted: 20000n }).client, burn, { wallet })).totalMinted, 20000n);
});
test('referrer must be valid, different ID and owned by a different wallet; only first paid mint binds', async () => {
  await assert.rejects(quoteById(fixture().client, config, { wallet, referrerId: String(idFromRawHandle('Example-测试')) }), codeIs('SELF_REFERRAL'));
  await assert.rejects(quoteById(fixture({ refOwner: wallet }).client, config, { wallet, referrerId: '999' }), codeIs('SELF_REFERRAL_WALLET'));
  await assert.rejects(quoteById(fixture({ firstPaid: true }).client, config, { wallet, referrerId: '999' }), codeIs('REFERRAL_NOT_APPLICABLE'));
  await assert.rejects(quoteById(fixture({ freeMinted: 0n }).client, config, { wallet, referrerId: '999' }), codeIs('REFERRAL_NOT_APPLICABLE'));
});
test('calldata pins value, first share, minimum output and block-based deadline for both methods', async () => {
  for (const referrerId of [undefined, '999']) {
    const q = await quoteById(fixture().client, config, { wallet, quantity: 2, referrerId });
    const tx = buildMintCall(q);
    const decoded = decodeFunctionData({ abi: mintAbi, data: tx.inputData });
    assert.equal(decoded.functionName, referrerId ? 'mintWithInviter' : 'mint');
    assert.deepEqual(decoded.args.slice(0, 5), [q.buyerId, 2, 401n, q.tokens * 995n / 1000n, 1900000180n]);
    assert.equal(tx.value, q.cost);
    if (referrerId) assert.equal(decoded.args[5], 999n);
  }
});
test('principal insufficiency and gas insufficiency are distinct', () => {
  assert.throws(() => assertFunds(1n, 2n, 1n), codeIs('INSUFFICIENT_BNB'));
  assert.throws(() => assertFunds(2n, 2n, 1n), codeIs('INSUFFICIENT_GAS'));
  assert.throws(() => assertFunds(3n, 2n, 2n), codeIs('INSUFFICIENT_GAS'));
  assertFunds(4n, 2n, 2n);
});
test('prepare checks developer mode before touching RPC; no signing or execution method exists', async () => {
  const { client, calls } = fixture();
  await assert.rejects(prepareMint(client, config, { wallet }, {}), codeIs('DEVELOPER_MODE'));
  assert.equal(calls.length, 0);
  const p = await prepareMint(client, config, { wallet }, settings);
  assert.equal(p.gas.gasBudgetWei, 120000000000000n);
  assert.deepEqual(p.preview.args.slice(0, 4), ['contract-call', 'preview', '--binanceChainId', '56']);
  assert(!p.preview.args.includes('--gasLimit'));
  assert(!p.preview.args.includes('execute'));
  assert.equal(client.sendTransaction, undefined);
  assert.equal(client.signTransaction, undefined);
});
test('gas budget shortage is explicit and unrelated simulation failure is preserved', async () => {
  await assert.rejects(prepareMint(fixture({ balance: parseEther('0.00205') }).client, config, { wallet }, settings), codeIs('INSUFFICIENT_GAS'));
  const error = new Error('Synthetic contract revert');
  await assert.rejects(prepareMint(fixture({ gasError: error }).client, config, { wallet }, settings), e => e === error);
});

