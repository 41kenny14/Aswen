/**
 * scripts/deploy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys FlashLoanArbitrage to Base mainnet (or fork).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network base
 *   npx hardhat run scripts/deploy.js --network baseSepolia
 */

const { ethers } = require("hardhat");

// ─── Aave V3 PoolAddressesProvider ───────────────────────────────────────────
// Base Mainnet: https://docs.aave.com/developers/deployed-contracts/v3-mainnet/base

const AAVE_ADDRESSES_PROVIDER = {
  base:        "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  baseSepolia: "0xd449FeD49d9C443688d6816fE6872F21402e41de",
};

async function main() {
  const network = hre.network.name;
  const provider = AAVE_ADDRESSES_PROVIDER[network];

  if (!provider) {
    throw new Error(`No Aave addresses provider configured for network: ${network}`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`\n🚀 Deploying FlashLoanArbitrage`);
  console.log(`   Network  : ${network}`);
  console.log(`   Deployer : ${deployer.address}`);
  console.log(`   Aave AP  : ${provider}`);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`   Balance  : ${ethers.formatEther(balance)} ETH\n`);

  // ── Deploy ────────────────────────────────────────────────────────────────

  const Factory = await ethers.getContractFactory("FlashLoanArbitrage");
  const contract = await Factory.deploy(provider, {
    gasLimit: 2_000_000,
  });

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`✅ FlashLoanArbitrage deployed!`);
  console.log(`   Address  : ${address}`);
  console.log(`\n📋 Add to your .env:`);
  console.log(`   CONTRACT_ADDRESS=${address}\n`);

  // ── Verify on Basescan (optional) ─────────────────────────────────────────

  if (network === "base" || network === "baseSepolia") {
    console.log("⏳ Waiting 5 blocks before verification…");
    await contract.deploymentTransaction().wait(5);

    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments: [provider],
      });
      console.log("✅ Contract verified on Basescan");
    } catch (err) {
      console.warn(`⚠️  Verification failed: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
