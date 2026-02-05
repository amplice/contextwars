#!/usr/bin/env node
/**
 * Context War — Wallet Status
 * Check USDC balance, ETH for gas, and approval status.
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

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, wallet);

(async () => {
  const [balance, allowance, ethBal] = await Promise.all([
    usdc.balanceOf(wallet.address),
    usdc.allowance(wallet.address, CONTRACT),
    provider.getBalance(wallet.address),
  ]);

  console.log('═══════════════════════════════════');
  console.log('  💰 Context War — Wallet Status');
  console.log('═══════════════════════════════════');
  console.log();
  console.log(`  Address:  ${wallet.address}`);
  console.log(`  USDC:     $${ethers.formatUnits(balance, 6)}`);
  console.log(`  ETH:      ${ethers.formatEther(ethBal)} (for gas)`);
  console.log(`  Approved: ${allowance > 0n ? '✅ ' + ethers.formatUnits(allowance, 6) + ' USDC' : '❌ Not approved'}`);
  console.log();

  if (allowance === 0n) {
    console.log('  Run with --approve to set USDC approval:');
    console.log('  node wallet.js --approve');
  }

  // Handle --approve flag
  if (process.argv.includes('--approve')) {
    console.log('  Approving max USDC for Context War contract...');
    const tx = await usdc.approve(CONTRACT, ethers.MaxUint256);
    await tx.wait();
    console.log('  ✅ Approved!');
  }
})().catch(e => {
  console.error('Error:', e.shortMessage || e.message);
  process.exit(1);
});
