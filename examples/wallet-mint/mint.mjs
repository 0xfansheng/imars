import {
  BaseError, InsufficientFundsError, encodeFunctionData, formatEther, formatUnits,
  getAddress, isAddress, isAddressEqual, keccak256, parseAbi, stringToHex, zeroAddress,
} from 'viem';

export const mintAbi = parseAbi([
  'function idCollection() view returns (address)',
  'function totalMinted() view returns (uint256)',
  'function opened() view returns (bool)',
  'function quotaOf(uint256 id) view returns (uint256)',
  'function mintedById(uint256 id) view returns (uint256)',
  'function firstPaid(uint256 id) view returns (bool)',
  'function freeClaimed(uint256 id) view returns (bool)',
  'function freeMinted() view returns (uint256)',
  'function quoteFor(uint256 id,uint8 quantity) view returns (uint256 cost,uint256 tokens,uint8 freeUnits,uint8 paidUnits)',
  'function mint(uint256 id,uint8 quantity,uint256 expectedStart,uint256 minTokens,uint256 deadline) payable',
  'function mintWithInviter(uint256 id,uint8 quantity,uint256 expectedStart,uint256 minTokens,uint256 deadline,uint256 inviterId) payable',
]);
export const registryAbi = parseAbi([
  'function handleOf(address wallet) view returns (string)',
  'function ownerOf(uint256 id) view returns (address)',
]);

export class MintError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MintError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new MintError(code, message, details); };

export function parseQuantity(value) {
  if (!/^(?:[1-9]|10)$/.test(String(value))) fail('INVALID_QUANTITY', 'quantity must be an integer from 1 to 10.');
  return Number(value);
}
export function parseId(value) {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) fail('INVALID_REFERRER', 'referrer-id must be a decimal uint256.');
  const result = BigInt(value);
  if (result >= 2n ** 256n) fail('INVALID_REFERRER', 'referrer-id exceeds uint256.');
  return result;
}
export function idFromRawHandle(rawHandle) {
  if (typeof rawHandle !== 'string' || rawHandle.length === 0) fail('ID_REQUIRED', 'No handle returned by the registry.');
  // Hash precisely the registry bytes: no trim, lowercasing, Unicode normalization or ".ai" suffix edits.
  return BigInt(keccak256(stringToHex(rawHandle)));
}
export function assertDeveloperMode(settings, nowMs = Date.now()) {
  const mode = settings?.data?.devMode ?? settings?.devMode;
  if (mode?.enabled !== true) fail('DEVELOPER_MODE', 'Developer Mode must be enabled in the Binance App.');
  const raw = Number(mode.expiresAt);
  const expiry = raw < 1e11 ? raw * 1000 : raw;
  if (!Number.isSafeInteger(expiry) || expiry <= nowMs) fail('DEVELOPER_MODE_EXPIRED', 'Developer Mode is expired or its expiry cannot be verified.');
}
export function assertFunds(balance, cost, gasBudget = 0n) {
  if (balance < cost) fail('INSUFFICIENT_BNB', 'Native BNB is insufficient for the mint payment.', { balance, cost });
  if (balance === cost || balance < cost + gasBudget) fail('INSUFFICIENT_GAS', 'Mint payment is covered, but native BNB is insufficient for the estimated gas budget.', { balance, cost, gasBudget });
}
function walletAddress(value) {
  if (!isAddress(value, { strict: false })) fail('INVALID_WALLET', 'wallet must be a public EVM address.');
  const address = getAddress(value.toLowerCase());
  if (isAddressEqual(address, zeroAddress)) fail('INVALID_WALLET', 'wallet must not be the zero address.');
  return address;
}

/** Read one consistent BSC block. No wallet connection, signature or transaction broadcast. */
export async function quoteById(client, config, { wallet, quantity = 1, referrerId } = {}) {
  const account = walletAddress(wallet);
  quantity = parseQuantity(quantity);
  if (await client.getChainId() !== 56) fail('WRONG_CHAIN', 'Expected BNB Smart Chain mainnet (56).');
  const block = await client.getBlock();
  const blockNumber = block.number;
  if (blockNumber == null) fail('INVALID_BLOCK', 'RPC did not return a mined block.');
  const code = await client.getCode({ address: config.contract, blockNumber });
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== config.runtimeCodeHash.toLowerCase())
    fail('CONTRACT_CHANGED', 'Runtime code does not match the pinned mainnet deployment.');
  const read = (functionName, args = []) => client.readContract({ address: config.contract, abi: mintAbi, functionName, args, blockNumber });
  const collection = await read('idCollection');
  if (!isAddress(collection) || isAddressEqual(collection, zeroAddress)) fail('INVALID_REGISTRY', 'idCollection returned an invalid registry.');
  const readRegistry = (functionName, args) => client.readContract({ address: collection, abi: registryAbi, functionName, args, blockNumber });
  const rawHandle = await readRegistry('handleOf', [account]);
  const buyerId = idFromRawHandle(rawHandle);
  const owner = await readRegistry('ownerOf', [buyerId]);
  if (!isAddressEqual(owner, account)) fail('ID_OWNER_MISMATCH', 'The registry ID is not owned by this wallet.');
  const [totalMinted, quota, mintedById, firstPaid, opened, freeClaimed, freeMinted, balance] = await Promise.all([
    read('totalMinted'), read('quotaOf', [buyerId]), read('mintedById', [buyerId]),
    read('firstPaid', [buyerId]), read('opened'), read('freeClaimed', [buyerId]),
    read('freeMinted'), client.getBalance({ address: account, blockNumber }),
  ]);
  if (mintedById + BigInt(quantity) > quota) fail('QUOTA_EXCEEDED', 'The requested quantity exceeds this ID allowance.');
  if (totalMinted + BigInt(quantity) > BigInt(config.maxShares)) fail('GLOBAL_CAP', 'The requested quantity exceeds the contract global cap.');
  const [cost, tokens, freeUnits, paidUnits] = await read('quoteFor', [buyerId, quantity]);
  const expectedFree = !freeClaimed && freeMinted < 300n ? 1 : 0;
  if (freeUnits !== expectedFree || freeUnits + paidUnits !== quantity || (cost === 0n) !== (paidUnits === 0) || tokens <= 0n)
    fail('INVALID_QUOTE', 'The quote is inconsistent with the pinned contract rules.');
  if (config.fixedPriceWei && cost !== BigInt(config.fixedPriceWei) * BigInt(paidUnits))
    fail('INVALID_QUOTE', 'The quote does not match the fixed paid mint price.');

  let inviterId = null;
  if (referrerId !== undefined && referrerId !== '') {
    inviterId = parseId(referrerId);
    if (inviterId === buyerId) fail('SELF_REFERRAL', 'An ID cannot invite itself.');
    if (firstPaid || paidUnits === 0) fail('REFERRAL_NOT_APPLICABLE', 'Referral binding requires this ID first paid mint; omit referrer-id for this order.');
    let inviterOwner;
    try { inviterOwner = await readRegistry('ownerOf', [inviterId]); }
    catch { fail('INVALID_REFERRER', 'Cannot verify the referrer ID owner.'); }
    if (isAddressEqual(inviterOwner, zeroAddress)) fail('INVALID_REFERRER', 'The referrer has no owner.');
    if (isAddressEqual(inviterOwner, account)) fail('SELF_REFERRAL_WALLET', 'Different IDs held by the same wallet cannot refer each other.');
  }
  return {
    project: config.name, chainId: 56, contract: config.contract, blockNumber, blockTimestamp: block.timestamp,
    registry: collection, account, rawHandle, buyerId, quantity, inviterId,
    cost, tokens, costBNB: formatEther(cost), tokensFormatted: formatUnits(tokens, 18),
    freeUnits, paidUnits, totalMinted, quota, mintedById, firstPaid, opened, freeClaimed, freeMinted, balance,
  };
}

export function buildMintCall(quote, slippageBps = 50) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) fail('INVALID_SLIPPAGE', 'slippageBps must be 0..10000.');
  const expectedFirstShare = quote.totalMinted + 1n;
  const minTokens = quote.tokens * BigInt(10000 - slippageBps) / 10000n;
  const deadline = quote.blockTimestamp + 180n;
  const functionName = quote.inviterId === null ? 'mint' : 'mintWithInviter';
  const args = [quote.buyerId, quote.quantity, expectedFirstShare, minTokens, deadline];
  if (quote.inviterId !== null) args.push(quote.inviterId);
  return {
    functionName, expectedFirstShare, minTokens, deadline,
    from: quote.account, to: quote.contract, value: quote.cost,
    inputData: encodeFunctionData({ abi: mintAbi, functionName, args }),
  };
}

/** Developer-mode evidence is checked BEFORE quoting or building a preview payload. */
export async function prepareMint(client, config, input, settings) {
  assertDeveloperMode(settings);
  const quote = await quoteById(client, config, input);
  assertFunds(quote.balance, quote.cost);
  const transaction = buildMintCall(quote);
  let gas;
  try {
    gas = await client.estimateGas({
      account: quote.account, to: quote.contract, data: transaction.inputData,
      value: quote.cost, blockNumber: quote.blockNumber,
    });
  } catch (error) {
    if (error instanceof BaseError && error.walk(cause => cause instanceof InsufficientFundsError) instanceof InsufficientFundsError) {
      assertFunds(await client.getBalance({ address: quote.account }), quote.cost);
      fail('INSUFFICIENT_GAS', 'RPC explicitly reported insufficient native funds during estimation.');
    }
    // Do not relabel contract reverts, out-of-gas simulation, network errors or risk failures as a balance error.
    throw error;
  }
  const gasPriceWei = await client.getGasPrice();
  const estimatedGasWei = gas * gasPriceWei;
  const gasBudgetWei = (estimatedGasWei * 120n + 99n) / 100n;
  assertFunds(quote.balance, quote.cost, gasBudgetWei);
  const previewArgs = ['contract-call', 'preview', '--binanceChainId', '56', '--from', transaction.from,
    '--to', transaction.to, '--value', String(transaction.value), '--inputData', transaction.inputData, '--json'];
  return {
    quote, transaction, gas: { units: gas, gasPriceWei, estimatedGasWei, gasBudgetWei, budgetMarginPercent: 20 },
    // Data only. This example never spawns baw, invokes preview, signs or broadcasts.
    preview: { executable: 'baw', args: previewArgs },
    notice: 'Recheck the fresh quote, then manually preview. Inspect parsedTx, risks and authorityChanges and obtain user confirmation before execute. No execute command has been run.',
  };
}
export const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);

