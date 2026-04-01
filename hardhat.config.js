require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  networks: {
    // Base Mainnet
    base: {
      url:      process.env.RPC_URL_BASE || "https://mainnet.base.org",
      chainId:  8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },

    // Base Sepolia (testnet)
    baseSepolia: {
      url:      "https://sepolia.base.org",
      chainId:  84532,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },

    // Local fork of Base for testing
    hardhat: {
      forking: {
        url:         process.env.RPC_URL_BASE || "https://mainnet.base.org",
        blockNumber: undefined, // pin to a block for reproducibility
      },
      chainId: 8453,
    },
  },

  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network:   "base",
        chainId:   8453,
        urls: {
          apiURL:     "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
};
