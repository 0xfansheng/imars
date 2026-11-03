# IMARS 合约与钱包 Mint 接入

**阅读入口：[给开发者与 AI 的阅读指南](docs/AI-READING-GUIDE.md) · [币安钱包连接与 Mint 教程](docs/wallet-mint.md)**

本仓库公开已部署的 IMARS 代币／铸造合约、固定税金接收器、全部 Solidity 编译依赖、ABI、公开部署参数及可复现编译工具。主合约同时承担 ERC-20 代币和 Mint 功能；`IMARSTaxReceiver` 是主合约创建的固定辅助合约。

- [官网](https://imars.fun) · [官网合约源码入口](https://imars.fun/contracts)
- [BscScan：IMARS 代币与 Mint 合约](https://bscscan.com/address/0x64a3bad89abffd6f30f086ce90ccb951d3db432f#code)
- [BscScan：税金接收器](https://bscscan.com/address/0xE4d997e898777fd5BA8e5978f3D6fDc32fADa8aA#code)
- [Sourcify：主合约](https://repo.sourcify.dev/56/0x64a3bad89abffd6f30f086ce90ccb951d3db432f) · [接收器](https://repo.sourcify.dev/56/0xE4d997e898777fd5BA8e5978f3D6fDc32fADa8aA)
- [币安钱包 Mint 接入说明](docs/wallet-mint.md) · [接入示例](examples/wallet-mint)

## 正式部署

| 项目 | 值 |
| --- | --- |
| 网络 | BNB Smart Chain 主网，Chain ID `56` |
| IMARS 代币／Mint | `0x64a3BaD89AbFFD6F30f086cE90CCB951D3Db432f` |
| 固定税金接收器 | `0xE4d997e898777fd5BA8e5978f3D6fDc32fADa8aA` |
| Agent ID 注册合约 | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| PancakeSwap V2 Factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| 固定金库 | `0x6ff40626A97285076e0e67eef6A061f380AB390b` |
| IMARS/WBNB Pair | `0x7e2c22E5fBAfD740C645Ae244D40bcFF74210b8D` |

[创建交易](https://bscscan.com/tx/0x120a046a24113f207f3c0692f359f5a3cc4df494663de3cb0baee527c8395634)位于区块 `131383305`。完整公开参数及构造参数编码见 [deployment.json](deployment.json)。这些是公开链上记录，不包含钱包密钥。

## 机制

- 代币名称和符号均为 `IMARS`，精度 18。全项目 Mint 最多 **10,000 份**，每笔 1–10 份。
- 每个 Agent ID 基础额度 10 份。额度、已铸造数、免费领取记录都绑定 ID；ID 换持有人不会重置记录。Mint 时调用注册合约的 `ownerOf(id)` 核验交易发送者。
- 累计前 300 个符合条件且未领取过的 ID 各可免费 1 份，同笔可混合免费与付费份额。例如有资格时 10 份为 1 免 + 9 付；免费份数耗尽或该 ID 已领过后均付费。是否免费必须读取实时 `quoteFor(id, quantity)`，本说明不表示目前仍有免费额度。
- 付费单价固定 **0.002 BNB／份**，网络费另计。开池前每份铸造 50,000,000 IMARS；提前开池后仍可铸造至全项目上限，付费份额的代币数量按池储备公式计算，以实时 `quoteFor` 为准。免费份额仍为 50,000,000 IMARS。
- 新 ID 首次成功付费 Mint 可绑定一个推荐 ID，给推荐人增加 1 份**付费铸造额度**。纯免费交易不能记邀请；同一个 ID、同一钱包名下 ID 不可互邀。邀请不会直接发币，也不能突破全项目总量上限。
- 付费 Mint 资金 70% 用于流动性，30% 给固定金库。开池前将 70% 包装成 WBNB 累计预留；开池后直接按池价追加流动性。Mint 的金库款优先支付原生 BNB，若接收失败则回退支付 WBNB。
- 达到 10,000 份自动开池，初始池为 **13.58 WBNB + 350,000,000,000 IMARS**。只有部署者能在至少已有一份付费 Mint、尚未满额且未开池时手动提前开池，使用全部预留 WBNB，并按相同初始价格等比例配入 IMARS。
- 合约添加流动性时产生的 LP 直接铸造到 `0x000000000000000000000000000000000000dEaD`。自动或手动开池都会将一次性 `earlyOpener` 清零；不是在第一笔 Mint 时清零。主合约没有 `Ownable` 管理员、税率调整、金库变更或资金提取入口。
- 开池后，与固定 IMARS/WBNB Pair 的交易收取 2% 税：税额一半转入上述销毁地址，另一半记入合约待结算金库税。转入销毁地址不会调用 ERC-20 `_burn`，因此 `totalSupply()` 不会因该转账而减少。普通钱包间转账不征收该交易税，开池前代币不能普通转账。
- 金库税通过受限分批兑换成为原生 BNB：后续卖出会尝试结算，任何人也可调用 `settleTreasury()`；调用人不能改变收款地址。单批最多卖出池中 IMARS 储备的 0.25%，并受价格和 Gas 检查约束。兑换或付款失败时保留待处理金额，稍后可重试，并非每一笔交易的金库税都会当笔到账。

## 编译与核验

要求 Node.js 22 或以上及 npm：

```sh
npm ci --ignore-scripts
npm run verify
npm run compile
```

编译器固定为 `0.8.30+commit.73712a01.Emscripten.clang`（npm `solc@0.8.30`），优化器 200 runs，`viaIR: true`，EVM `shanghai`，OpenZeppelin Contracts 5.4.0。npm 安装工具后，编译和核验完全在本地运行，不读取 RPC、不签名、不发送交易。

`contracts/` 存放从公开 [standard-input.json](standard-input.json) 恢复的 16 个源码文件。编译时保留原来的 `IMARS.sol` 和 `@openzeppelin/...` source keys；不要给这些编译键增加 `contracts/` 前缀，否则 Solidity 元数据和字节码会改变。

`npm run verify` 核对包含的公开文件 SHA-256、源文件内容、编译器设置、两个合约的 ABI、创建字节码、运行时代码模板、构造参数、填入 immutable 后的运行时哈希及确定性创建地址。它比对的是发布包中的公开链上基准记录，不会重新联网查询链上状态。`artifacts/` 为不变的公开基准；`build/` 为本地编译产物。

[release-manifest.json](release-manifest.json) 原样保存官网 ZIP 的原始清单，其中某些原包文件未包含于本仓库；核验脚本只核对本仓库选入的公开文件。[public-package-provenance.json](public-package-provenance.json) 记录公开 ZIP 的来源和 SHA-256。源码验证说明部署代码与源码的对应关系，不等于安全审计。

## 目录

```text
contracts/               IMARS.sol 与全部导入的 Solidity 依赖
abi/                     IMARS 与 IMARSTaxReceiver 的 ABI
artifacts/               公开基准字节码与 ABI
scripts/                 本地编译及核验
docs/wallet-mint.md       币安 Agent ID 钱包接入文档
examples/wallet-mint/     钱包 Mint 接入示例
standard-input.json      原始标准编译输入
deployment.json          公开部署参数
release-manifest.json    原始公开包清单
```

## 许可

IMARS 合约与本仓库新增编译工具使用 [MIT License](LICENSE)。OpenZeppelin 许可见 [licenses/OpenZeppelin-MIT.txt](licenses/OpenZeppelin-MIT.txt) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
