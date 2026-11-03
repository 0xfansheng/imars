# IMARS：给开发者与 AI 的阅读指南

这份文档帮助你按实际部署源码学习币安 Agentic Wallet 与 Mint 接入。官网源码、ABI、示例与说明分层保存；不要把其他项目或历史测试版的规则套到本仓库。

## 建议阅读顺序

1. [README](../README.md)：部署地址、实际机制、源码验证和编译命令。
2. [钱包连接与 Mint 教程](wallet-mint.md)：先理解扫码授权，再看 Agent ID、报价、预览和确认签署。
3. [示例配置](../examples/wallet-mint/config.mjs)：固定的主网目标与运行时代码哈希。
4. [只读与调用构造](../examples/wallet-mint/mint.mjs)：`quoteById`、`prepareMint`、`buildMintCall`。
5. [命令行入口](../examples/wallet-mint/cli.mjs) 与 [测试](../examples/wallet-mint/test/mint.test.mjs)：看如何使用和如何处理边界条件。
6. [正式合约](../contracts/IMARS.sol)、[编译输入](../standard-input.json) 和 [公开部署记录](../deployment.json)：核对链上规则，而不是根据宣传文字推测。

## 这个仓库的目标

- 网络：BNB Smart Chain 主网，Chain ID 56。
- 代币及 Mint 合约：`0x64a3BaD89AbFFD6F30f086cE90CCB951D3Db432f`。
- 全项目上限 10,000 份，付费单价固定 0.002 BNB。提前开池后仍可铸造剩余额度，付费份额的代币数量按合约池价公式计算。交易税的金库部分分批兑换为原生 BNB。
- 每笔最多 10 份。基础额度、免费资格、邀请额度和已铸造数都需要实时查询。
- 使用用户自己的币安智能体钱包；币安交易所账户里的 BNB 与智能体钱包里的链上原生 BNB 不同。

## 接入时不能混淆的步骤

- **连接钱包**：使用官方授权流程取得用户会话，核对配对码，连接成功本身不是链上 ID 所有权证明。
- **识别 ID**：从 Mint 合约读取 `idCollection()`；在注册合约读取 `handleOf(wallet)`，对原样返回的字符串按 UTF-8 做 `keccak256`，转为 `uint256`，再用 `ownerOf(id)` 核对钱包。不要擅自拼接 `.ai` 或修改大小写后再哈希，也不要用 JavaScript `Number` 保存 ID。
- **只读报价**：使用 BSC RPC 的 `eth_call` 调用 `quoteFor(id, quantity)`。Binance 的 `contract-call preview` 是交易模拟接口，不能代替获取 view 函数返回值。
- **准备交易**：核对 Chain ID、运行时代码哈希、额度、当前全局份号、最低收到量、deadline、推荐人归属和 BNB 余额；以最新报价构造 calldata 和 wei 单位的 value。
- **预览与签署**：先检查开发者模式，再 preview，向用户展示 parsedTx、risks 与 authorityChanges。用户确认后才 execute。不能对已发送交易盲目重试，也不能跳过风险拦截。
- **多用户网站**：每个访客独立会话；不要把服务器上开发者自己的 baw CLI 登录复用给网站访问者。会话凭据不得下发到公开 JavaScript 或写进日志。

## 仓库验证范围

合约编译核对和示例 mock 测试可在本地运行，不会铸造或付款。示例默认只读；准备调用数据也不会自动执行钱包交易。真正提交交易仍需要使用者完成官方钱包授权、预览和确认。源码验证与测试通过不代表第三方安全审计。

## 官方参考

- [Binance Agentic Wallet 文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
- [官方扫码认证流程](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/authentication.md)
- [官方合约调用预览与执行](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md)

