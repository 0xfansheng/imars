// SPDX-License-Identifier: MIT
// Reproduce the published reference artifacts offline. Never signs/sends.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeAbiParameters, encodeDeployData, getContractAddress, keccak256} from 'viem';
import {compile, root, readJson} from './compile.mjs';

const manifest = readJson('release-manifest.json');
const deployment = readJson('deployment.json');
const input = readJson('standard-input.json');
const publicFiles = Object.fromEntries(Object.keys(input.sources).map(name => [name, 'contracts/' + name]));
for (const name of ['standard-input.json', 'deployment.json', 'LICENSE', 'licenses/OpenZeppelin-MIT.txt', 'abi/IMARS.json', 'abi/IMARSTaxReceiver.json', 'artifacts/IMARS.json', 'artifacts/IMARSTaxReceiver.json']) publicFiles[name] = name;
for (const [original, current] of Object.entries(publicFiles)) {
  const data = fs.readFileSync(path.join(root, current));
  assert.equal(data.length, manifest.files[original].bytes, original + ' byte length');
  assert.equal(createHash('sha256').update(data).digest('hex'), manifest.files[original].sha256, original + ' public release SHA-256');
}

const output = compile(true);
const results = [];
for (const name of ['IMARS', 'IMARSTaxReceiver']) {
  const contract = output.contracts['IMARS.sol'][name];
  const expected = readJson('artifacts/' + name + '.json');
  const abi = readJson('abi/' + name + '.json');
  const info = deployment.contracts[name];
  assert.equal('0x' + contract.evm.bytecode.object, expected.bytecode, name + ' creation bytecode');
  assert.equal('0x' + contract.evm.deployedBytecode.object, expected.deployedBytecode, name + ' runtime template');
  assert.deepEqual(contract.abi, expected.abi, name + ' reference ABI');
  assert.deepEqual(contract.abi, abi, name + ' public ABI');
  assert.equal(keccak256(expected.bytecode), info.creationBytecodeHash, name + ' creation bytecode hash');
  const isMain = name === 'IMARS';
  const args = isMain ? deployment.constructorArgs : [deployment.constructorArgs[1]];
  assert.equal(encodeAbiParameters(args.map(() => ({type: 'address'})), args), info.constructorArgsHex, name + ' constructor encoding');
  assert.equal(keccak256(encodeDeployData({abi, bytecode: expected.bytecode, args})), info.creationDataHash, name + ' creation payload hash');
  const definition = output.sources['IMARS.sol'].ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === name);
  const values = isMain ? {
    treasury: deployment.constructorArgs[3], idCollection: deployment.constructorArgs[0], wrapped: deployment.constructorArgs[1],
    pair: deployment.pair, taxReceiver: deployment.contracts.IMARSTaxReceiver.address,
    burnIs0: BigInt(deployment.contracts.IMARS.address) < BigInt(deployment.constructorArgs[1]) ? '0x1' : '0x0',
  } : {token: deployment.contracts.IMARS.address, wrapped: deployment.constructorArgs[1]};
  const ids = new Map(definition.nodes.filter(node => node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable').map(node => [String(node.id), node.name]));
  let runtime = contract.evm.deployedBytecode.object;
  for (const [id, ranges] of Object.entries(contract.evm.deployedBytecode.immutableReferences)) {
    const value = values[ids.get(id)];
    assert.ok(value, 'Unknown immutable ' + id);
    for (const {start, length} of ranges) {
      assert.equal(length, 32);
      runtime = runtime.slice(0, start * 2) + value.slice(2).toLowerCase().padStart(64, '0') + runtime.slice((start + length) * 2);
    }
  }
  assert.equal(keccak256('0x' + runtime), info.runtimeCodeHash, name + ' immutable-bound deployed runtime hash');
  results.push({contract: name, address: info.address, abi: 'exact', creationBytecode: 'exact', runtimeTemplate: 'exact', deployedRuntimeHash: info.runtimeCodeHash});
}
assert.equal(getContractAddress({from: deployment.deployer, nonce: BigInt(deployment.deployerNonce)}).toLowerCase(), deployment.contracts.IMARS.address.toLowerCase());
assert.equal(getContractAddress({from: deployment.contracts.IMARS.address, nonce: 1n}).toLowerCase(), deployment.contracts.IMARSTaxReceiver.address.toLowerCase());
console.log(JSON.stringify({compiler: manifest.compiler, publicReleaseFilesChecked: Object.keys(publicFiles).length, soliditySources: Object.keys(input.sources).length, results}, null, 2));
