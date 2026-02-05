const hre = require("hardhat");

async function main() {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const [deployer] = await hre.ethers.getSigners();
  
  console.log("Deploying ContextWarV4...");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  const CW = await hre.ethers.getContractFactory("ContextWarV4");
  const war = await CW.deploy(
    USDC,                    // _usdc
    deployer.address,        // _oracle (deployer = oracle for now)
    250_000,                 // _minBid (0.25 USDC)
    3600,                    // _roundDuration (1 hour)
    0,                       // _rakeBps (0% rake)
    5000                     // _splitBps (50/50)
  );

  await war.waitForDeployment();
  const addr = await war.getAddress();
  
  console.log("\n✅ ContextWarV4 deployed to:", addr);
  console.log("\nConfig:");
  console.log("  USDC:", USDC);
  console.log("  Oracle:", deployer.address);
  console.log("  Min Bid: 0.25 USDC");
  console.log("  Round Duration: 1 hour");
  console.log("  Rake: 0%");
  console.log("  Split: 50/50 (current/next)");
  console.log("  Max Slots/Player: 6");
  console.log("\nNext: Update .env, server.js, oracle-bot.js, frontend with new address");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
