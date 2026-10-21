import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CREATE2_SALT } from "../utils/deploy";

/** Contracts deployed by the `l2-suite` tag (see `docs/deployment.md`). All of them have no constructor arguments. */
const L2_SUITE = [
    "SafeL2",
    "SafeProxyFactory",
    "TokenCallbackHandler",
    "CompatibilityFallbackHandler",
    "MultiSend",
    "MultiSendCallOnly",
    "CreateCall",
    "SignMessageLib",
    "SafeToL2Setup",
    "SimulateTxAccessor",
];

/**
 * Prints the deterministic CREATE2 addresses of all `l2-suite` contracts WITHOUT deploying them.
 * The output must match the addresses produced by `hardhat deploy --tags l2-suite`, which makes it a useful
 * dry-run check before spending funds on a live chain.
 */
task("predict-create2", "Predicts the deterministic addresses of the l2-suite contracts")
    .addOptionalParam("tags", "Comma separated list of contract names to predict (defaults to l2-suite)", undefined, undefined)
    .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
        const { deployments, getNamedAccounts } = hre;
        const { deployer } = await getNamedAccounts();
        const names: string[] = args.tags ? String(args.tags).split(",") : L2_SUITE;
        const salt = CREATE2_SALT === true ? undefined : CREATE2_SALT;

        console.log(`network: ${hre.network.name}  deployer: ${deployer}  salt: ${CREATE2_SALT === true ? "0x00..00" : CREATE2_SALT}`);
        for (const name of names) {
            const { address } = await deployments.deterministic(name, { from: deployer, args: [], salt, log: false });
            const code = await hre.ethers.provider.getCode(address);
            console.log(`${name.padEnd(30)} ${address} ${code === "0x" ? "(not deployed)" : "(already deployed)"}`);
        }
    });

export {};
