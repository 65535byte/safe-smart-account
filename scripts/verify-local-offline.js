/**
 * Offline replacement for `npx hardhat local-verify`.
 *
 * The built-in task downloads solc from solc-bin.ethereum.org, which is unreachable in this environment.
 * This script instead reuses the solc binary cached by hardhat and reproduces the exact same check:
 *   1. take the standard-json input stored in `deployments/<network>/<Name>.json` (`metadata` field)
 *   2. recompile it with the native solc binary
 *   3. compare `keccak256(onChainCode)` with `keccak256(localDeployedBytecode)`,
 *      zeroing out immutable references first (exactly like `src/tasks/local_verify.ts`)
 *
 * Usage: node verify_local_offline.js [network]
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const SOLC = process.env.SOLC_PATH || "/root/.cache/hardhat-nodejs/compilers-v2/linux-amd64/solc-linux-amd64-v0.7.6+commit.7338295f";

function compileWithLocalSolc(metadata) {
    const output = execFileSync(SOLC, ["--standard-json"], { input: JSON.stringify(metadata), maxBuffer: 1024 * 1024 * 256 });
    return JSON.parse(output.toString());
}

async function main() {
    const network = process.argv[2] || "custom";
    const provider = new ethers.JsonRpcProvider(String(process.env.NODE_URL).replace(/^"|"$/g, ""));
    const dir = path.join("deployments", network);
    if (!fs.existsSync(dir)) throw new Error(`No deployments found in ${dir}`);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    let failures = 0;

    for (const file of files) {
        const deployment = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        const meta = JSON.parse(deployment.metadata);
        const allowedSourceKey = ["keccak256", "content"];

        delete meta.compiler;
        delete meta.output;
        delete meta.version;
        for (const source of Object.values(meta.sources)) {
            for (const key of Object.keys(source)) {
                if (!allowedSourceKey.includes(key)) delete source[key];
            }
        }

        const targets = Object.entries(meta.settings.compilationTarget);
        meta.settings.outputSelection = {};
        for (const [key, value] of targets) {
            meta.settings.outputSelection[key] = {};
            meta.settings.outputSelection[key][value] = ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"];
        }
        delete meta.settings.compilationTarget;

        const compiled = compileWithLocalSolc(meta);
        if (compiled.errors && compiled.errors.some((e) => e.severity === "error")) {
            console.log(`FAIL  ${file}: compilation failed`);
            failures++;
            continue;
        }

        let ok = true;
        for (const [key, value] of targets) {
            const contract = compiled.contracts[key][value];
            const localBytecode = contract.evm.deployedBytecode.object.replace(/^0x/, "");
            const onChain = ethers.getBytes(await provider.getCode(deployment.address));
            for (const references of Object.values(contract.evm.deployedBytecode.immutableReferences || {})) {
                for (const ref of references) onChain.fill(0, ref.start, ref.start + ref.length);
            }
            if (ethers.keccak256(onChain) !== ethers.keccak256(ethers.getBytes("0x" + localBytecode))) {
                ok = false;
            }
        }

        console.log(`${ok ? "OK  " : "FAIL"}  ${deployment.address}  ${file}`);
        if (!ok) failures++;
    }

    console.log(failures === 0 ? "\nAll deployments verified against local sources." : `\n${failures} deployment(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
