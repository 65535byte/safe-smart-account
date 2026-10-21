import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig, HttpNetworkUserConfig } from "hardhat/types";
import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-verify";
import "@matterlabs/hardhat-zksync-ethers";
import "@matterlabs/hardhat-zksync-node";
import "hardhat-deploy";
import dotenv from "dotenv";
import yargs from "yargs";
import { getSingletonFactoryInfo } from "@safe-global/safe-singleton-factory";

const argv = yargs
    .option("network", {
        type: "string",
        default: "hardhat",
    })
    .help(false)
    .version(false)
    .parseSync();

// Load environment variables.
dotenv.config();
const {
    NODE_URL,
    INFURA_KEY,
    MNEMONIC,
    ETHERSCAN_API_KEY,
    PK,
    SOLIDITY_VERSION,
    SOLIDITY_SETTINGS,
    HARDHAT_ENABLE_ZKSYNC = "0",
    HARDHAT_CHAIN_ID = 31337,
} = process.env;

const DEFAULT_MNEMONIC = "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat";

const sharedNetworkConfig: HttpNetworkUserConfig = {};
if (PK) {
    sharedNetworkConfig.accounts = [PK];
} else {
    sharedNetworkConfig.accounts = {
        mnemonic: MNEMONIC || DEFAULT_MNEMONIC,
    };
}

if (["mainnet", "rinkeby", "kovan", "goerli", "ropsten", "mumbai", "polygon"].includes(argv.network) && INFURA_KEY === undefined) {
    throw new Error(`Could not find Infura key in env, unable to connect to network ${argv.network}`);
}

import "./src/tasks/local_verify";
import "./src/tasks/deploy_contracts";
import "./src/tasks/show_codesize";
import "./src/tasks/predict_create2";
import { BigNumber } from "@ethersproject/bignumber";
import { DeterministicDeploymentInfo } from "hardhat-deploy/dist/types";

const defaultSolidityVersion = "0.7.6";
const primarySolidityVersion = SOLIDITY_VERSION || defaultSolidityVersion;
const soliditySettings = SOLIDITY_SETTINGS ? JSON.parse(SOLIDITY_SETTINGS) : undefined;

/**
 * Pre-signed deployment transaction of the Arachnid CREATE2 proxy. Only used when going through the built-in
 * fallback of hardhat-deploy (see below); it is irrelevant if the factory already exists on chain.
 */
const ARACHNID_RAW_TX =
    "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222";

/**
 * Optional CREATE2 factory owned by you, see `docs/plan-custom-chain-8379.md`.
 * Deploy it with `npm run create2-factory`.
 * Once set, it takes precedence over everything else on every network; leave it unset to restore the original behaviour.
 */
const CREATE2_FACTORY = (process.env.CREATE2_FACTORY || "").replace(/^"|"$/g, "") || undefined;
/** Fall back to the Arachnid CREATE2 proxy built into hardhat-deploy for unsupported chain ids. */
const ALLOW_ARACHNID_FACTORY = process.env.ALLOW_ARACHNID_FACTORY === "1";

const deterministicDeployment = (network: string): DeterministicDeploymentInfo | undefined => {
    // If CREATE2_FACTORY is set it always wins (on every network), so that the deployed addresses
    // stay identical across chains. Unset it to fall back to the original behaviour below.
    if (CREATE2_FACTORY) {
        // hardhat-deploy skips its bootstrap step as soon as the factory has code on chain,
        // therefore `deployer`/`funding`/`signedTx` are never used here.
        return {
            factory: CREATE2_FACTORY,
            deployer: CREATE2_FACTORY,
            funding: "0",
            signedTx: ARACHNID_RAW_TX,
        };
    }

    const info = getSingletonFactoryInfo(parseInt(network));
    if (info) {
        return {
            factory: info.address,
            deployer: info.signerAddress,
            funding: BigNumber.from(info.gasLimit).mul(BigNumber.from(info.gasPrice)).toString(),
            signedTx: info.transaction,
        };
    }

    if (ALLOW_ARACHNID_FACTORY) {
        console.warn(`Safe factory not found for network ${network}, falling back to the built-in Arachnid CREATE2 factory.`);
        return undefined;
    }

    throw new Error(`
        Safe factory not found for network ${network}. You can request a new deployment at https://github.com/safe-global/safe-singleton-factory.
        Alternatively set CREATE2_FACTORY to your own CREATE2 proxy (see "npx hardhat deploy-create2-factory")
        or set ALLOW_ARACHNID_FACTORY=1 to use the Arachnid proxy built into hardhat-deploy.
        For more information, see https://github.com/safe-global/safe-smart-account#replay-protection-eip-155
      `);
};

const userConfig: HardhatUserConfig = {
    paths: {
        artifacts: "build/artifacts",
        cache: "build/cache",
        deploy: "src/deploy",
        sources: "contracts",
    },
    typechain: {
        outDir: "typechain-types",
        target: "ethers-v6",
    },
    solidity: {
        compilers: [{ version: primarySolidityVersion, settings: soliditySettings }, { version: defaultSolidityVersion }],
    },
    zksolc: {
        version: "1.5.4",
        settings: {
            suppressedWarnings: ["sendtransfer"],
        },
    },
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
            blockGasLimit: 100000000,
            gas: 100000000,
            zksync: HARDHAT_ENABLE_ZKSYNC === "1",
            chainId: typeof HARDHAT_CHAIN_ID === "string" && !Number.isNaN(parseInt(HARDHAT_CHAIN_ID)) ? parseInt(HARDHAT_CHAIN_ID) : 31337,
        },
        mainnet: {
            ...sharedNetworkConfig,
            url: `https://mainnet.infura.io/v3/${INFURA_KEY}`,
        },
        gnosis: {
            ...sharedNetworkConfig,
            url: "https://rpc.gnosischain.com",
        },
        goerli: {
            ...sharedNetworkConfig,
            url: `https://goerli.infura.io/v3/${INFURA_KEY}`,
        },
        mumbai: {
            ...sharedNetworkConfig,
            url: `https://polygon-mumbai.infura.io/v3/${INFURA_KEY}`,
        },
        polygon: {
            ...sharedNetworkConfig,
            url: `https://polygon-mainnet.infura.io/v3/${INFURA_KEY}`,
        },
        bsc: {
            ...sharedNetworkConfig,
            url: `https://bsc-dataseed.binance.org/`,
        },
        arbitrum: {
            ...sharedNetworkConfig,
            url: `https://arb1.arbitrum.io/rpc`,
        },
        fantomTestnet: {
            ...sharedNetworkConfig,
            url: `https://rpc.testnet.fantom.network/`,
        },
        avalanche: {
            ...sharedNetworkConfig,
            url: `https://api.avax.network/ext/bc/C/rpc`,
        },
        zkSyncMainnet: {
            ...sharedNetworkConfig,
            url: "https://mainnet.era.zksync.io",
            ethNetwork: "mainnet",
            zksync: true,
            verifyURL: "https://zksync2-mainnet-explorer.zksync.io/contract_verification",
        },
        zkSyncSepolia: {
            ...sharedNetworkConfig,
            url: "https://sepolia.era.zksync.dev",
            ethNetwork: "goerli",
            zksync: true,
            verifyURL: "https://explorer.sepolia.era.zksync.dev/contract_verification",
        },
    },
    deterministicDeployment,
    namedAccounts: {
        deployer: 0,
    },
    mocha: {
        timeout: 2000000,
    },
    etherscan: {
        apiKey: ETHERSCAN_API_KEY,
    },
};
if (NODE_URL) {
    userConfig.networks!.custom = {
        ...sharedNetworkConfig,
        url: NODE_URL,
    };
}
export default userConfig;
