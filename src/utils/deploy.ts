import { arrayify, toUtf8Bytes, zeroPadValue } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * CREATE2 salt used for deterministic deployments.
 * - Default (`true`): salt = 0, i.e. the official Safe deployment addresses (unchanged behavior).
 * - Set the `CUSTOM_SALT` env var (a readable string or a `0x`-prefixed hex, max 32 bytes) to
 *   deploy the exact same bytecode at different, reproducible addresses.
 */
const customSalt = process.env.CUSTOM_SALT;
const customSaltBytes = customSalt ? (customSalt.startsWith("0x") ? arrayify(customSalt) : toUtf8Bytes(customSalt)) : undefined;
if (customSaltBytes && customSaltBytes.length > 32) {
    throw new Error(`CUSTOM_SALT must be at most 32 bytes, got ${customSaltBytes.length}`);
}
export const CREATE2_SALT: true | string = customSaltBytes ? zeroPadValue(customSaltBytes, 32) : true;

/**
 * Retrieves the deployer account based on the current network environment.
 *
 * @param hre - The Hardhat Runtime Environment.
 * @returns The deployer account address or private key.
 */
export const getDeployerAccount = async (hre: HardhatRuntimeEnvironment) => {
    let { deployer: deployerAccount } = await hre.getNamedAccounts();

    // hardhat-deploy only supports zksync (or zksync only supports hardhat-deploy) if the private key of the deployer is provided
    // it cannot fetch the private key from hardhat's environment
    if (hre.network.zksync) {
        if (process.env.ZKSYNC_DEPLOYER_PK) {
            deployerAccount = process.env.ZKSYNC_DEPLOYER_PK;
        } else {
            console.warn("Using default ZkSync deployer private key");
            deployerAccount = "0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110";
        }
    }

    return deployerAccount;
};
