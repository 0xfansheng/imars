// SPDX-License-Identifier: MIT
// Local compilation only. No RPC, signing or transaction submission.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import solc from 'solc';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readJson = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
export function compile(extraOutput = false) {
  const input = readJson('standard-input.json');
  const manifest = readJson('release-manifest.json');
  assert.equal(solc.version(), manifest.compiler, 'Pinned compiler version');
  assert.deepEqual(input.settings, manifest.compilerSettings, 'Published compiler settings');
  for (const [name, {content}] of Object.entries(input.sources)) {
    assert.equal(fs.readFileSync(path.join(root, 'contracts', name), 'utf8'), content, 'Source content: ' + name);
  }
  // Keep the original source keys; moving them inside contracts/ in the compiler
  // input would change the source metadata and therefore the deployed bytecode.
  if (extraOutput) input.settings.outputSelection = {'*': {'*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'], '': ['ast']}};
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors?.filter(error => error.severity === 'error');
  if (errors?.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = compile();
  fs.mkdirSync(path.join(root, 'build'), {recursive: true});
  for (const name of ['IMARS', 'IMARSTaxReceiver']) {
    const contract = output.contracts['IMARS.sol'][name];
    fs.writeFileSync(path.join(root, 'build', name + '.json'), JSON.stringify({compiler: solc.version(), abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object, deployedBytecode: '0x' + contract.evm.deployedBytecode.object}, null, 2) + '\n');
    console.log(name + ': ' + contract.evm.deployedBytecode.object.length / 2 + ' runtime template bytes');
  }
}
