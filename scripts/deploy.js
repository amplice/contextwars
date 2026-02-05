const hre = require("hardhat");

async function main() {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
  const [deployer] = await hre.ethers.getSigners();
  
  const oracle = deployer.address;    // deployer = oracle for now
  const minBid = 250000;              // 0.25 USDC
  const roundDuration = 3600;         // 1 hour
  const rakeBps = 0;                  // 0% rake (adjustable later)

  console.log("Deploying Context War v3...");
  console.log("  Deployer:", deployer.address);
  console.log("  Oracle:", oracle);
  console.log("  Min bid:", minBid, "(0.25 USDC)");
  console.log("  Duration:", roundDuration, "seconds");
  console.log("  Rake:", rakeBps, "bps");

  const ContextWar = await hre.ethers.getContractFactory("ContextWar");
  const contract = await ContextWar.deploy(USDC, oracle, minBid, roundDuration, rakeBps);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("\n✅ Context War v3 deployed to:", addr);
  console.log("\nVerify:");
  console.log(`npx hardhat verify --network base ${addr} ${USDC} ${oracle} ${minBid} ${roundDuration} ${rakeBps}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
