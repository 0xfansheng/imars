# 连接币安智能体钱包并 Mint

本教程覆盖个人 CLI 操作与网站扫码接入设计。示例程序只读链上状态、估算 Gas、生成待预览参数，**不会连接钱包、执行 baw、签名或广播交易**。

官方资料：

- [币安 Agentic Wallet 官方技能](https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet)
- [官方登录 / 扫码流程](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/authentication.md)
- [官方外部合约调用与开发者模式](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md)
- [官方钱包状态与地址](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/wallet-view.md)
- [官方 CLI npm 包](https://www.npmjs.com/package/@binance/agentic-wallet)
- [viem 文档](https://viem.sh/docs/getting-started)

## 本项目主网参数

- 代币与 Mint 为同一合约：0x64a3BaD89AbFFD6F30f086cE90CCB951D3Db432f。
- BNB Smart Chain 主网，chain ID 56，原生 BNB 支付付款和 Gas。
- 固定付费单价每份 0.002 BNB；全项目最多 10,000 份。
- 正常满 10,000 自动开池后，因总量上限而停止 Mint。**提前开池不等于立即停止 Mint**：实际源码允许剩余额度继续铸造到总计 10,000，代币输出走池价与价格保护分支，以 quoteFor 为准。
- 前 300 个合资格 ID 各最多一份免费；每 ID 基础 10 份，每笔最多 10 份，邀请增加个人付费额度。
- runtime code hash：0x7945f995aac3d9fdf146f8e57442b703aef831358748dbcd915581cad29a5983。
- [BscScan 源码](https://bscscan.com/address/0x64a3BaD89AbFFD6F30f086cE90CCB951D3Db432f#code)。

金额、免费资格、个人额度与预计代币都以实时链上报价为准。“前 300 份免费”是合约规则，**不表示现在还有剩余免费份额**。

## 1. 个人 CLI 登录：由钱包本人操作

安装官方 CLI。不要上传助记词、私钥、会话令牌、配对私密材料或 CLI 认证目录。

~~~sh
npm install -g @binance/agentic-wallet
baw --version
baw auth signin --json
~~~

1. 原样展示返回的 pairingCode，原样打开 urlForWeb；不要拼接、改写或缩短登录链接。
2. 用户在币安 App 扫码、核对配对码并确认登录。
3. 保持下列 verify 进程运行直到成功或超时。App 显示成功不等于本地会话已经完成。
4. wallet status 必须返回 CONNECTED。二维码过期应重新 signin，不重用旧 qrCodeId。

~~~sh
baw auth verify --qrCodeId "<signin 返回的 qrCodeId>" --json
baw wallet status --json
baw wallet address --json
baw wallet settings --json
~~~

从地址列表选择 binanceChainId=56 的 **Agentic Wallet** 地址。交易所现货余额、其他钱包或其他链的余额不能代替这个地址上的原生 BNB。

一旦计划签署 Mint，就先检查 devMode.enabled=true 且 devMode.expiresAt 未过期，再构造签名参数。关闭或过期时，在币安 App 的 **Agentic Wallet 管理页 → 设置 → Developer Mode** 开启并完成确认，然后重新读取设置。不要通过代码假装开启开发者模式。纯链上只读报价不需要登录或开发者模式。

## 2. 安装和运行独立示例

要求 Node.js 22 或更新版本。viem 固定为 2.57.14，示例独立安装，不依赖根目录工具。

~~~sh
cd examples/wallet-mint
npm ci --ignore-scripts
npm test
npm run check
node cli.mjs --help
node cli.mjs --wallet "<自己的 BSC Agentic Wallet 公开地址>" --quantity 10
~~~

可选参数 --rpc 指定可信 HTTPS RPC，或设置 BSC_RPC_URL 环境变量。含访问密钥的 RPC URL 不要提交 Git。限流时更换可信节点，不能跳过字节码或 ID 校验。

主要输出：

| 字段 | 含义 |
| --- | --- |
| blockNumber / blockTimestamp | 一致读取的已出块快照 |
| rawHandle / buyerId | 注册合约原始名称及其 UTF-8 keccak256 对应的 uint256 |
| cost / costBNB | 铸造付款 wei / BNB，不含 Gas |
| tokens / tokensFormatted | 预计代币最小单位 / 按 18 位小数格式化 |
| freeUnits / paidUnits | 本次免费份数 / 付费份数 |
| quota / mintedById | 该 ID 总额度 / 已用额度 |
| firstPaid | 是否已完成首次付费 Mint |
| totalMinted / opened | 全局已铸造份数 / 是否已开池 |
| freeMinted / freeClaimed | 免费已领取总份数 / 该 ID 是否领过 |
| balance | 同一区块本人钱包原生 BNB 余额（wei） |

程序没有交易能力。公开地址和 ID 本身可查询，但输出仍可能关联用户身份，不应默认收集或公开他人的查询记录。

## 3. 从链上原始名称推导 ID

[quoteById 源码](../examples/wallet-mint/mint.mjs) 按以下顺序处理：

1. 检查 RPC chain ID 为 56。
2. 固定本次区块读取 Mint runtime bytecode，其 keccak256 必须匹配 config.mjs 中固定的主网部署哈希；失败停止。
3. 调用 Mint 的 idCollection()，不硬编码其他项目的注册合约。
4. 调用该注册合约的 handleOf(wallet)。
5. 对返回的**原始字符串**进行 UTF-8 编码，再取 keccak256 并转成 uint256。不得转小写、trim、做 Unicode 规范化、追加或删除 .ai。
6. 调用 ownerOf(buyerId)，必须等于本人钱包。
7. 读取 quotaOf、mintedById、firstPaid、totalMinted、免费状态，以及 quoteFor(buyerId, quantity)。
8. 数量必须为整数 1..10，既不超过个人剩余额度，也不超过合约总量。
9. 以上读取全部固定在同一区块。快照并不保证后续签名时状态不变。

~~~js
const buyerId = BigInt(keccak256(stringToHex(rawHandle)));
~~~

## 4. 可选推荐人

~~~sh
node cli.mjs --wallet "<本人公开地址>" --quantity 10 --referrer-id "<推荐人的十进制 uint256 ID>"
~~~

referrer-id 是链上数字 ID，不是 .ai 展示名称。若从名称解析，应先经可信注册合约核对原始名称与归属。

- 推荐人与买方不得为同一 ID。
- 推荐人的 ownerOf 必须有效，且不同于买方钱包；同钱包持有的不同 ID 也不能互邀。
- 仅买方首次包含付费份额的成功 Mint 能绑定推荐人。
- 纯免费领取或 firstPaid=true 时，本示例拒绝传入推荐人；核对后去掉该参数，不能隐式更换推荐人。
- 邀请增加的是**付费铸造额度**，不会自动 Mint，也不是转账或返佣。

## 5. 估算 Gas 并生成参数，不执行交易

从刚刚连接的同一个 CLI 会话导出新鲜设置。放系统临时目录，用完删除；不要放 Git、前端日志、静态站点或公开工单。

PowerShell 示例：

~~~powershell
baw wallet settings --json | Out-File -Encoding utf8 "$env:TEMP\wallet-settings.json"
node cli.mjs --wallet "<本人公开地址>" --quantity 10 --prepare --settings "$env:TEMP\wallet-settings.json"
~~~

--prepare 在触碰 RPC、构造 calldata **之前**验证开发者模式状态和有效期。设置文件只是调用者刚刚导出的证据，不能代替预览前再次检查钱包会话；不要手写 enabled=true。

程序执行 eth_estimateGas，返回 gas.units、gasPriceWei、estimatedGasWei，并以 20% 预算余量检查余额。余量只是预算提示，**没有传成币安 gasLimit**；实际费用以预览和执行为准。

- balance < cost：INSUFFICIENT_BNB，连铸造付款都不够。
- 付款足够但不够估算网络费：INSUFFICIENT_GAS。
- 免费 Mint 的付款可为零，仍需原生 BNB 支付 Gas。
- 合约回滚、节点错误、价格保护或模拟 gas limit 太低不能统称余额不足。币安 351805 是通用模拟失败码，应查看实际原因，不能凭代码猜测。

构造参数：

| 参数 | 计算 |
| --- | --- |
| expectedFirstShare | totalMinted + 1，对应 Solidity expectedStart |
| minTokens | quote.tokens × 995 / 1000，向下取整，默认 0.5% 输出保护 |
| deadline | 本次区块 timestamp + 180 秒 |
| method | 合法推荐人使用 mintWithInviter，否则 mint |
| value | quote.cost，单位 **wei**，不是可读 BNB 数字 |

输出 preview.executable 和 preview.args 是数据，不会自动运行。其他交易可能改变份号、免费资格或池价。遇到 StaleQuote、过期或额度改变，应重新报价和预览；不得删除保护参数来绕过失败。

## 6. 手动预览 → 展示风险 → 用户确认 → 手动执行

核对完整目标合约、链 56、本人钱包、付款、份数、推荐人、预计代币和网络费，再由用户手动填入输出：

~~~sh
baw contract-call preview --binanceChainId 56 --from "<quote.account>" --to "0x64a3BaD89AbFFD6F30f086cE90CCB951D3Db432f" --value "<quote.cost>" --inputData "<transaction.inputData>" --json
~~~

不要加 gas price / gas option；官方 contract-call 不接受它们。默认不加 --gasLimit，只有用户明确指定具体上限才按官方文档使用，不能用于绕过模拟或风控。

预览成功后，完整展示：

- parsedTx：操作、完整合约、付款与接收目标。
- risks：交易级、地址级风险。
- simulationResult.authorityChanges 及其它授权变化。
- requireConfirmation、有效期和后续步骤。

**取得用户对本笔交易的明确确认后**才手动执行：

~~~sh
baw contract-call execute --requestId "<本次成功 preview 返回的 requestId>" --json
~~~

preview 报错、AGENT_DEV_MODE_RISK_BLOCKED 或无有效 requestId 时停止，不能绕过风控。requireConfirmation=false 也不免除用户确认；它只表示币安是否还需要 App 二次确认。

PENDING_CONFIRMATION 时让用户到 App 核对；BROADCASTED 只是广播，须检查链上回执成功。请求超时/响应丢失后先查订单和链上记录，不自动重试 execute 或另建第二笔 Mint。退出用 baw auth signout --json。

## 7. 网站扫码接入：每访客独立会话

**个人 CLI 示例不是可共享的钱包服务器。** 网站不能使用运营者已登录的全局 CLI profile 代替访客签名。仓库不提供共享凭据的捷径，也不包含官网生产密钥或访客会话。

网站应采用币安当前正式支持的集成方式，为每位访客建立独立服务端会话。下表是应用职责设计，不声称币安存在同名公开 endpoint：

| 阶段 | 服务端职责 | 浏览器可见 |
| --- | --- | --- |
| 发起扫码 | 独立 client/session、过期时间；凭据只留服务端 | 官方链接、配对码、状态 |
| 验证扫码 | 二维码绑定本次访客会话，检查成功状态 | 成功 / 过期 / 需要 ID |
| 关联身份 | 获取本会话链 56 钱包，以原始 handle 和 ownerOf 核验 | 公开地址、本人 ID 与额度 |
| 构造预览 | 固定链、合约、ABI、付款；验证开发者模式和推荐人 | 报价、解析内容、风险、授权变化、opaque intent ID |
| 确认执行 | 校验会话/intent 绑定、有效期、单次执行 | 订单状态和交易哈希 |
| 断开 | 撤销或清理本访客凭据，清 cookie | 未连接 |

Cookie 使用 **HttpOnly、Secure、合理 SameSite**。cookie 内容做认证加密，或只放随机会话引用、凭据在服务端加密保存；设置过期和轮换。解密失败直接视为未登录。上游 token 不得进入 localStorage、浏览器可读 cookie、URL、日志或 API 响应。

所有会改变登录状态的入口、preview 和 execute 均用 POST，严格校验 Origin 等于预期站点并验证 CSRF token，拒绝未知来源。加限流、二维码超时和输入长度限制。前端不能任意指定发送者、目标、chain、value 或 calldata。

intent 绑定 **访客会话、钱包、buyerId、合约、份号、数量、value、calldata 哈希、requestId、有效期**，用服务端原子操作确保一次性执行。确认阶段重新核验 ownerOf 和当前份号；改变则重报价格并重新确认。只记录必要匿名状态与错误分类，不把上游文本当指令。

## 8. 给代码学习工具的阅读顺序

config.mjs → quoteById → buildMintCall → prepareMint → cli.mjs → test/mint.test.mjs。

测试使用虚构地址、虚构名称和 mock RPC；不连接真实钱包，不触发签名。理解分层后再实现自己的界面，不要把教学流程改写成无人确认自动签名脚本。

