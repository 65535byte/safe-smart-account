# 自定义链 8379 部署实施方案（自建 CREATE2 工厂 + Safe l2-suite）

> 适用仓库版本：`@safe-global/safe-contracts` v1.4.1-3
> 创建日期：2026-10-21
> 相关文档：`docs/deployment.md`（通用部署说明）

## 1. 目标（用户确认版）

| # | 目标 | 本方案是否达成 |
|---|---|---|
| 1 | 自己在自定义链上部署 factory | ✅ 阶段 5，发一笔 creation-code 交易即可 |
| 2 | 自定义链上成功部署 Safe 合约 | ✅ 阶段 7，`--tags l2-suite`（10 个合约） |
| 3 | 正式部署前都可测试 | ✅ 阶段 2 静态检查、阶段 3 本地演练、阶段 6 单合约小额试产 |
| 4 | RPC `https://rpc.fusn.network/` | ✅ 已配置为 `NODE_URL`，对应 `custom` 网络 |

### 边界说明（重要，非阻塞）

- 自己部署的工厂 ⇒ **合约地址既不等于官方地址，也不等于现有 BSC 测试网（97）那套**（后者是"官方工厂 + `CUSTOM_SALT`"）。这是 CREATE2 公式的必然结果，不是配置问题。
- 若要让 8379 与 BSC 测试网那套地址一致，唯一途径是拿到 8379 的官方工厂（向 `safe-global/safe-singleton-factory` 申请）后配同一个 `CUSTOM_SALT`；或者在两条链上都改用这同一个自建工厂重部署一遍 BSC。
- 自建工厂 + 同一把专用私钥 + 各链 nonce=0 + 同一 `CUSTOM_SALT` ⇒ **在你自己的多条链之间地址完全一致**。

## 2. 已知环境事实（已实测，作为各阶段基线）

| 项 | 值 |
|---|---|
| chainId | `0x20bb` = 8379 |
| `eth_gasPrice` | 1 gwei；最新块 `baseFeePerGas` = `0x7` |
| 官方工厂 `0x914d7Fec…43d7` | `getCode` = `0x`（不存在） |
| Arachnid 工厂 `0x4e59b448…4956c` | `getCode` = `0x`（不存在） |
| 未被 `@safe-global/safe-singleton-factory@1.0.33`（343 条）收录 | 这是原始报错 `Safe factory not found for network 8379` 的根因 |
| CREATE2 代理部署成本 | `eth_estimateGas` = `0x10d78` = 68,984（取 gasLimit 150000） |
| `CUSTOM_SALT` | `TnEGZn2jJVYEtNNueyJU`（**全程不得变更**） |

## 3. 为什么要自建工厂

CREATE2 地址 = `keccak256(0xff ++ factory ++ salt(32B) ++ keccak(initcode))[12:]`，与 nonce、部署者、时间无关。
工厂本身用 CREATE 部署，其地址取决于 `(发送者, nonce)` ⇒ 用**专用账户的 nonce=0** 才能在每条链上落同一个工厂地址。
hardhat-deploy 检测到工厂 `getCode != "0x"` 后会**跳过**"给别人账户打钱 + 广播预签名交易"（`hardhat-deploy/dist/src/helpers.js:251-256`）。

## 4. 环境变量

```ini
NODE_URL="https://rpc.fusn.network/"   # 已存在
CUSTOM_SALT="TnEGZn2jJVYEtNNueyJU"     # 已存在，保持
FACTORY_DEPLOYER_PK="0x..."            # 阶段 4 生成：专用、nonce=0
CREATE2_FACTORY="0x..."                # 阶段 5 部署后回填
# ALLOW_ARACHNID_FACTORY=1             # 可选：无自建工厂时回退到 0x4e59...（hardhat-deploy 内置）
```

`hardhat.config.ts` 的 `deterministicDeployment` 优先级（本次改动）：

1. 官方 `getSingletonFactoryInfo(chainId)` 命中 → 行为不变（保护现有 BSC 测试网那套）
2. `CREATE2_FACTORY` → 自建代理
3. `ALLOW_ARACHNID_FACTORY=1` → 返回 `undefined`，由 hardhat-deploy 走内置 Arachnid 兜底
4. 以上都没有 → 抛原始错误

## 5. 阶段与验收标准

### 阶段 1｜代码改动

- `hardhat.config.ts`：加入上述优先级逻辑（返回类型放宽为 `DeterministicDeploymentInfo | undefined`）。
- 新增独立脚本 `scripts/deploy-create2-proxy.js`（npm：`create2-factory` / `create2-factory:check`）：
  部署前检查 RPC/chainId/nonce/余额/gas 估算/目标地址占用，部署后校验字节码并做两级自检，任一步失败即中断。
- 新增 task `predict-create2`：在不部署的前提下预测 l2-suite 各合约的最终地址。

**验收**：脚本输出的预测地址 = 实际地址，且字节码校验与自检 A / 自检 B 全部通过。

### 阶段 2｜静态检查

```bash
npx tsc --noEmit
npm run lint:ts
```

**验收**：零 error。

### 阶段 3｜本地演练（不产生任何链上费用）

```bash
ALLOW_ARACHNID_FACTORY=1 npx hardhat deploy --network hardhat --tags l2-suite --write false

npx hardhat node                                          # 另开终端，保活状态
node scripts/deploy-create2-proxy.js --rpc http://127.0.0.1:8545 --pk <本地 nonce=0 账户私钥>
CREATE2_FACTORY=<工厂地址> npx hardhat predict-create2 --network localhost
CREATE2_FACTORY=<工厂地址> npx hardhat deploy --network localhost --tags l2-suite --write false
CREATE2_FACTORY=<工厂地址> npx hardhat deploy --network localhost --tags l2-suite --write false   # 幂等重跑
```

**验收**：

- 第二段 deploy 日志**没有** `sending eth to create2 contract deployer address`、`deploying create2 deployer contract`（说明未给任何人打钱、未广播预签名 tx）；
- `predict-create2` 的预测地址 = deploy 实际产出的地址（逐字节）；
- 第二次重跑全部是 `reusing "Xxx" at 0x…`，无新部署；
- `--write false` 保证 `deployments/` 不被演练数据污染。

### 阶段 4｜8379 上线前预检

```bash
npx ts-node -e "const {ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log(w.address,w.privateKey)"
```

这些检查已内置在 `scripts/deploy-create2-proxy.js` 里（RPC/chainId、nonce 必须为 0、目标地址是否被占用、gas 估算、余额是否够），任一项不满足会直接中断并提示处理办法——因此**本阶段无需手工逐个 curl 验证**：

- 专用账户 nonce == 0（否则换新账户，此时零花费）；
- 余额覆盖 `gasLimit × gasPrice`（脚本会算出具体数值）；
- `eth_estimateGas(creation code)` 仍约 `0x10d78`；
- `CREATE(sender, nonce=0)` 预测出的目标地址 `getCode == "0x"`（防撞坑）。

### 阶段 5｜部署工厂到 8379（不可逆，但成本约 7 万 gas）

```bash
npm run create2-factory -- --expect-chain-id 8379        # 或：node scripts/deploy-create2-proxy.js
```

脚本会依次输出：`[ OK ]` 各项前置检查 → 交易 hash → 代理地址 → 字节码校验 → 自检 A（静态模拟 CREATE2）→ 自检 B（真实部署探针）；
任何一步失败都以 `[失败]` 开头打印原因并立即中断。

**验收**：脚本末段打印「代理地址」「交易 hash」，且字节码校验与自检 A / B 均 `[ OK ]`。
把代理地址回填 `.env` 的 `CREATE2_FACTORY`。

### 阶段 6｜小额试产（只部署 1 个合约）

```bash
npx hardhat predict-create2 --network custom          # 先看预测地址
npx hardhat deploy --network custom --tags accessors
npx hardhat local-verify --network custom
```

**验收**：

- 无打款、无工厂 bootstrap 日志；
- `SimulateTxAccessor` 实际地址 = 预测地址；
- `local-verify` 输出 `SUCCESS`（唯一能发现"地址被他人占坑"的检查，因为 hardhat-deploy 只看 code 是否为空，不比对字节码）；
- 记录该笔 gas ⇒ 推算全量预算（`单笔均值 × 10 + 20% 余量`）给 deployer 充值。

### 阶段 7｜正式部署全套

```bash
rm -rf deployments/custom
npx hardhat deploy --network custom --tags l2-suite
npx hardhat local-verify --network custom
```

**产出**：

- `deployments/custom/*.json`（10 个合约地址，目录已在 `.gitignore`，需自行导出备份）；
- protocol-kit 的 `contractNetworks[8379]` 片段；
- 端到端冒烟：`SafeProxyFactory.createProxyWithNonce` 创建钱包 → 读 `getOwners/threshold` → 用 `SimulateTxAccessor` 预演一笔交易。

## 6. 风险与预案

| 风险 | 触发点 | 预案 |
|---|---|---|
| 专用账户 nonce 非 0 | 阶段 4 | 换账户重来（尚无花费） |
| CREATE2 目标地址已被他人占坑 | 阶段 6/7 | `local-verify` 会失败；换新的 `CUSTOM_SALT` 后重部署（换 salt 前 `rm -rf deployments/custom`） |
| gas 不足 | 阶段 7 中途失败 | 已完成的会被 `deployments/` 记录，补足余额后重跑即可续上 |
| `FACTORY_DEPLOYER_PK` 丢失 | 后续跨链复现 | 工厂无 owner，安全无影响；但要在新链复现同地址必须用同一把 key 且 nonce=0 ⇒ 必须离线备份 |
| 将来拿到官方工厂想切回去 | 之后 | 整套重部署 + 已开钱包走 `changeMasterCopy` / `SafeToL2Migration`（后者要求钱包未执行过交易） |

## 7. 合约清单（`l2-suite`，10 个）

`SafeL2`、`SafeProxyFactory`、`TokenCallbackHandler`、`CompatibilityFallbackHandler`、`MultiSend`、`MultiSendCallOnly`、`CreateCall`、`SignMessageLib`、`SafeToL2Setup`、`SimulateTxAccessor`
（不含 `Safe`，L1 单例由 `SafeL2` 替代；`migration` 相关 tag 不在此集合内）

## 8. 执行记录

> 私钥不写入任何仓库文件。`.env` 已在 `.gitignore` 中。

### 已改动的代码

- `hardhat.config.ts`：`deterministicDeployment` 改为「官方 → `CREATE2_FACTORY` → `ALLOW_ARACHNID_FACTORY` → 报错」优先级；返回类型放宽为 `DeterministicDeploymentInfo | undefined`。
- 新增 task `src/tasks/deploy_create2_factory.ts`：部署自建 CREATE2 代理，带 nonce=0 校验、预测/实际地址比对、runtime code 校验、余额预检。
- 新增 task `src/tasks/predict_create2.ts`：部署前预测 `l2-suite` 全部合约地址。
- 修复 `src/utils/deploy.ts`：`arrayify` 在 ethers v6 已移除，改用 `getBytes`（否则 `CUSTOM_SALT` 使用 `0x` 前缀 hex 时会崩溃）。

### 阶段 2｜静态检查

- `npx tsc --noEmit`：仅剩既有错误 `test/libraries/SafeMigration.spec.ts(68)`（改动前已存在，与本次无关）。
- `npm run lint:ts` 不可用（仓库 `.eslintrc.js` 与已安装的 ESLint 9 不兼容，属既有问题）。
- `npx prettier --check` 对本次改动文件：全部符合。

### 阶段 3｜本地演练（全部通过）

| 检查项 | 结果 |
|---|---|
| Arachnid 兜底路径（`HARDHAT_CHAIN_ID=8379 ALLOW_ARACHNID_FACTORY=1`，`--network hardhat`） | ✅ 自动 bootstrap 工厂并部署 10 个合约 |
| 自建工厂路径（`--network localhost`） | ✅ 预测工厂地址 = 实际地址，runtime code 校验 OK |
| 日志中是否出现 `sending eth to create2 contract deployer address` / `deploying create2 deployer` | ✅ 未出现（未给任何第三方账户打钱） |
| `0x3fab…` 余额 | ✅ 保持 `0x0` |
| `predict-create2` 预测地址 vs `deploy` 实际地址 | ✅ 10 个逐个一致 |
| 幂等重跑 | ✅ 10 个全部 `reusing`，无重复部署 |

实测 gas（含工厂）：**9,193,848**；@1 gwei ≈ 0.0092 原生币，@10 gwei ≈ 0.092 原生币。

### 阶段 4｜8379 预检

| 项 | 值 | 结论 |
|---|---|---|
| 专用工厂部署账户 | `0x96319a73aeB403484a8219Ec8981a2d75303CC0D` | 需离线备份私钥 |
| 账户 nonce | `0x0` | ✅ 可用于复现同一工厂地址 |
| 账户余额 | `0x0` | ⏳ **待充值 0.005~0.01 原生币**（实际只需 ~0.00007，余量用于防止 gasPrice 波动） |
| 预测工厂地址 | `0xdEb169c04b56fC0fb31B132732e3c7f558F43291` | 与已部署? `getCode` = `0x` ✅ 无冲突 |
| creation code `eth_estimateGas` | `0x10d78`（68,984） | ✅ 与基准一致 |

**两个账户的费用归属（避免混淆）**

| 账户 | 负责 | 成本 |
|---|---|---|
| 专用工厂账户（`FACTORY_DEPLOYER_PK`） | 仅工厂创建这一笔交易 | ~0.00007 native @1 gwei |
| Deployer（`.env` 的 `PK`，即 `0x45A52ECc130F688ea7CF082b035406fCfEd73f72`） | 10 个 Safe 合约 | ~0.0092 @1 gwei、~0.092 @10 gwei |

Deployer 当前余额 **0.103 native**、nonce `0x0`，**已充足，无需再充**。

### 阶段 5｜工厂已上链 ✅

| 项 | 值 |
|---|---|
| 专用部署账户 | `0x961FbA702DBF881969D1b4337b02b7969E2a082D` |
| 工厂地址 | `0x13A44e4554287Df666CB9a98e521603b999b6F93` |
| 部署交易 | `0x1ed3bc02e9a52bc3add3f35f141702ae64e9b24505aa2b055cf8667d54b52c48` |
| 预测 = 实际 | ✅ |
| runtime code | ✅ 与 Arachnid 标准一致 |
| 消耗 | 68,984 gas（@0.1 gwei ≈ 0.0000069 native） |

### 阶段 6｜小额试产 ✅

`SimulateTxAccessor` 实际地址 `0x286e7e170A8E8B18583a6AE2D516eaF06cC23D45` = 预测地址；日志无 `sending eth` / `deploying create2 deployer`。

> `npx hardhat local-verify` 需从 `solc-bin.ethereum.org` 下载编译器，本环境网络不可达。改用仓库内 `scripts/verify-local-offline.js`：复用 hardhat 已缓存的 solc 0.7.6 原生编译器，复刻 `src/tasks/local_verify.ts` 的逻辑（含 immutable 占位置零），校验结果等价。

### 阶段 7｜全量部署 ✅

```bash
rm -rf deployments/custom
npx hardhat deploy --network custom --tags l2-suite --no-compile     # 10/10 成功
node scripts/verify-local-offline.js custom                          # 10/10 OK
```

链上花费合计（含工厂 + 冒烟开钱包）：**9,450,303 gas**，按当时 0.1 gwei 计约 **0.000945 native**。

## 9. 部署结果（chainId 8379）

| 合约 | 地址 |
|---|---|
| CREATE2 工厂（自建） | `0x13A44e4554287Df666CB9a98e521603b999b6F93` |
| SafeL2（singleton） | `0x45569bDbDdBcAe9DB577a6c067E2E11887e28276` |
| SafeProxyFactory | `0x4C845307d3e45aa0A288932A4789efB5E2f08daD` |
| CompatibilityFallbackHandler | `0x33538B5e7616DF0C71920C1a655576e3f323CA44` |
| TokenCallbackHandler | `0x61c15252402B5e71E273a1270e654EaeFb7cdC3B` |
| MultiSend | `0xb8C0986B000004326caDD995a7702aE52073D2bc` |
| MultiSendCallOnly | `0xf96181FA78cA9b85d8d954E7B7F4E6f850BB02c0` |
| SignMessageLib | `0xdc1Addc6737e5EcBFc75b1a910e7A0A0b5600acE` |
| CreateCall | `0x4cf68B6b7380678aDEFf4701d4fcf465cB7c6f4B` |
| SimulateTxAccessor | `0x286e7e170A8E8B18583a6AE2D516eaF06cC23D45` |
| SafeToL2Setup | `0xf5ed7F2FCbB70396430313c08A216A1D3a08460D` |

`CUSTOM_SALT`：`TnEGZn2jJVYEtNNueyJU`（**改之前务必别动，否则整套地址变更**）

### protocol-kit `contractNetworks`

```ts
const contractNetworks = {
    8379: {
        safeSingletonAddress: "0x45569bDbDdBcAe9DB577a6c067E2E11887e28276", // SafeL2
        safeProxyFactoryAddress: "0x4C845307d3e45aa0A288932A4789efB5E2f08daD",
        fallbackHandlerAddress: "0x33538B5e7616DF0C71920C1a655576e3f323CA44",
        multiSendAddress: "0xb8C0986B000004326caDD995a7702aE52073D2bc",
        multiSendCallOnlyAddress: "0xf96181FA78cA9b85d8d954E7B7F4E6f850BB02c0",
        signMessageLibAddress: "0xdc1Addc6737e5EcBFc75b1a910e7A0A0b5600acE",
        createCallAddress: "0x4cf68B6b7380678aDEFf4701d4fcf465cB7c6f4B",
        simulateTxAccessorAddress: "0x286e7e170A8E8B18583a6AE2D516eaF06cC23D45",
    },
};
```

### 端到端冒烟 ✅

`SafeProxyFactory.createProxyWithNonce(singleton, initializer, 42)` → 代理 `0xd4eD405E23643FCBAd589B0F3E274aEe7a5Fb180`，
`getOwners()` = `[0x2319982fC83a8A5a021fbB0362Ac1Ba6D3e8b564]`，`getThreshold()` = 1，`VERSION()` = `1.4.1`，`domainSeparator()` 可读。

## 10. 后续复现方式（换机器 / 新增同套体系的链）

1. 新链上给同一把 `FACTORY_DEPLOYER_PK` 充少量 gas，**确保它是该账户在该链的第一笔交易**；
2. `npx hardhat deploy-create2-factory --network custom`（得到同一个工厂地址）；
3. `.env` 保持同一 `CUSTOM_SALT`；
4. `npx hardhat deploy --network custom --tags l2-suite` ⇒ 得到**完全相同**的合约地址。
