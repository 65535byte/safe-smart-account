# Safe 合约部署指南（v1.4.1-3）

在已知链或自定义链上部署 Safe 合约套件（Solidity `0.7.6`，13 个合约）并验证。

## 0. 版本校验（必做）

确定性部署对代码高度敏感：任何合约文件改动（哪怕注释）都会改变地址。部署前确认：

```bash
git describe --tags   # 应输出 v1.4.1-3
git status --short    # 应无输出
```

有改动则先 `git checkout v1.4.1-3` 并清空 `build/`、`deployments/`。

## 1. 部署机制（一分钟读懂）

- 所有合约经 **Safe Singleton Factory**（EVM 链：`0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`）以 **CREATE2 + salt 0** 确定性部署，因此**所有 EVM 链上地址完全相同**。
- 目标链的 **chainId 必须在 `@safe-global/safe-singleton-factory` 支持列表**（约 300 条链）中，否则报 `Safe factory not found for network <chainId>`（处理见 4.3）。
- 若链上 factory 尚未部署，脚本自动完成：部署账户向签名地址 `0xE1CB04A0fA36DdD16a06ea828007E35e1a3cBC37` 转 `gasPrice × gasLimit`（如主网 0.01 ETH）→ 广播预签名交易部署 factory。
- 因此账户余额需覆盖：factory 资金（若需）+ 13 笔合约部署 gas。

## 2. 部署的合约与预期地址

部署产物保存于 `deployments/<network>/`（每合约一个 JSON，含地址/ABI/交易哈希）。

| 合约 | 干什么用 / 什么时候需要 | 官方地址（salt 0，所有 EVM 链一致） |
|---|---|---|
| `Safe` | **多签钱包本体**。每个用户钱包都是指向它的代理，转账、验签逻辑全在这里。L1 用 | `0x41675C099F32341bf84BFc5382aF534df5C7461a` |
| `SafeL2` | 同上，但每笔交易额外发两个事件，便于 L2 上索引（L2 没有 trace）。L2 用它替代 `Safe` | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| `SafeProxyFactory` | **开钱包用**。一条交易生成一个用户钱包代理，地址可提前算出来。必装 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| `TokenCallbackHandler` | **收 NFT 用**。让钱包能接收 ERC-1155 / ERC-721（ERC-777 只是空壳） | `0xeDCF620325E82e3B9836eaaeFdc4283E99Dd7562` |
| `CompatibilityFallbackHandler` | **对外被识别用**。挂上它，钱包才能做合约签名（EIP-1271）、消息哈希、模块查询、交易预演，并包含上行的收款能力。默认 handler，强烈建议装 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |
| `MultiSend` | **打包用**。一笔多签里连发多笔（转账 + 授权 + …），任一失败全部回滚 | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` |
| `MultiSendCallOnly` | 同 `MultiSend`，但只允许普通调用、禁用 delegatecall，更安全，优先选它 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |
| `CreateCall` | **让钱包自己部署合约**（create / create2），多数场景用不到 | `0x9b35Af71d77eaf8d7e40252370304687390A1A52` |
| `SignMessageLib` | **签链下消息用**。把一条消息记为"本钱包已签"，dApp 才能用 EIP-1271 验证 | `0xd53cd0aB83D845Ac265BE939c57F53AD838012c9` |
| `SafeMigration` | **老钱包升级用**。把代理指向的旧版本换成新版，可顺带换 handler | `0x526643F69b81B008F46d95CD5ced5eC0edFFDaC6` |
| `SafeToL2Migration` | **把已有钱包搬到 L2**。1.1.1 / 1.3.0 / 1.4.1 → 同版本 L2 单例，要求钱包还没执行过交易 | `0xfF83F6335d8930cBad1c0D439A841f01888D9f69` |
| `SafeToL2Setup` | **新开钱包保持在多链同地址**。不在主网时把单例换成 L2 版，各链得到同一个钱包地址 | `0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54` |
| `SimulateTxAccessor` | **预估 gas / 预演用**。交易服务靠它判断一笔多签能不能成功 | `0x3d4BA2E0884aa488718476ca2FB8Efc291A46199` |

官方地址摘自 `CHANGELOG.md`；zkSync 链地址不同（zksolc 编译），见 `CHANGELOG.md` 的 "Expected addresses"。

> `MultiSend` 系 / `CreateCall` / `SignMessageLib` / `SafeMigration` / `SafeToL2*` 均为独立合约，由 Safe `delegatecall` 调用（Safe 称之 library，非 Solidity `library`）。

## 3. 准备

```bash
npm install          # Node ≥ 18（推荐 20 LTS，本指南实测 node v20.10.0）
cp .env.sample .env  # 编辑 .env
```

`.env` 关键项（私钥切勿提交到版本库）：

```ini
PK="0x..."            # 部署私钥；或用 MNEMONIC（PK 优先）
INFURA_KEY="..."      # mainnet/polygon 等基于 Infura 的网络必需
NODE_URL="..."        # 自定义链部署必需，注册为 custom 网络（chainId 由 RPC 获取）
CUSTOM_SALT="..."     # 可选：自定义 salt，见第 5 节
ETHERSCAN_API_KEY="..."  # 可选：浏览器验证
```

## 4. 部署

### 4.1 已知链（内置网络）

内置：`mainnet`、`gnosis`、`polygon`、`bsc`、`arbitrum`、`avalanche`、`zkSyncMainnet`/`zkSyncSepolia`（`goerli`/`mumbai`/`fantomTestnet` 已废弃）。

```bash
npm run deploy-all polygon   # = deploy → local-verify → sourcify → etherscan-verify
```

某一步验证失败不影响已完成的合约部署，可单独重跑该步骤。

### 4.2 自定义链（NODE_URL → `custom` 网络）

前置检查（chainId 换成你的）：

```bash
# RPC 可用且 chainId 正确
curl -s -X POST --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  -H "Content-Type: application/json" https://rpc.your-chain.example
# chainId 受 singleton factory 支持
node -e "const {getSingletonFactoryInfo} = require('@safe-global/safe-singleton-factory'); console.log(getSingletonFactoryInfo(12345) ?? 'NOT SUPPORTED')"
```

部署：

```bash
npm run deploy-custom   # = 清空 deployments/custom && deploy-all custom
```

`sourcify`/`etherscan-verify` 失败时可分步：`npx hardhat deploy --network custom && npx hardhat local-verify --network custom`。

### 4.3 全新链（chainId 不受支持）

需先落地 singleton factory：到 <https://github.com/safe-global/safe-singleton-factory> 申请/自行生成该链的预签名部署，然后 `npm i -D @safe-global/safe-singleton-factory@latest`，再按 4.2 部署。
替代方案：若链上已有 Arachnid 代理（`0x4e59b44847b379578588920cA78fbF26c0B4956c`），可修改 `hardhat.config.ts` 的 `deterministicDeployment` 对未知 chainId 回退到该代理——但地址与官方不同，Safe 生态工具不识别，仅适合私有链。

### 4.4 zkSync

`.env` 配置 `ZKSYNC_DEPLOYER_PK`（zkSync 模式只支持私钥），然后 `npm run deploy-all zkSyncSepolia`。地址与 EVM 不同（见 `CHANGELOG.md`），验证自动走 zkSync 浏览器。

### 4.5 按需部署：最小集合与单合约

默认的 `deploy-all` / `deploy-custom` 会部署全部 13 个合约并跑完验证链。**只想部署部分合约**时，用 `hardhat-deploy` 的 tag 机制即可。

#### 4.5.1 L2 场景：部署哪些以后不会缺件

前提：只认 `SafeL2`，`Safe`（L1 单例）与两个迁移库一律不部署。

**结论：一条命令，10 个合约，钱包 + DApp 全家桶都不缺件**

```bash
npx hardhat deploy --network custom --tags l2-suite
```

| 档位 | 合约 | 够干什么 |
|---|---|---|
| ① 能跑 | `SafeL2` + `SafeProxyFactory` | 能开钱包、发多签交易。没有合约签名和批量，官方前端 / SDK 接不上 |
| ② 能接入 | ① + `CompatibilityFallbackHandler` | 有 EIP-1271 合约签名、消息哈希、`simulate`、收款回调 |
| ③ 不缺件（推荐） | ② + `MultiSend` + `MultiSendCallOnly` + `SignMessageLib` + `CreateCall` + `SimulateTxAccessor` | 8 个，正好对应 protocol-kit `contractNetworks` 的 8 个地址字段（示例见第 5 节） |
| ④ `l2-suite` 全量 | ③ + `TokenCallbackHandler` + `SafeToL2Setup` | 10 个，多出的两个只在特定场景用，带上也省心 |

③ 里那 6 个为什么不能省：`MultiSend` / `MultiSendCallOnly` 是前端批量交易（SDK 两个字段都要）；`SignMessageLib` 是链下消息签名；`CreateCall` 是 SDK 的 `createCallAddress`；`SimulateTxAccessor` 供 gas 估算与交易预演。

明确不装：`Safe`（被 `SafeL2` 取代）、`SafeMigration` / `SafeToL2Migration`（只有旧版钱包要升级 / 搬到 L2 才用，且 `deploy_migrations.ts:10-12` 要读 `Safe` 的部署记录，不装 `Safe` 就别跑 `--tags migration`）。

#### 4.5.2 单合约 / 单组部署命令

`src/deploy/` 每个脚本都通过 `deploy.tags` 注册了一组 tag，命令形如：

```bash
npx hardhat deploy --network <network> --tags <tag1,tag2,...>
```

> `--tags` 是**或**关系（脚本任一 tag 命中即跑，见 `DeploymentsManager.executeDeployScripts`）；要**交集**（脚本必须同时含全部 tag）加 `--tags-require-all`。`deploy` 任务没有 `--exclude` 这个选项。

| 需求 | 命令 | 部署产物 |
|---|---|---|
| 只 Safe | `npx hardhat deploy --network custom --tags singleton` | `Safe` |
| 只 SafeL2 | `--tags l2` | `SafeL2` |
| 只 factory | `--tags factory` | `SafeProxyFactory` |
| 只 handlers | `--tags handlers` | `TokenCallbackHandler` + `CompatibilityFallbackHandler` |
| 只 libraries | `--tags libraries` | `MultiSend` / `MultiSendCallOnly` / `CreateCall` / `SignMessageLib` / `SafeToL2Setup` |
| 只 accessors | `--tags accessors` | `SimulateTxAccessor` |
| 只 migration | `--tags migration` | `SafeMigration` + `SafeToL2Migration` |
| 全量（除 migration） | `--tags main-suite` | 11 个合约（Safe + SafeL2 + 其余 9 个） |
| 全量（除 Safe） | `--tags l2-suite` | 10 个合约（SafeL2 + 其余 9 个） |

#### 4.5.3 按需部署的依赖顺序

`hardhat-deploy` 会按 import 顺序与 tag 关系自动排序，但若你只跑部分 tag，**被省略的合约不会被部署**，相关构造函数参数会取不到 deployment 记录，导致失败。安全做法：

- `SafeProxyFactory` 不依赖任何前置合约，单独部署无问题；
- `CompatibilityFallbackHandler` 单独部署无问题；
- `MultiSend` 等 library 是独立部署，无依赖，单独跑 `--tags libraries` 即可；
- `SafeMigration` 构造函数要 `Safe` / `SafeL2` / `CompatibilityFallbackHandler` 的地址（`deploy_migrations.ts:10-12` 用 `deployments.get()` 取）；若只跑 `--tags migration` 且 `deployments/<network>/` 中没有这些合约，hardhat-deploy 会报错。**先跑 `singleton l2 factory handlers` 再跑 `migration`**，或一次性跑 `main-suite migration`；
- 自定义 salt 部署时，**整批 salt 必须一致**——见 5 节末尾提醒。

## 5. 自定义 salt：部署一套地址与官方不同的合约

场景：目标链官方已部署过 Safe（如 BSC 测试网 chainId 97），需要**字节码完全一致、地址全新**的一套合约。

原理：CREATE2 地址只由 `factory + salt + init code` 决定，与链无关；官方用 salt 0。本仓库已内置开关（零合约改动）：`src/utils/deploy.ts` 的 `CREATE2_SALT` 读取环境变量 `CUSTOM_SALT`，`src/deploy/` 下 7 个脚本（13 处）统一引用；**不设置时行为与官方完全一致**。

```ini
# .env
CUSTOM_SALT="bsc97-safe-custom-v1"   # 可读字符串或 0x hex，≤32 字节，自动 zeroPad
```

```bash
npm run deploy-custom    # BSC 测试网示例（NODE_URL 指向 BSC 测试网 RPC）
```

要点：

- **同一 salt 幂等**（重复部署命中同一地址，脚本按 `deployments/` 记录自动跳过）；换一个 salt 即得一套全新地址；
- 改 salt 重新部署前清空 `deployments/custom`（`deploy-custom` 已自动处理）；
- 新地址**不被官方 `safe-deployments`、Safe{Wallet}、官方 Transaction Service 识别**，需在 SDK 中以 `contractNetworks` 传入（下例），且勿提交到官方仓库。

```ts
// @safe-global/protocol-kit（字段名以所用版本类型定义为准）
const contractNetworks = {
    97: {
        safeSingletonAddress: "0x7107598fC9Ac2718a98771DA6df71d3d21F4faC5",
        safeProxyFactoryAddress: "0x09998762C09B3a885C90c0C40658857981aA012d",
        multiSendAddress: "0xe901a4978bd68a360DDA17A61F4382E89287eCBd",
        multiSendCallOnlyAddress: "0x312102E52d638E6EdC967074Ca7857c0D09A14Fd",
        fallbackHandlerAddress: "0x2F57c69e51933d5cEb37efd30c71962f089D9343",
        signMessageLibAddress: "0x99a6F833cf53AC44079268a15A4615712b00B18A",
        createCallAddress: "0x0b60AfAD02345f63Ad493F8298f1678dC065F9C7",
        simulateTxAccessorAddress: "0x6cABAFF358eFF954154d21fdef11A065CaE6d9a2",
    },
};
const safeFactory = await SafeFactory.init({ provider, signer, contractNetworks });
```

用该 factory 创建的 Safe 代理地址由 `singleton + 初始化参数 + saltNonce` 决定，与部署 salt 无关。

## 6. 验证

```bash
npx hardhat local-verify --network <network>   # 逐合约对比链上字节码，应全部 SUCCESS
npx hardhat etherscan-verify --network <network> --force-license --license LGPL-3.0
```

- `local-verify` 首次运行需从 `solc-bin.ethereum.org` 下载 solc 0.7.6 并逐个重编译（`Safe` 单个可达数分钟），属正常。
- 自定义链的 `etherscan-verify` 需先在 `hardhat.config.ts` 的 `etherscan.customChains` 注册（`network: "custom"`、`chainId`、`apiURL`/`browserURL`）。
- 核对地址：`cat deployments/<network>/Safe.json`，与第 2 节比对。

## 7. 常见问题

| 现象 | 解决 |
|---|---|
| `HH18 corrupted lockfile` | `rm -rf node_modules && npm ci` |
| `Safe factory not found for network <id>` | chainId 不受支持，见 4.3 |
| `insufficient funds` | 补足余额：factory 资金（若需）+ 13 笔部署 gas |
| 部署地址与第 2 节不符 | 代码偏离官方版本：`git checkout v1.4.1-3`，清空 `build/`、`deployments/`，勿设 `SOLIDITY_VERSION` |
| `Could not find Infura key` | 在 `.env` 配置 `INFURA_KEY`，或改用 `NODE_URL` + `custom` |
| `local-verify` 长时间无输出 | 首次下载 solc + 重编译较慢，属正常 |
| `CUSTOM_SALT must be at most 32 bytes` | 缩短 salt（UTF-8 中文每字 3 字节） |
| 设了 `CUSTOM_SALT` 但地址仍是官方的 | 旧 `deployments/` 记录导致跳过：清空后重跑（`deploy-custom` 已自动处理） |

## 参考链接

- Safe Singleton Factory：<https://github.com/safe-global/safe-singleton-factory>
- 官方部署地址记录：<https://github.com/safe-global/safe-deployments>
- Safe 开发者文档：<https://docs.safe.global>
- 本仓库版本地址清单：`CHANGELOG.md`
