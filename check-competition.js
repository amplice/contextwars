const { ethers } = require('ethers');
const fs = require('fs');

// Context War v4 Contract
const CONTRACT_ADDRESS = '0xB6d292664d3073dca1475d2dd2679eD839C288c0';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC

const ABI = [
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (tuple(uint256 id, uint256 prizePool, uint256 nextPrizePool, uint256 endTime, bool resolved, uint256 slotCount))",
  "function placeBid(string memory word, uint256 amount) external",
  "function fund(uint256 amount) external",
  "function getRoundSlots(uint256 roundId) view returns (tuple(address player, string word, uint256 bidAmount)[])",
  "function MIN_BID() view returns (uint256)"
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) external",
  "function decimals() view returns (uint8)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  
  // Main wallet (from credentials)
  const mainWallet = new ethers.Wallet('0x65b84bcb48196c95e2308e8d5413764b536ce4e4b1febece211aac16657e6a5f', provider);
  
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, mainWallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, mainWallet);
  
  const roundId = await contract.currentRoundId();
  const round = await contract.rounds(roundId);
  const slots = await contract.getRoundSlots(roundId);
  const minBid = await contract.MIN_BID();
  const usdcBalance = await usdc.balanceOf(mainWallet.address);
  const decimals = await usdc.decimals();
  
  console.log('=== Context War Status ===');
  console.log('Current Round:', roundId.toString());
  console.log('Prize Pool:', ethers.formatUnits(round.prizePool, decimals), 'USDC');
  console.log('Next Prize Pool:', ethers.formatUnits(round.nextPrizePool, decimals), 'USDC');
  console.log('End Time:', new Date(Number(round.endTime) * 1000).toISOString());
  console.log('Resolved:', round.resolved);
  console.log('Slot Count:', round.slotCount.toString());
  console.log('Min Bid:', ethers.formatUnits(minBid, decimals), 'USDC');
  console.log('');
  console.log('=== Wallet Status ===');
  console.log('Main Wallet:', mainWallet.address);
  console.log('USDC Balance:', ethers.formatUnits(usdcBalance, decimals), 'USDC');
  console.log('');
  console.log('=== Current Slots ===');
  for (let i = 0; i < slots.length; i++) {
    console.log(`Slot ${i}: ${slots[i].player} - "${slots[i].word}" (${ethers.formatUnits(slots[i].bidAmount, decimals)} USDC)`);
  }
}

main().catch(console.error);
