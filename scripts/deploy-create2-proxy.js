#!/usr/bin/env node
/**
 * 自建 CREATE2 代理专用脚本（standalone，不依赖 hardhat）
 *
 * 作用：
 *   1) 部署前逐项检查前置条件，任一项不满足即中断并给出明确原因；
 *   2) 发送创建交易，成功后输出代理地址与交易 hash；
 *   3) 校验代理字节码、并用「静态模拟 + 真实部署探针」两级自检确认代理功能正常。
 *
 * 前提：该私钥必须是本链上的全新账户（nonce = 0），否则工厂地址无法在多条链上复现。
 *
 * 用法：
 *   node scripts/deploy-create2-proxy.js                     # 部署（读取 FACTORY_DEPLOYER_PK）
 *   node scripts/deploy-create2-proxy.js --pk 0xabc...       # 指定私钥
 *   node scripts/deploy-create2-proxy.js --check             # 只校验已有代理（不做任何部署也不花钱）
 *   node scripts/deploy-create2-proxy.js --expect-chain-id 8379
 *
 * 可选参数：
 *   --rpc <url>            默认读 .env 的 NODE_URL
 *   --pk <hex>             默认读 .env 的 FACTORY_DEPLOYER_PK
 *   --factory <address>    只校验该地址上的代理（配合 --check 或已存在时自动使用）
 *   --expect-chain-id <n>  校验目标链 chainId，不一致立即中断
 *   --check                仅校验，不部署、不发送任何交易
 *   --skip-probe           跳过真实部署探针（默认开启，可用此参数关闭以省 gas）
 *   --gas-limit <n>        覆盖创建交易的 gasLimit（默认：估算值 + 20%）
 *   --json                 以 JSON 输出结果，便于脚本消费
 */

const path = require("path");
const { ethers } = require("ethers");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

/** Arachnid deterministic-deployment-proxy 的 creation code（83 字节） */
const CREATION_CODE =
    "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

/** 部署后应得到的 runtime code */
const RUNTIME_CODE =
    "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

/** 探针交易使用的 salt（固定值，保证任意链上探针地址可预测） */
const PROBE_SALT = ethers.keccak256(ethers.toUtf8Bytes("safe-contracts:create2-proxy-self-check"));

const ok = (msg) => console.log(`[ OK ] ${msg}`);
const info = (msg) => console.log(`[信息] ${msg}`);
const warn = (msg) => console.log(`[警告] ${msg}`);
const fail = (msg) => {
    console.error(`[失败] ${msg}`);
    process.exit(1);
};

const unquote = (value) => String(value || "").trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");

function parseArgs(argv) {
    const args = {};
    const known = new Set([
        "rpc",
        "pk",
        "factory",
        "expect-chain-id",
        "check",
        "skip-probe",
        "gas-limit",
        "json",
        "help",
    ]);
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        if (!known.has(key)) fail(`未知参数 --${key}，可用 --help 查看用法`);
        const next = argv[i + 1];
        if (next && !String(next).startsWith("--")) {
            args[key] = next;
            i++;
        } else {
            args[key] = "true";
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0]);
        return;
    }

    const rpcUrl = unquote(args.rpc) || unquote(process.env.NODE_URL);
    if (!rpcUrl) fail("缺少 RPC 地址：请通过 --rpc 传入，或在 .env 中配置 NODE_URL");

    // ---------- 1. 连接节点 ----------
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(rpcUrl);
        await provider.getNetwork();
    } catch (e) {
        fail(`无法连接 RPC（${rpcUrl}）：${e.shortMessage || e.message}`);
    }

    let chainId, gasPrice, baseFee;
    try {
        const network = await provider.getNetwork();
        chainId = Number(network.chainId);
        const feeData = await provider.getFeeData();
        gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
        const head = await provider.getBlock("latest");
        baseFee = head && head.baseFeePerGas ? head.baseFeePerGas : null;
    } catch (e) {
        fail(`读取链信息失败：${e.shortMessage || e.message}`);
    }

    ok(`RPC 连通，chainId = ${chainId}，gasPrice = ${ethers.formatUnits(gasPrice, "gwei")} gwei` +
        (baseFee !== null ? `，baseFee = ${ethers.formatUnits(baseFee, "gwei")} gwei` : ""));

    if (args["expect-chain-id"] && Number(args["expect-chain-id"]) !== chainId) {
        fail(`chainId 不匹配：期望 ${args["expect-chain-id"]}，实际 ${chainId}。请确认 --rpc 指向正确的网络`);
    }

    // ---------- 2. 私钥与账户 ----------
    const pkRaw = unquote(args.pk) || unquote(process.env.FACTORY_DEPLOYER_PK);
    if (!pkRaw) fail("缺少部署私钥：请通过 --pk 传入，或在 .env 中配置 FACTORY_DEPLOYER_PK");

    let wallet;
    try {
        wallet = new ethers.Wallet(pkRaw, provider);
    } catch (e) {
        fail(`私钥格式非法：${e.shortMessage || e.message}`);
    }

    let nonce, balance;
    try {
        nonce = await provider.getTransactionCount(wallet.address);
        balance = await provider.getBalance(wallet.address);
    } catch (e) {
        fail(`读取账户状态失败：${e.shortMessage || e.message}`);
    }

    ok(`部署账户 ${wallet.address}：nonce = ${nonce}，余额 = ${ethers.formatEther(balance)} 原生币`);

    const predictedFactory = ethers.getCreateAddress({ from: wallet.address, nonce: 0 });

    if (args.check || args.factory) {
        const target = args.factory || predictedFactory;
        await verifyFactory(provider, target, { chainId, skipProbe: Boolean(args["skip-probe"]), wallet });
        report({ mode: "check", factory: target, chainId, deployed: false });
        return;
    }

    // ---------- 3. 前置条件：nonce 必须为 0 ----------
    if (nonce !== 0) {
        fail(
            `账户 ${wallet.address} 在该链的 nonce 已是 ${nonce}，必须为 0。\n` +
                `原因：代理地址 = CREATE(账户, nonce)，只有 nonce = 0 时在每条链上才能得到同一个地址 ${predictedFactory}。\n` +
                `处理办法：换一个全新账户（重新生成私钥并充值），或直接在 .env 里替换 FACTORY_DEPLOYER_PK。`,
        );
    }
    ok(`账户 nonce = 0，代理地址可在各链复现：${predictedFactory}`);

    // ---------- 4. 前置条件：目标地址必须为空 ----------
    const existing = await provider.getCode(predictedFactory);
    if (existing !== "0x") {
        if (existing.toLowerCase() === RUNTIME_CODE.toLowerCase()) {
            ok(`代理已经存在于 ${predictedFactory}，无需重复部署`);
            await verifyFactory(provider, predictedFactory, { chainId, skipProbe: Boolean(args["skip-probe"]), wallet });
            report({ mode: "already-deployed", factory: predictedFactory, chainId, deployed: false });
            return;
        }
        fail(`目标地址 ${predictedFactory} 已被其它合约占用（code = ${existing.slice(0, 20)}…），无法部署代理。请更换部署账户。`);
    }
    ok(`目标地址 ${predictedFactory} 为空，可以部署`);

    // ---------- 5. 前置条件：跑页岩估算 + 余额充足 ----------
    let estimatedGas;
    try {
        estimatedGas = await provider.estimateGas({ from: wallet.address, data: CREATION_CODE });
    } catch (e) {
        fail(`创建交易的 gas 估算失败，该链可能不支持该 bytecode 或节点异常：${e.shortMessage || e.message}`);
    }

    const gasLimit = args["gas-limit"] ? BigInt(args["gas-limit"]) : (estimatedGas * 120n) / 100n;
    const cost = gasLimit * gasPrice;
    ok(`gas 估算 = ${estimatedGas}，将使用 gasLimit = ${gasLimit}，预计消耗 ${ethers.formatEther(cost)} 原生币`);

    if (balance < cost) {
        fail(
            `余额不足：需要约 ${ethers.formatEther(cost)} 原生币（gasLimit ${gasLimit} × gasPrice ${ethers.formatUnits(
                gasPrice,
                "gwei",
            )} gwei），当前只有 ${ethers.formatEther(balance)}。\n` +
                `请至少向 ${wallet.address} 转入 ${ethers.formatEther((cost * 12n) / 10n)} 原生币后重试。`,
        );
    }
    ok(`余额充足（预留约 ${ethers.formatEther(cost)} 原生币用于本次部署）`);

    // ---------- 6. 发送创建交易 ----------
    let tx, receipt;
    try {
        tx = await wallet.sendTransaction({ data: CREATION_CODE, gasLimit });
        info(`创建交易已发送：${tx.hash}`);
        receipt = await tx.wait(1);
    } catch (e) {
        fail(`发送创建交易失败：${e.shortMessage || e.message}`);
    }

    if (!receipt || receipt.status !== 1) {
        fail(`创建交易回滚：${tx.hash}（status = ${receipt ? receipt.status : "unknown"}）。请检查该链的 gas 参数与 EVM 兼容性。`);
    }
    ok(`交易已确认：${tx.hash}（区块 ${receipt.blockNumber}，实际消耗 ${receipt.gasUsed} gas）`);

    const deployed = receipt.contractAddress;
    if (!deployed) fail(`交易 ${tx.hash} 未返回合约地址，代理可能未成功创建。`);
    if (deployed.toLowerCase() !== predictedFactory.toLowerCase()) {
        fail(`地址不一致：预测 ${predictedFactory}，实际 ${deployed}。请停止后续部署并人工复核。`);
    }
    ok(`代理地址：${deployed}`);

    // ---------- 7. 校验 ----------
    await verifyFactory(provider, deployed, { chainId, skipProbe: Boolean(args["skip-probe"]), wallet });

    report({ mode: "deployed", factory: deployed, chainId, txHash: tx.hash, deployed: true });
}

/** 校验代理字节码，并做两级功能自检 */
async function verifyFactory(provider, factory, { skipProbe, wallet }) {
    const code = await provider.getCode(factory);
    if (code === "0x") fail(`地址 ${factory} 上没有合约代码，代理不存在。`);
    if (code.toLowerCase() !== RUNTIME_CODE.toLowerCase()) {
        fail(`地址 ${factory} 的字节码与标准 CREATE2 代理不一致：\n  实际：${code.slice(0, 66)}…\n  期望：${RUNTIME_CODE.slice(0, 66)}…`);
    }
    ok("字节码校验通过：与标准 CREATE2 代理（Arachnid deterministic-deployment-proxy）一致");

    // 自检 A：静态模拟一次 CREATE2，比对返回地址是否符合 CREATE2 公式（不产生费用、不落状态）
    const probeData = PROBE_SALT + CREATION_CODE.slice(2);
    const expectedProbe = ethers.getCreate2Address(factory, PROBE_SALT, ethers.keccak256(CREATION_CODE));
    let staticResult = null;
    try {
        staticResult = await provider.call({ to: factory, data: probeData, from: wallet ? wallet.address : ethers.ZeroAddress });
    } catch (e) {
        fail(`静态模拟调用失败，代理未通过自检 A：${e.shortMessage || e.message}`);
    }

    if (staticResult && staticResult !== "0x") {
        returndataMatches(staticResult, expectedProbe)
            ? ok(`自检 A 通过：静态模拟 CREATE2 返回的地址与公式计算值一致（${expectedProbe}）`)
            : fail(`自检 A 失败：代理返回 ${staticResult}，期望 ${expectedProbe} 的前 20 或 32 字节`);
    } else {
        warn("自检 A 跳过：静态调用未返回数据（部分代理实现如此），将以自检 B 为准");
    }

    if (skipProbe) {
        warn("已按 --skip-probe 跳过自检 B（真实部署探针）");
        return;
    }
    if (!wallet) {
        warn("未提供私钥，跳过自检 B（真实部署探针）");
        return;
    }

    // 自检 B：通过代理真实部署一份探针合约（即代理自身的副本），确认状态写入与 CREATE2 语义都正常
    const balance = await provider.getBalance(wallet.address);
    const feeData = await provider.getFeeData();
    const probeLimit = 200000n;
    const probeCost = probeLimit * (feeData.gasPrice || 1n);
    if (balance < probeCost) {
        warn(`余额不足以执行自检 B（需要约 ${ethers.formatEther(probeCost)}，当前 ${ethers.formatEther(balance)}），已跳过`);
        return;
    }

    let probeTxHash;
    try {
        const tx = await wallet.sendTransaction({ to: factory, data: probeData, gasLimit: probeLimit });
        probeTxHash = tx.hash;
        const receipt = await tx.wait(1);
        if (!receipt || receipt.status !== 1) fail(`自检 B 失败：探针交易 ${tx.hash} 回滚`);
    } catch (e) {
        fail(`自检 B 失败：通过代理部署探针合约出错：${e.shortMessage || e.message}`);
    }

    const probeCode = await provider.getCode(expectedProbe);
    if (probeCode.toLowerCase() !== RUNTIME_CODE.toLowerCase()) {
        fail(`自检 B 失败：探针地址 ${expectedProbe} 上的代码不符合预期（${probeCode}）`);
    }
    ok(`自检 B 通过：通过代理真实部署成功，落点 ${expectedProbe}（tx ${probeTxHash}，链上留下一个无害的探针合约）`);
}

function returndataMatches(returndata, expected) {
    const data = returndata.replace(/^0x/, "").toLowerCase();
    const addr = expected.replace(/^0x/, "").toLowerCase();
    return data === addr || (data.length === 64 && data.endsWith(addr));
}

function report(result) {
    console.log("\n================ 结果 ================");
    console.log(`模式       : ${result.mode}`);
    console.log(`代理地址   : ${result.factory}`);
    if (result.txHash) console.log(`交易 hash  : ${result.txHash}`);
    console.log(`chainId    : ${result.chainId}`);
    console.log("======================================");
}

main().catch((e) => {
    console.error(`[异常] ${e.shortMessage || e.message}`);
    process.exit(1);
});
