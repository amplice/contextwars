#!/usr/bin/env node
/**
 * Context War — Place a Bid
 * Bid on a word slot with USDC. Handles approval if needed.
 * 
 * Usage: node bid.js --slot 3 --word "equally" --amount 0.50
 */
const { ethers } = require('ethers');

const RPC = process.env.CONTEXT_WAR_RPC || process.env.BASE_RPC_URL || 'https://base-mainnet.public.blastapi.io';
const CONTRACT = process.env.CONTEXT_WAR_CONTRACT || '0x65688010c11Cbad24C83451407aFEa44eF71687e';
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRIVATE_KEY = process.env.CONTEXT_WAR_KEY || process.env.DEPLOYER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: Set CONTEXT_WAR_KEY or DEPLOYER_PRIVATE_KEY');
  process.exit(1);
}

const CONTRACT_ABI = [
  'function bid(uint256, string, uint256)',
  'function getSlot(uint256) view returns (string word, address owner, uint256 highestTotal)',
  'function getRoundInfo() view returns (uint256 id, uint256 startTime, uint256 endTime, uint256 prizePool, bool resolved, bool active)',
];

const USDC_ABI = [
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  args[key] = process.argv[i + 1];
}

if (args.slot === undefined || !args.word || !args.amount) {
  console.log('Usage: node bid.js --slot <0-11> --word <text> --amount <USDC>');
  console.log('Example: node bid.js --slot 3 --word "equally" --amount 0.50');
  process.exit(1);
}

const slotIndex = parseInt(args.slot);
const word = args.word;
const amount = args.amount;

if (slotIndex < 0 || slotIndex > 11) {
  console.error('Error: slot must be 0-11');
  process.exit(1);
}
if (word.length > 32) {
  console.error('Error: word max 32 chars');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT, CONTRACT_ABI, wallet);
const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, wallet);

(async () => {
  const amountParsed = ethers.parseUnits(amount, 6);

  // Check round is active
  const info = await contract.getRoundInfo();
  if (!info.active) {
    console.error('No active round. Start one first.');
    process.exit(1);
  }

  // Check current slot state
  const currentSlot = await contract.getSlot(slotIndex);
  const currentWord = currentSlot.word || '(empty)';
  const currentBid = ethers.formatUnits(currentSlot.highestTotal, 6);
  console.log(`Current slot ${slotIndex}: "${currentWord}" — $${currentBid} bid`);

  // Check USDC balance
  const balance = await usdc.balanceOf(wallet.address);
  if (balance < amountParsed) {
    console.error(`Insufficient USDC. Have: $${ethers.formatUnits(balance, 6)}, need: $${amount}`);
    process.exit(1);
  }

  // Check and set approval if needed
  const allowance = await usdc.allowance(wallet.address, CONTRACT);
  if (allowance < amountParsed) {
    console.log('Approving USDC spend...');
    const approveTx = await usdc.approve(CONTRACT, ethers.MaxUint256);
    await approveTx.wait();
    console.log('✓ Approved');
  }

  // Place bid
  console.log(`\nBidding slot ${slotIndex}: "${word}" for $${amount} USDC...`);
  const tx = await contract.bid(slotIndex, word, amountParsed);
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✓ Confirmed (gas: ${receipt.gasUsed})`);

  // Show result
  const newSlot = await contract.getSlot(slotIndex);
  console.log(`\nSlot ${slotIndex}: "${newSlot.word}" — owner: ${newSlot.owner.slice(0, 10)}... — bid: $${ethers.formatUnits(newSlot.highestTotal, 6)}`);
})().catch(e => {
  console.error('Error:', e.shortMessage || e.message);
  process.exit(1);
});
